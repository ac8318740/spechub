#!/usr/bin/env bash
# Test harness for detect-orchestrator.sh.
#
# detect-orchestrator.sh is a read-only report: it prints which worktree
# orchestrator is DECLARED for this host (via the SpecHub CLI's
# `config get host.orchestrator`) and which one is actually DETECTED as
# hosting the current session (via environment markers), then reconciles
# the two into an ACTIVE orchestrator plus an optional WARNING line.
#
# Each case runs the script in a subshell with HOME pointed at a scratch
# directory (containing a fake SpecHub CLI, when the case needs one) and
# with HERDR_ENV / HERDR_PANE_ID / ORCA_PANE_KEY explicitly unset and then
# re-set as the case requires, so nothing leaks in from the real session
# this suite happens to be running inside.
#
# Run it:  bash skills/new-worktree/detect-orchestrator.test.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="${SCRIPT_DIR}/detect-orchestrator.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

# --- helpers ------------------------------------------------------------

# Write a fake SpecHub CLI at $1/.claude/spechub/bin/spechub that prints
# $2 (verbatim, plus a trailing newline) and exits with code $3 (default 0).
mk_cli() {
  local home_dir="$1" output="$2" code="${3:-0}"
  local bin_dir="$home_dir/.claude/spechub/bin"
  mkdir -p "$bin_dir"
  printf '%s' "$output" > "$bin_dir/.output"
  printf '%s' "$code" > "$bin_dir/.exitcode"
  cat > "$bin_dir/spechub" <<'CLIEOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat "$DIR/.output"
exit "$(cat "$DIR/.exitcode")"
CLIEOF
  chmod +x "$bin_dir/spechub"
}

# Run the SUT with HOME=$1 and the given env-setup snippet ($2, eval'd in a
# subshell before invoking the script) applied on top of a clean slate
# where HERDR_ENV, HERDR_PANE_ID and ORCA_PANE_KEY start unset. Echoes
# stdout only (stderr discarded); caller reads $? for the exit code.
run_case() {
  local home_dir="$1" env_setup="$2"
  (
    unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
    export HOME="$home_dir"
    eval "$env_setup"
    bash "$SUT" 2>/dev/null
  )
}

# Extract the value for key $2 out of full output $1.
get_val() {
  printf '%s\n' "$1" | grep "^${2}=" | head -n1 | sed "s/^${2}=//"
}

new_home() { mktemp -d -p "$WORK"; }

echo "Testing: $SUT"
echo "Workdir: $WORK"
echo ""

# =========================================================================
# R1 – output shape
# =========================================================================
echo "Case 1: basic run – output shape (R1)"
H1="$(new_home)"
mk_cli "$H1" "none" 0
OUT="$(run_case "$H1" '')"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                       '[ "$CODE" -eq 0 ]'
check "prints exactly 4 lines"                '[ "$LINES" -eq 4 ]'
check "line 1 is declared="                   'printf "%s\n" "$OUT" | sed -n "1p" | grep -q "^declared="'
check "line 2 is detected="                   'printf "%s\n" "$OUT" | sed -n "2p" | grep -q "^detected="'
check "line 3 is active="                     'printf "%s\n" "$OUT" | sed -n "3p" | grep -q "^active="'
check "line 4 is warning="                    'printf "%s\n" "$OUT" | sed -n "4p" | grep -q "^warning="'
check "declared=none"                         '[ "$(get_val "$OUT" declared)" = "none" ]'
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'
check "active=none"                           '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R2 – declared
# =========================================================================
echo "Case 2: CLI exits 0, prints herdr with surrounding whitespace -> trimmed (R2)"
H2="$(new_home)"
mk_cli "$H2" "  herdr  " 0
OUT="$(run_case "$H2" '')"
check "declared=herdr (trimmed)"              '[ "$(get_val "$OUT" declared)" = "herdr" ]'

echo "Case 3: CLI exits 0, prints orca (R2)"
H3="$(new_home)"
mk_cli "$H3" "orca" 0
OUT="$(run_case "$H3" '')"
check "declared=orca"                         '[ "$(get_val "$OUT" declared)" = "orca" ]'

echo "Case 4: CLI exits 0, prints none (R2)"
H4="$(new_home)"
mk_cli "$H4" "none" 0
OUT="$(run_case "$H4" '')"
check "declared=none"                         '[ "$(get_val "$OUT" declared)" = "none" ]'

