#!/usr/bin/env bash
# Local test harness for scripts/version-gate.sh.
#
# version-gate.sh is a PR gate: it refuses a change to shipped plugin files
# unless .claude-plugin/plugin.json's version was bumped above the base
# branch's version. This suite builds throwaway git repos per scenario,
# commits a base state on `main`, branches, makes changes, and asserts the
# gate's exit code and messages.
#
# Run it:  bash tests/test-version-gate.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/../scripts/version-gate.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "FATAL: script not found at $SCRIPT" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

OUT="$WORK/.stdout"
ERR="$WORK/.stderr"
OUTALL=""

# Build a base repo at $1 with .claude-plugin/plugin.json version $2 (default
# 0.15.3), committed on `main`. Covers every inert category plus a couple of
# shipped files so scenarios can pick and choose what to touch.
make_base_repo() {
  local dir="$1"
  local ver="${2:-0.15.3}"
  mkdir -p "$dir"
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "Test"
    mkdir -p .claude-plugin docs/adr skills/foo .github/workflows .claude spechub tests
    printf '{\n  "version": "%s"\n}\n' "$ver" > .claude-plugin/plugin.json
    echo "readme"    > README.md
    echo "contrib"   > CONTRIBUTING.md
    echo "context"   > CONTEXT.md
    echo "license"   > LICENSE
    echo "notices"   > THIRD_PARTY_NOTICES
    echo "adr"       > docs/adr/0001-x.md
    echo "migrate"   > docs/migrate-0.8.md
    echo "skill v1"  > skills/foo/SKILL.md
    echo "cli code"  > cli.js
    echo "ci"        > .github/workflows/ci.yml
    echo "settings"  > .claude/settings.json
    echo "spec"      > spechub/specs.md
    echo "test"      > tests/test-x.sh
    git add -A
    git commit -q -m "base"
  )
}

# Create and check out branch $2 in repo $1, off the current HEAD (main).
new_branch() {
  (cd "$1" && git checkout -q -b "$2")
}

# Run the gate in repo $1 as: version-gate.sh $2 $3. Captures stdout/stderr,
# sets OUTALL to the combined text, and returns the exit code via $?.
run_gate() {
  local repo="$1" base="$2" head="$3"
  ( cd "$repo" && "$SCRIPT" "$base" "$head" ) >"$OUT" 2>"$ERR"
  local code=$?
  OUTALL="$(cat "$OUT" "$ERR" 2>/dev/null)"
  return $code
}

# Set version $2 in repo $1's currently checked-out plugin.json.
set_version() {
  local repo="$1" ver="$2"
  printf '{\n  "version": "%s"\n}\n' "$ver" > "$repo/.claude-plugin/plugin.json"
}

echo "Testing: $SCRIPT"
echo "Workdir: $WORK"
echo ""

# --- Case 1: only an inert doc file changed, no bump -> exit 0 ---------------
echo "Case 1: only README.md changed"
REPO="$WORK/case1"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "more docs" >> README.md && git add README.md && git commit -q -m "docs")
run_gate "$REPO" main feature
CODE=$?
check "exits 0"                              '[ "$CODE" -eq 0 ]'
check "reports no shipped files changed"     'printf "%s" "$OUTALL" | grep -qi "no shipped files changed"'

# --- Case 2: only an ADR doc changed, no bump -> exit 0 -----------------------
echo "Case 2: only docs/adr/0001-x.md changed"
REPO="$WORK/case2"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "record" > docs/adr/0002-y.md && git add docs/adr/0002-y.md && git commit -q -m "adr")
run_gate "$REPO" main feature
CODE=$?
check "exits 0"                              '[ "$CODE" -eq 0 ]'
check "reports no shipped files changed"     'printf "%s" "$OUTALL" | grep -qi "no shipped files changed"'

