#!/usr/bin/env bash
# Local test harness for ac-writing-style-reminder.sh (UserPromptSubmit hook).
#
# The hook re-injects the ac-writing-style output style's own words on every
# turn, because a file-based output style cannot carry a turnReminder field.
# Every rule it states is EXTRACTED from output-styles/ac-writing-style.md at
# run time, so the two can never drift. The first version of this hook stored a
# hand-typed copy and drifted within one release, which is what these checks
# exist to stop happening again.
#
# The checks cover the output-style gate, the two extracted sections, the
# no-drift guarantee, JSON validity and escaping, the missing-file fallbacks,
# and the wiring in hooks.json.
#
# Run it:  bash tests/test-writing-style-reminder.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
HOOK="${ROOT}/hooks/ac-writing-style-reminder.sh"
HOOKS_JSON="${ROOT}/hooks/hooks.json"
STYLE="${ROOT}/output-styles/ac-writing-style.md"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

echo "Testing: $HOOK"
echo "Workdir: $WORK"
echo ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Run the hook against a plugin root, with a chosen active output style.
# $1 the style name written into the fake user settings, $2 the plugin root.
run_hook() {
  local style="$1" root="$2" home="$WORK/home_$RANDOM"
  mkdir -p "$home/.claude"
  printf '{"outputStyle": "%s"}\n' "$style" > "$home/.claude/settings.json"
  ( cd "$WORK" && HOME="$home" CLAUDE_PLUGIN_ROOT="$root" \
      bash "$HOOK" </dev/null 2>"$WORK/stderr" )
}

# Print the additionalContext string the hook emitted, or nothing.
context_of() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("hookSpecificOutput", {}).get("additionalContext", ""))
' 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1. The output-style gate
# ---------------------------------------------------------------------------

echo "1. Output-style gate"

out="$(run_hook "ac-writing-style" "$ROOT")"
check "speaks when ac-writing-style is active" \
  '[ -n "$(echo "$out" | context_of)" ]'

out="$(run_hook "spechub:ac-writing-style" "$ROOT")"
check "speaks when the style carries a plugin prefix" \
  '[ -n "$(echo "$out" | context_of)" ]'

out="$(run_hook "Explanatory" "$ROOT")"
check "stays silent under another output style" '[ "$out" = "{}" ]'

check "leaves stderr empty" '[ ! -s "$WORK/stderr" ]'

# A settings file with no outputStyle key at all means no style is set.
home="$WORK/home_nostyle"
mkdir -p "$home/.claude"
echo '{}' > "$home/.claude/settings.json"
out="$( cd "$WORK" && HOME="$home" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$HOOK" </dev/null 2>/dev/null )"
check "stays silent when no output style is set" '[ "$out" = "{}" ]'

echo ""

# ---------------------------------------------------------------------------
# 2. What it extracts
# ---------------------------------------------------------------------------

echo "2. Extracted sections"

ctx="$(run_hook "ac-writing-style" "$ROOT" | context_of)"

check "names itself in the first line" \
  '[ "$(echo "$ctx" | head -1)" = "ac-writing-style reminder" ]'

check "carries the persona opener" \
  'echo "$ctx" | grep -q "You are the best developer in the world"'

check "carries the Before you send heading" \
  'echo "$ctx" | grep -q "^## Before you send$"'

check "carries every checklist item, all nine" \
  '[ "$(echo "$ctx" | grep -cE "^[1-9]\. ")" -eq 9 ]'

check "drops the persona sub-bullets, which the file itself argues" \
  '! echo "$ctx" | grep -q "Other developers envy how easily"'

echo ""

# ---------------------------------------------------------------------------
# 3. No drift: every line comes from the output style
# ---------------------------------------------------------------------------

echo "3. No drift from the output style"

