#!/usr/bin/env bash
# Refuse a change to shipped plugin files unless the plugin version was bumped.
#
# A shipped path is a file that an installed copy of the plugin loads or runs,
# so a change to it must roll out to every machine. The Claude Code plugin
# cache only re-pulls a plugin when .claude-plugin/plugin.json's version
# changes, so a merge that leaves the version alone is invisible to every
# installed copy. This gate makes that failure loud at pull request time.
#
# Usage:  scripts/version-gate.sh <base-ref> <head-ref>
# Env:    NO_BUMP=1  the pull request carries the `no-bump` label.
#
# Exit 0 when nothing shipped changed, when the version was bumped, or when
# the no-bump label covers an unbumped shipped change. Exit 1 otherwise.

set -euo pipefail

# Inert paths: files an installed copy never loads or runs, so changing them
# needs no version bump. Everything not listed here is shipped. KEEP IN SYNC
# with the inert-path list in CONTRIBUTING.md, which documents this array for
# contributors.
INERT_PATHS=(
  "README.md"
  "CONTRIBUTING.md"
  "CONTEXT.md"
  "LICENSE"
  "THIRD_PARTY_NOTICES"
  "docs/adr/**"
  "docs/migrate-0.8.md"
  "tests/**"
  ".github/**"
  ".claude/**"
  "spechub/**"
)

MANIFEST=".claude-plugin/plugin.json"

usage() {
  echo "usage: $(basename "$0") <base-ref> <head-ref>" >&2
}

die() {
  echo "version-gate: $*" >&2
  exit 1
}

# True when path $1 matches one of INERT_PATHS.
is_inert() {
  local path="$1" pattern
  for pattern in "${INERT_PATHS[@]}"; do
    # shellcheck disable=SC2053  # pattern is a glob on purpose
    if [[ "$path" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

# Print the `version` field of the manifest as it stands at ref $1. Prints
# nothing when the file or the field is absent.
read_version() {
  local ref="$1" json
  json="$(git show "${ref}:${MANIFEST}" 2>/dev/null)" || return 0
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r '.version // empty' 2>/dev/null || true
  else
    # Only the manifest's top-level `version` key counts. A nested "version"
    # sitting earlier in the file – inside a dependency or component block –
    # would otherwise win the first whole-file match and report the wrong
    # number. A top-level key is the one at two-space indentation, so anchor
    # on that and take the first line that qualifies.
    printf '%s' "$json" |
      grep -m1 '^  "version"' |
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ||
      true
  fi
}

# True when $1 looks like MAJOR.MINOR.PATCH.
is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]
}

# Compare two semver strings numerically. Prints -1, 0 or 1 for
# $1 < $2, $1 == $2, $1 > $2. Pre-release and build suffixes are ignored.
semver_cmp() {
  local a="$1" b="$2"
  local a1 a2 a3 b1 b2 b3 i
  IFS='.' read -r a1 a2 a3 <<<"$a"
  IFS='.' read -r b1 b2 b3 <<<"$b"
  a3="${a3%%[-+]*}"
  b3="${b3%%[-+]*}"
  local -a left=("${a1:-0}" "${a2:-0}" "${a3:-0}")
  local -a right=("${b1:-0}" "${b2:-0}" "${b3:-0}")
  for i in 0 1 2; do
    if (( 10#${left[i]} < 10#${right[i]} )); then echo "-1"; return 0; fi
    if (( 10#${left[i]} > 10#${right[i]} )); then echo "1";  return 0; fi
  done
  echo "0"
}

# Print MAJOR.MINOR.PATCH of $1 bumped at level $2 (patch, minor or major).
next_version() {
  local v="$1" level="$2" p1 p2 p3
  IFS='.' read -r p1 p2 p3 <<<"$v"
  p3="${p3%%[-+]*}"
  case "$level" in
    patch) echo "${p1}.${p2}.$((10#${p3:-0} + 1))" ;;
    minor) echo "${p1}.$((10#${p2:-0} + 1)).0" ;;
    major) echo "$((10#${p1:-0} + 1)).0.0" ;;
  esac
}

if [ "$#" -ne 2 ]; then
  usage
  exit 1
fi

BASE_REF="$1"
HEAD_REF="$2"
NO_BUMP="${NO_BUMP:-}"

# --no-renames keeps a rename listed as both the removed source path and the
# added destination. Without it git collapses the pair to the destination
# alone, so a shipped file moved into an inert path reads as no shipped change.
changed="$(git diff --no-renames --name-only "${BASE_REF}...${HEAD_REF}")" ||
  die "could not diff ${BASE_REF}...${HEAD_REF}"

shipped=()
while IFS= read -r file; do
  [ -n "$file" ] || continue
  if ! is_inert "$file"; then
    shipped+=("$file")
  fi
done <<<"$changed"

if [ "${#shipped[@]}" -eq 0 ]; then
  echo "version-gate: no shipped files changed, so no version bump is needed."
  exit 0
fi

base_version="$(read_version "$BASE_REF")"
head_version="$(read_version "$HEAD_REF")"

if [ -z "$base_version" ] || ! is_semver "$base_version"; then
  die "could not read a MAJOR.MINOR.PATCH version from ${MANIFEST} at ${BASE_REF}."
fi
if [ -z "$head_version" ] || ! is_semver "$head_version"; then
  die "could not read a MAJOR.MINOR.PATCH version from ${MANIFEST} at ${HEAD_REF}.
Shipped files changed, so ${MANIFEST} must carry a version above ${base_version}."
fi

cmp="$(semver_cmp "$head_version" "$base_version")"

if [ "$cmp" = "-1" ]; then
  {
    echo "version-gate: the version went backwards."
    echo ""
    echo "  ${HEAD_REF}: ${head_version} is lower than ${BASE_REF}: ${base_version}"
    echo ""
    echo "An installed copy never downgrades, so a lower version strands every"
    echo "machine on the older release. Set ${MANIFEST} above ${base_version}."
    echo "The no-bump label does not cover a downgrade."
  } >&2
  exit 1
fi

if [ "$cmp" = "1" ]; then
  echo "version-gate: version bumped ${base_version} -> ${head_version}, ${#shipped[@]} shipped file(s) changed."
  exit 0
fi

if [ "$NO_BUMP" = "1" ]; then
  echo "version-gate: shipped files changed at version ${head_version} without a bump, allowed by the no-bump label."
  exit 0
fi

{
  echo "version-gate: shipped files changed without a version bump."
  echo ""
  echo "Shipped files in this change:"
  printf '  %s\n' "${shipped[@]}"
  echo ""
  echo "Version: ${base_version} (${BASE_REF}) -> ${head_version} (${HEAD_REF})"
  echo ""
  echo "A shipped path is a file an installed copy of the plugin loads or runs."
  echo "The Claude Code plugin cache only re-pulls when the version changes, so"
  echo "these changes would never reach an installed copy."
  echo ""
  echo "To fix this, bump ${MANIFEST} to one of:"
  echo ""
  echo "  patch  $(next_version "$base_version" patch)  a fix"
  echo "  minor  $(next_version "$base_version" minor)  a feature"
  echo "  major  $(next_version "$base_version" major)  a breaking change"
  echo ""
  echo "The author picks the level. If these changes genuinely should not roll"
  echo "out to installed copies, add the no-bump label to the pull request and"
  echo "this gate will pass instead."
} >&2
exit 1