# --- Case 3: shipped file changed, no bump -> exit 1 with guidance -----------
echo "Case 3: skills/foo/SKILL.md changed, no version bump"
REPO="$WORK/case3"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "skill v2" > skills/foo/SKILL.md && git add skills/foo/SKILL.md && git commit -q -m "skill update")
run_gate "$REPO" main feature
CODE=$?
check "exits 1"                              '[ "$CODE" -eq 1 ]'
check "stderr mentions the changed file"     'grep -q "skills/foo/SKILL.md" "$ERR"'
check "stderr tells you to bump the version" 'grep -q "bump .claude-plugin/plugin.json" "$ERR"'
check "stderr mentions the no-bump escape"   'grep -q "no-bump" "$ERR"'

# --- Case 4: shipped file changed, version bumped 0.15.3 -> 0.15.4 -----------
echo "Case 4: skills/foo/SKILL.md changed, version bumped to 0.15.4"
REPO="$WORK/case4"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "skill v2" > skills/foo/SKILL.md && git add skills/foo/SKILL.md && git commit -q -m "skill update")
set_version "$REPO" "0.15.4"
(cd "$REPO" && git add .claude-plugin/plugin.json && git commit -q -m "bump version")
run_gate "$REPO" main feature
CODE=$?
check "exits 0"                              '[ "$CODE" -eq 0 ]'
check "reports version bumped"               'printf "%s" "$OUTALL" | grep -qi "version bumped"'
check "mentions base version"                'printf "%s" "$OUTALL" | grep -q "0.15.3"'
check "mentions head version"                'printf "%s" "$OUTALL" | grep -q "0.15.4"'

# --- Case 5: numeric semver compare, not string compare ----------------------
echo "Case 5: numeric semver comparisons"
for bump in "0.15.3:0.16.0" "0.15.3:1.0.0" "0.15.9:0.15.10"; do
  base_ver="${bump%%:*}"
  head_ver="${bump##*:}"
  REPO="$WORK/case5-${base_ver//./_}-${head_ver//./_}"
  make_base_repo "$REPO" "$base_ver"
  new_branch "$REPO" feature
  (cd "$REPO" && echo "skill v2" > skills/foo/SKILL.md && git add skills/foo/SKILL.md && git commit -q -m "skill update")
  set_version "$REPO" "$head_ver"
  (cd "$REPO" && git add .claude-plugin/plugin.json && git commit -q -m "bump version")
  run_gate "$REPO" main feature
  CODE=$?
  check "exits 0 for ${base_ver} -> ${head_ver}" '[ "$CODE" -eq 0 ]'
  check "reports version bumped for ${base_ver} -> ${head_ver}" 'printf "%s" "$OUTALL" | grep -qi "version bumped"'
done

# --- Case 6: new top-level path is shipped by default (deny-list) ------------
echo "Case 6: new top-level dir newdir/x.txt, no bump"
REPO="$WORK/case6"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && mkdir -p newdir && echo "x" > newdir/x.txt && git add newdir/x.txt && git commit -q -m "new dir")
run_gate "$REPO" main feature
CODE=$?
check "exits 1 (unknown path defaults to shipped)" '[ "$CODE" -eq 1 ]'
check "stderr mentions the new file"         'grep -q "newdir/x.txt" "$ERR"'

# --- Case 7: shipped change, no bump, NO_BUMP=1 escape hatch -----------------
echo "Case 7: shipped change, no bump, NO_BUMP=1"
REPO="$WORK/case7"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "skill v2" > skills/foo/SKILL.md && git add skills/foo/SKILL.md && git commit -q -m "skill update")
NO_BUMP=1 run_gate "$REPO" main feature
CODE=$?
check "exits 0"                              '[ "$CODE" -eq 0 ]'
check "reports no-bump label"                'printf "%s" "$OUTALL" | grep -qi "no-bump label"'