echo "Case 5: CLI exits 0, prints an unrecognised value (R2)"
H5="$(new_home)"
mk_cli "$H5" "tmux" 0
OUT="$(run_case "$H5" '')"
check "declared=unset"                        '[ "$(get_val "$OUT" declared)" = "unset" ]'
check "warning mentions the unrecognised value" 'printf "%s" "$(get_val "$OUT" warning)" | grep -q "tmux"'

echo "Case 6: CLI exits 2 (key unset) -> declared=unset, no CLI warning (R2)"
H6="$(new_home)"
mk_cli "$H6" "" 2
OUT="$(run_case "$H6" '')"
check "declared=unset"                        '[ "$(get_val "$OUT" declared)" = "unset" ]'
check "no warning (detected is also none)"    '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 7: CLI path does not exist (R2)"
H7="$(new_home)"
mkdir -p "$H7"
OUT="$(run_case "$H7" '')"
check "declared=unset"                        '[ "$(get_val "$OUT" declared)" = "unset" ]'
WARN7="$(get_val "$OUT" warning)"
check "warning says CLI could not be run"     'printf "%s" "$WARN7" | grep -qi "spechub"'
check "warning mentions restarting Claude Code" 'printf "%s" "$WARN7" | grep -qi "restart"'

echo "Case 8: CLI exists but is not executable (R2)"
H8="$(new_home)"
mk_cli "$H8" "herdr" 0
chmod -x "$H8/.claude/spechub/bin/spechub"
OUT="$(run_case "$H8" '')"
check "declared=unset"                        '[ "$(get_val "$OUT" declared)" = "unset" ]'
WARN8="$(get_val "$OUT" warning)"
check "warning says CLI could not be run"     'printf "%s" "$WARN8" | grep -qi "spechub"'
check "warning mentions restarting Claude Code" 'printf "%s" "$WARN8" | grep -qi "restart"'

echo "Case 9: CLI exits with an unrelated non-zero code (R2)"
H9="$(new_home)"
mk_cli "$H9" "boom" 1
OUT="$(run_case "$H9" '')"
check "declared=unset"                        '[ "$(get_val "$OUT" declared)" = "unset" ]'
check "warning mentions the CLI failed"       'printf "%s" "$(get_val "$OUT" warning)" | grep -qi "fail"'

# =========================================================================
# R3 – detected
# =========================================================================
echo "Case 10: HERDR_ENV set -> detected=herdr (R3)"
H10="$(new_home)"
mk_cli "$H10" "none" 0
OUT="$(run_case "$H10" 'export HERDR_ENV=1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'

echo "Case 11: HERDR_PANE_ID set -> detected=herdr (R3)"
H11="$(new_home)"
mk_cli "$H11" "none" 0
OUT="$(run_case "$H11" 'export HERDR_PANE_ID=pane-1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'

echo "Case 12: ORCA_PANE_KEY set -> detected=orca (R3)"
H12="$(new_home)"
mk_cli "$H12" "none" 0
OUT="$(run_case "$H12" 'export ORCA_PANE_KEY=key-1')"
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'

echo "Case 13: HERDR_ENV set but empty -> detected=none (R3)"
H13="$(new_home)"
mk_cli "$H13" "none" 0
OUT="$(run_case "$H13" 'export HERDR_ENV=""')"
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'

echo "Case 14: all markers set but empty -> detected=none (R3)"
H14="$(new_home)"
mk_cli "$H14" "none" 0
OUT="$(run_case "$H14" 'export HERDR_ENV="" HERDR_PANE_ID="" ORCA_PANE_KEY=""')"
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'

echo "Case 15: ambiguous markers, declared is neither -> detected=herdr, warning names both (R3)"
H15="$(new_home)"
mk_cli "$H15" "none" 0
OUT="$(run_case "$H15" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "detected=herdr (default of the ambiguous pair)" '[ "$(get_val "$OUT" detected)" = "herdr" ]'
WARN15="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN15" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN15" | grep -qi "orca"'

echo "Case 16: ambiguous markers, declared=orca -> detected=orca, warning names both (R3)"
H16="$(new_home)"
mk_cli "$H16" "orca" 0
OUT="$(run_case "$H16" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "detected=orca (matches declared)"      '[ "$(get_val "$OUT" detected)" = "orca" ]'
WARN16="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN16" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN16" | grep -qi "orca"'

echo "Case 17: ambiguous markers, declared=herdr -> detected=herdr, still warns (R3)"
H17="$(new_home)"
mk_cli "$H17" "herdr" 0
OUT="$(run_case "$H17" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "detected=herdr (matches declared)"     '[ "$(get_val "$OUT" detected)" = "herdr" ]'
WARN17="$(get_val "$OUT" warning)"
check "warning is non-empty even though declared==detected" '[ -n "$WARN17" ]'
check "warning names herdr"                   'printf "%s" "$WARN17" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN17" | grep -qi "orca"'