# Every emitted line, bar the hook's own title and blanks, must appear
# verbatim in the output style. This is the check the stored-copy version of
# this hook could not make, and the reason it drifted.
drifted=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  [ "$line" = "ac-writing-style reminder" ] && continue
  grep -Fxq -- "$line" "$STYLE" || { echo "    drifted: $line"; drifted=1; }
done <<< "$ctx"
check "every reminder line appears verbatim in the output style" '[ "$drifted" -eq 0 ]'

# The reverse guarantee: edit the style, and the reminder changes with it.
fake="$WORK/fake_root"
mkdir -p "$fake/output-styles"
sed 's/^1\. The first bullet is the answer$/1. The first bullet is the ANSWER, edited/' \
  "$STYLE" > "$fake/output-styles/ac-writing-style.md"
edited="$(run_hook "ac-writing-style" "$fake" | context_of)"
check "an edit to the style reaches the reminder" \
  'echo "$edited" | grep -q "The first bullet is the ANSWER, edited"'

echo ""

# ---------------------------------------------------------------------------
# 4. Output contract
# ---------------------------------------------------------------------------

echo "4. Output contract"

out="$(run_hook "ac-writing-style" "$ROOT")"

check "emits one line of valid JSON" \
  'echo "$out" | python3 -c "import json,sys; json.load(sys.stdin)"'

check "sets suppressOutput, so nothing reaches the transcript" \
  'echo "$out" | python3 -c "import json,sys; raise SystemExit(0 if json.load(sys.stdin)[\"suppressOutput\"] is True else 1)"'

check "names the UserPromptSubmit event" \
  'echo "$out" | python3 -c "import json,sys; raise SystemExit(0 if json.load(sys.stdin)[\"hookSpecificOutput\"][\"hookEventName\"] == \"UserPromptSubmit\" else 1)"'

# The style quotes double quotes and backslashes at it, so the escaping has to
# survive a round trip through JSON rather than merely produce parseable output.
# Checklist item 4 is the line in the style with the most double quotes in it,
# so it is the one that proves the JSON escaping survives a round trip.
quoted='4. Search your own reply for ", and ", ", so ", ", which ", and ", because "'
check "round-trips a line the style fills with double quotes" \
  'echo "$ctx" | grep -Fxq -- "$quoted"'

echo ""

# ---------------------------------------------------------------------------
# 5. Fallbacks
# ---------------------------------------------------------------------------

echo "5. Fallbacks"

empty="$WORK/empty_root"
mkdir -p "$empty/output-styles"
out="$(run_hook "ac-writing-style" "$empty")"
check "stays silent when the output style file is missing" '[ "$out" = "{}" ]'

blank="$WORK/blank_root"
mkdir -p "$blank/output-styles"
printf '# nothing to extract\n' > "$blank/output-styles/ac-writing-style.md"
out="$(run_hook "ac-writing-style" "$blank")"
check "stays silent when the file holds neither section" '[ "$out" = "{}" ]'

check "exits 0 in every case above" 'true'

echo ""

# ---------------------------------------------------------------------------
# 6. Wiring
# ---------------------------------------------------------------------------

echo "6. Wiring in hooks.json"

check "hooks.json parses" \
  'python3 -c "import json; json.load(open(\"$HOOKS_JSON\"))"'

check "registers the hook on UserPromptSubmit" \
  'python3 -c "
import json
d = json.load(open(\"$HOOKS_JSON\"))
cmds = [h[\"command\"] for e in d[\"hooks\"].get(\"UserPromptSubmit\", []) for h in e[\"hooks\"]]
raise SystemExit(0 if any(\"ac-writing-style-reminder.sh\" in c for c in cmds) else 1)
"'

check "addresses the script through CLAUDE_PLUGIN_ROOT" \
  'grep -q "CLAUDE_PLUGIN_ROOT}/hooks/ac-writing-style-reminder.sh" "$HOOKS_JSON"'

check "the script is executable" '[ -x "$HOOK" ]'

echo ""
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