# --- Case 8: shipped change, downgraded version, NO_BUMP=1 still fails -------
echo "Case 8: shipped change, version downgraded 0.15.3 -> 0.15.2, NO_BUMP=1"
REPO="$WORK/case8"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "skill v2" > skills/foo/SKILL.md && git add skills/foo/SKILL.md && git commit -q -m "skill update")
set_version "$REPO" "0.15.2"
(cd "$REPO" && git add .claude-plugin/plugin.json && git commit -q -m "downgrade version")
NO_BUMP=1 run_gate "$REPO" main feature
CODE=$?
check "exits 1 even with NO_BUMP=1"          '[ "$CODE" -eq 1 ]'
check "stderr mentions lower than"           'grep -qi "lower than" "$ERR"'

# --- Case 9: shipped change, head plugin.json version missing -> exit 1 ------
echo "Case 9: shipped change, head plugin.json has no version key"
REPO="$WORK/case9"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "skill v2" > skills/foo/SKILL.md && git add skills/foo/SKILL.md && git commit -q -m "skill update")
(cd "$REPO" && printf '{}\n' > .claude-plugin/plugin.json && git add .claude-plugin/plugin.json && git commit -q -m "strip version")
run_gate "$REPO" main feature
CODE=$?
check "exits 1 on malformed/missing head version" '[ "$CODE" -eq 1 ]'

# --- Case 10: three-dot semantics (base moves forward after branch point) ----
echo "Case 10: a shipped file added only on main after the branch point"
REPO="$WORK/case10"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && echo "more docs" >> README.md && git add README.md && git commit -q -m "docs on feature")
(cd "$REPO" && git checkout -q main && mkdir -p skills/bar && echo "new skill" > skills/bar/SKILL.md && git add skills/bar/SKILL.md && git commit -q -m "shipped file added only on main")
run_gate "$REPO" main feature
CODE=$?
check "exits 0 (three-dot ignores main-only history)" '[ "$CODE" -eq 0 ]'
check "does not flag the main-only file"     '! printf "%s" "$OUTALL" | grep -q "skills/bar/SKILL.md"'
check "reports no shipped files changed"     'printf "%s" "$OUTALL" | grep -qi "no shipped files changed"'

# --- Case 11: shipped file renamed into an inert path, no bump -> exit 1 ----
echo "Case 11: skills/foo/SKILL.md renamed to docs/adr/moved.md (pure rename), no bump"
REPO="$WORK/case11"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && git mv skills/foo/SKILL.md docs/adr/moved.md && git commit -q -m "move skill into adr")
run_gate "$REPO" main feature
CODE=$?
check "exits 1"                                     '[ "$CODE" -eq 1 ]'
check "stderr mentions the removed shipped path"     'grep -q "skills/foo/SKILL.md" "$ERR"'

# --- Case 12: same, but the moved file is also edited (still >50% similar) --
echo "Case 12: skills/foo/SKILL.md renamed to docs/adr/moved2.md and edited, no bump"
REPO="$WORK/case12"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && git mv skills/foo/SKILL.md docs/adr/moved2.md && echo "extra" >> docs/adr/moved2.md && git commit -q -am "move and edit skill into adr")
run_gate "$REPO" main feature
CODE=$?
check "exits 1"                                     '[ "$CODE" -eq 1 ]'
check "stderr mentions the removed shipped path"     'grep -q "skills/foo/SKILL.md" "$ERR"'

# --- Case 13: output-styles/ is shipped, so adding a style needs a bump ------
echo "Case 13: output-styles/ac-writing-style.md added, no version bump"
REPO="$WORK/case13"
make_base_repo "$REPO"
new_branch "$REPO" feature
(cd "$REPO" && mkdir -p output-styles && echo "style" > output-styles/ac-writing-style.md && git add output-styles && git commit -q -m "add output style")
run_gate "$REPO" main feature
CODE=$?
check "exits 1"                                     '[ "$CODE" -eq 1 ]'
check "stderr mentions the output style file"       'grep -q "output-styles/ac-writing-style.md" "$ERR"'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