# =========================================================================
# R4 – active always equals detected
# =========================================================================
echo "Case 18: declared=herdr, nothing detected -> active follows detected, not declared (R4/R5)"
H18="$(new_home)"
mk_cli "$H18" "herdr" 0
OUT="$(run_case "$H18" '')"
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'
check "active=none (not herdr)"               '[ "$(get_val "$OUT" active)" = "none" ]'
WARN18="$(get_val "$OUT" warning)"
check "warning names the declared orchestrator (herdr)" 'printf "%s" "$WARN18" | grep -qi "herdr"'
check "warning mentions plain git worktrees"  'printf "%s" "$WARN18" | grep -qi "git"'

# =========================================================================
# R5 – warning pairing rules
# =========================================================================
echo "Case 19: declared=herdr, detected=orca -> active=orca, warning names both (R5)"
H19="$(new_home)"
mk_cli "$H19" "herdr" 0
OUT="$(run_case "$H19" 'export ORCA_PANE_KEY=key-1')"
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
check "active=orca"                           '[ "$(get_val "$OUT" active)" = "orca" ]'
WARN19="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN19" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN19" | grep -qi "orca"'

echo "Case 20: declared=orca, detected=herdr -> active=herdr, warning names both (R5)"
H20="$(new_home)"
mk_cli "$H20" "orca" 0
OUT="$(run_case "$H20" 'export HERDR_ENV=1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr"                          '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN20="$(get_val "$OUT" warning)"
check "warning names orca"                    'printf "%s" "$WARN20" | grep -qi "orca"'
check "warning names herdr"                   'printf "%s" "$WARN20" | grep -qi "herdr"'

echo "Case 21: declared=unset (CLI key unset), detected=herdr -> points at /spechub:host (R5)"
H21="$(new_home)"
mk_cli "$H21" "" 2
OUT="$(run_case "$H21" 'export HERDR_ENV=1')"
check "declared=unset"                        '[ "$(get_val "$OUT" declared)" = "unset" ]'
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
WARN21="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN21" | grep -qi "herdr"'
check "warning mentions /spechub:host"        'printf "%s" "$WARN21" | grep -q "spechub:host"'

echo "Case 22: declared=none, detected=orca -> used anyway (R5)"
H22="$(new_home)"
mk_cli "$H22" "none" 0
OUT="$(run_case "$H22" 'export ORCA_PANE_KEY=key-1')"
check "declared=none"                         '[ "$(get_val "$OUT" declared)" = "none" ]'
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
WARN22="$(get_val "$OUT" warning)"
check "warning names orca"                    'printf "%s" "$WARN22" | grep -qi "orca"'

echo "Case 23: declared=herdr, detected=herdr -> no warning (R5)"
H23="$(new_home)"
mk_cli "$H23" "herdr" 0
OUT="$(run_case "$H23" 'export HERDR_ENV=1')"
check "declared=herdr"                        '[ "$(get_val "$OUT" declared)" = "herdr" ]'
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 24: declared=none, detected=none -> no warning (R5)"
H24="$(new_home)"
mk_cli "$H24" "none" 0
OUT="$(run_case "$H24" '')"
check "declared=none"                         '[ "$(get_val "$OUT" declared)" = "none" ]'
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R6 – purity: no filesystem writes, anywhere
# =========================================================================
echo "Case 25: purity – a run leaves the scratch dir untouched (R6)"
H25="$(new_home)"
mk_cli "$H25" "herdr" 0
SCRATCH="$WORK/scratch25"
mkdir -p "$SCRATCH"
cd "$SCRATCH" || exit 1
BEFORE="$(find . | sort)"
(
  unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
  export HOME="$H25"
  export HERDR_ENV=1
  bash "$SUT" >/dev/null 2>/dev/null
)
AFTER="$(find . | sort)"
cd "$WORK" || exit 1
check "scratch dir listing unchanged by the run" '[ "$BEFORE" = "$AFTER" ]'

