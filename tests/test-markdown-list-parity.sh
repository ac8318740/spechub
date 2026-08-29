#!/usr/bin/env bash
# Guards every Markdown file in the repository against the two ways plain
# lists render differently under the two renderers this project depends on:
#
#   - CommonMark, which is what GitHub uses to render these files
#   - Python-Markdown with fenced_code, tables, toc, sane_lists, which is what
#     this repo's own previewer uses (assets/terminal-workspace/setup.sh:849)
#
# When the two disagree, a reader of the local preview silently loses list
# items that a reader on GitHub sees. Two properties keep them agreeing, both
# stated in the repo itself:
#
#   1. A nested list marker's indent is always a multiple of four spaces
#      (output-styles/ac-writing-style.md:137, skills/visual-docs/SKILL.md:154)
#   2. A top-level list never opens on the line directly after a paragraph
#      line with no blank line between them - sane_lists will not let a list
#      interrupt a paragraph, so it swallows the list into it
#
# Both are plain text properties, checked with awk over every tracked .md
# file (node_modules excluded). A line inside a fenced code block never
# counts toward either property.
#
# Run it:  bash tests/test-markdown-list-parity.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
P1="$WORK/property1-violations"
P2="$WORK/property2-violations"
: > "$P1"
: > "$P2"

# Every tracked-shape .md file under $ROOT, node_modules excluded.
MD_FILES=()
while IFS= read -r f; do
  MD_FILES+=("$f")
done < <(find "$ROOT" -name node_modules -prune -o -type f -name '*.md' -print | sort)

echo "Scanning ${#MD_FILES[@]} Markdown files under $ROOT"
echo ""

# Walks every file, tracking fenced-code state and the type of the current
# block of contiguous non-blank lines: "list" (opened by a list marker line,
# at any indent), "other" (opened by a blockquote, table row, or heading) or
# "para" (opened by anything else - plain prose). Property 2 only fires
# inside a "para" block, because a "list" block's own continuation lines are
# not paragraph text - they are wrapped content of the list item that opened
# the block, and both renderers already agree on those. A heading is always
# a one-line block, so it never carries its "other" type into the next line.
# Emits one violation line per hit, each naming FILENAME:FNR so a failure
# points straight at the fix.
if [ "${#MD_FILES[@]}" -gt 0 ]; then
  awk -v p1out="$P1" -v p2out="$P2" '
    function leading_spaces(l) { match(l, /^ */); return RLENGTH }
    FNR == 1 { fence = 0; fmarker = ""; block_open = 0; block_type = "" }
    {
      line = $0
      t = line
      sub(/^[ \t]+/, "", t)
      if (t ~ /^(```|~~~)/) {
        m = substr(t, 1, 3)
        if (fence == 0) { fence = 1; fmarker = m }
        else if (m == fmarker) { fence = 0 }
        block_open = 0
        next
      }
      if (fence == 1) { next }

      if (line ~ /^[ \t]*$/) { block_open = 0; next }

      lead = leading_spaces(line)
      rest = substr(line, lead + 1)
      is_list = (rest ~ /^([-*+]|[0-9]+[.)]) /)
      is_other = (rest ~ /^>/ || rest ~ /^\|/ || rest ~ /^#/)

      if (is_list && lead > 0 && lead % 4 != 0) {
        print FILENAME ":" FNR ": nested list marker indented " lead " spaces, not a multiple of four: " line >> p1out
      }

      if (!block_open) {
        block_open = 1
        block_type = is_list ? "list" : (is_other ? "other" : "para")
      } else if (is_list && lead == 0 && block_type == "para") {
        print FILENAME ":" FNR ": top-level list opens right after a paragraph line with no blank line between them: " line >> p2out
      }

      # An ATX heading is always a single-line block on its own.
      if (rest ~ /^#/) { block_open = 0 }
    }
  ' "${MD_FILES[@]}"
fi

p1_offenders="$(cat "$P1")"
p2_offenders="$(cat "$P2")"

check "no nested list marker is indented by other than a multiple of four spaces" \
  '[ -z "$p1_offenders" ]'
[ -n "$p1_offenders" ] && printf '%s\n' "$p1_offenders" | sed 's/^/    /'

check "no top-level list opens directly after a paragraph line with no blank line between them" \
  '[ -z "$p2_offenders" ]'
[ -n "$p2_offenders" ] && printf '%s\n' "$p2_offenders" | sed 's/^/    /'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
