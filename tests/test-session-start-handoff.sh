#!/usr/bin/env bash
# Local test harness for session-start-handoff.sh.
#
# Simulates exactly what Claude Code sends a SessionStart hook (a JSON payload on
# stdin) and asserts the hook's behavior end-to-end: injection, frontmatter
# stripping, consume-once, change-aware archival, collision suffixes, and the
# safety gates. Uses a throwaway temp dir and cleans up after itself.
#
# Run it:  bash tests/test-session-start-handoff.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/../hooks/session-start-handoff.sh"

if [ ! -f "$HOOK" ]; then
  echo "FATAL: hook not found at $HOOK" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

# Write an active handoff. $1 = change, $2 = created timestamp.
mk() {
  mkdir -p spechub
  cat > spechub/HANDOFF.md <<EOF
---
spechub_handoff: 1
change: $1
created: $2
---
# SpecHub Handoff — $1

## Next action
Resume the $1 work.
EOF
}

# Run the hook with a given source. Echoes stdout.
run() { printf '{"source":"%s"}' "$1" | bash "$HOOK"; }

echo "Testing: $HOOK"
echo "Workdir: $WORK"
echo ""

# --- Case 1: change dir exists -> inject body, consume, archive in change ------
echo "Case 1: active change on disk"
mkdir -p spechub/changes/AUTH-12
mk "AUTH-12" "2026-05-25T14:30:00Z"
OUT="$(run compact)"
check "outputs additionalContext"          '[ -n "$OUT" ] && printf "%s" "$OUT" | grep -q additionalContext'
check "injects the body (next action)"      'printf "%s" "$OUT" | grep -q "Resume the AUTH-12 work"'
check "strips frontmatter from injection"   '! printf "%s" "$OUT" | grep -q spechub_handoff'
check "consumes active HANDOFF.md"           '[ ! -f spechub/HANDOFF.md ]'
check "archives inside the change dir"       '[ -f spechub/changes/AUTH-12/handoffs/2026-05-25T14-30-00Z.md ]'
check "archive keeps full file (frontmatter)" 'grep -q spechub_handoff spechub/changes/AUTH-12/handoffs/2026-05-25T14-30-00Z.md'

# --- Case 2: second compact, nothing pending -> silent no-op ------------------
echo "Case 2: no pending handoff"
OUT="$(run compact)"
check "produces no output"                   '[ -z "$OUT" ]'

# --- Case 3: ad-hoc (no change dir) -> falls back to spechub/handoffs ---------
echo "Case 3: ad-hoc work"
mk "ad-hoc" "2026-05-25T15:00:00Z"
run compact >/dev/null
check "archives under spechub/handoffs/ad-hoc" '[ -f spechub/handoffs/ad-hoc/2026-05-25T15-00-00Z.md ]'
check "consumes active HANDOFF.md"             '[ ! -f spechub/HANDOFF.md ]'

# --- Case 4: collision -> unique numeric suffix ------------------------------
echo "Case 4: same timestamp twice"
mkdir -p spechub/changes/REF-9
mk "REF-9" "2026-05-25T16:00:00Z"; run compact >/dev/null
mk "REF-9" "2026-05-25T16:00:00Z"; run compact >/dev/null
check "first archived without suffix"        '[ -f spechub/changes/REF-9/handoffs/2026-05-25T16-00-00Z.md ]'
check "second archived with -2 suffix"       '[ -f spechub/changes/REF-9/handoffs/2026-05-25T16-00-00Z-2.md ]'

# --- Case 5: file without the marker -> never touched ------------------------
echo "Case 5: unmarked file (a user's own HANDOFF.md)"
mkdir -p spechub
printf '# my own notes\nnot a spechub handoff\n' > spechub/HANDOFF.md
OUT="$(run compact)"
check "produces no output"                   '[ -z "$OUT" ]'
check "leaves the file untouched"            '[ -f spechub/HANDOFF.md ]'
rm -f spechub/HANDOFF.md

# --- Case 6: non-compact source -> never fires -------------------------------
echo "Case 6: source is not compact"
mk "AUTH-12" "2026-05-25T17:00:00Z"
for src in startup resume clear; do
  OUT="$(run "$src")"
  check "no-op on source=$src"               '[ -z "$OUT" ]'
done
check "leaves active handoff in place"       '[ -f spechub/HANDOFF.md ]'

# --- Case 7: malformed stdin -> clean no-op ----------------------------------
echo "Case 7: malformed payload"
OUT="$(printf 'not json' | bash "$HOOK")"
check "produces no output on garbage stdin"  '[ -z "$OUT" ]'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