# =========================================================================
# R7 – declared: multi-line CLI output must not break the four-line contract
# =========================================================================
echo "Case 26: CLI exits 0, prints two lines -> four-line contract still holds, declared=unset (R7)"
H26="$(new_home)"
mk_cli "$H26" $'herdr\norca' 0
OUT="$(run_case "$H26" '')"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                        '[ "$CODE" -eq 0 ]'
check "prints exactly 4 lines"                 '[ "$LINES" -eq 4 ]'
check "line 1 is declared="                    'printf "%s\n" "$OUT" | sed -n "1p" | grep -q "^declared="'
check "line 2 is detected="                    'printf "%s\n" "$OUT" | sed -n "2p" | grep -q "^detected="'
check "line 3 is active="                      'printf "%s\n" "$OUT" | sed -n "3p" | grep -q "^active="'
check "line 4 is warning="                     'printf "%s\n" "$OUT" | sed -n "4p" | grep -q "^warning="'
check "declared=unset (two-line answer is not a recognised orchestrator)" '[ "$(get_val "$OUT" declared)" = "unset" ]'
check "warning is non-empty"                   '[ -n "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R8 – purity: no writes anywhere under HOME, no global git config added
# =========================================================================
echo "Case 27: purity – a run touches nothing anywhere under HOME and adds no global git config (R8)"
H27="$(new_home)"
mk_cli "$H27" "herdr" 0
BEFORE_TREE27="$(find "$H27" | sort)"
BEFORE_GITCFG27="$(HOME="$H27" git config --global --list 2>/dev/null || true)"
(
  unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
  export HOME="$H27"
  export HERDR_ENV=1
  bash "$SUT" >/dev/null 2>/dev/null
)
AFTER_TREE27="$(find "$H27" | sort)"
AFTER_GITCFG27="$(HOME="$H27" git config --global --list 2>/dev/null || true)"
check "whole HOME tree unchanged by the run"   '[ "$BEFORE_TREE27" = "$AFTER_TREE27" ]'
check "no global git config added"             '[ "$BEFORE_GITCFG27" = "$AFTER_GITCFG27" ]'

# =========================================================================
# R9 – declared: a directory at the CLI path is not runnable (NEW requirement)
# =========================================================================
echo "Case 28: a directory sits at the CLI path -> not runnable, warning must name the fix (restart), not the generic failure message (NEW requirement, expected to FAIL) (R9)"
H28="$(new_home)"
mkdir -p "$H28/.claude/spechub/bin/spechub"
OUT="$(run_case "$H28" '')"
CODE=$?
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "declared=unset"                         '[ "$(get_val "$OUT" declared)" = "unset" ]'
WARN28="$(get_val "$OUT" warning)"
check "warning mentions restarting Claude Code (the fix), not the generic CLI-failed message" 'printf "%s" "$WARN28" | grep -qi "restart"'

# =========================================================================
# R10 – declared: an empty answer with exit 0 is not the same as an unset key (NEW requirement)
# =========================================================================
echo "Case 29: CLI exits 0 and prints nothing -> an empty answer is not an unset key, and must not be silent (NEW requirement, expected to FAIL) (R10)"
H29="$(new_home)"
mk_cli "$H29" "" 0
OUT="$(run_case "$H29" '')"
CODE=$?
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "declared=unset"                         '[ "$(get_val "$OUT" declared)" = "unset" ]'
WARN29="$(get_val "$OUT" warning)"
check "warning is non-empty (not silent)"      '[ -n "$WARN29" ]'
check "warning says the tool gave an empty answer" 'printf "%s" "$WARN29" | grep -qi "empty"'
DQ29='""'
check "warning does not quote an empty value back at the user" '! printf "%s" "$WARN29" | grep -qF "$DQ29"'


# =========================================================================
# R11 – declared: HOME is not set at all (NEW requirement)
# =========================================================================
echo "Case 30: HOME is not set at all -> the tool cannot be located, same contract, same fix as the missing-tool case (NEW requirement, expected to FAIL) (R11)"
OUT="$(
  env -u HOME -u HERDR_ENV -u HERDR_PANE_ID -u ORCA_PANE_KEY \
    bash "$SUT" 2>/dev/null
)"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "prints exactly 4 lines"                 '[ "$LINES" -eq 4 ]'
check "line 1 is declared="                    'printf "%s\n" "$OUT" | sed -n "1p" | grep -q "^declared="'
check "line 2 is detected="                    'printf "%s\n" "$OUT" | sed -n "2p" | grep -q "^detected="'
check "line 3 is active="                      'printf "%s\n" "$OUT" | sed -n "3p" | grep -q "^active="'
check "line 4 is warning="                     'printf "%s\n" "$OUT" | sed -n "4p" | grep -q "^warning="'
check "declared=unset"                         '[ "$(get_val "$OUT" declared)" = "unset" ]'
WARN30="$(get_val "$OUT" warning)"
check "warning is non-empty"                   '[ -n "$WARN30" ]'
check "warning mentions restarting Claude Code (the same fix as the missing-tool case)" 'printf "%s" "$WARN30" | grep -qi "restart"'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
