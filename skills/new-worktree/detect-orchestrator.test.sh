#!/usr/bin/env bash
# Test harness for detect-orchestrator.sh.
#
# detect-orchestrator.sh is a read-only report. It prints which orchestrators
# this host DECLARES it has, one boolean per orchestrator (via the SpecHub
# CLI's `config get host.orchestrators.herdr` and
# `config get host.orchestrators.orca`), and which one is actually DETECTED as
# hosting the current session (via environment markers), then reconciles the
# two into an ACTIVE orchestrator plus an optional WARNING line.
#
# The two declarations are independent: a host can have both orchestrators
# installed, or neither, so there is no single "the declared orchestrator"
# any more.
#
# Each case runs the script in a subshell with HOME pointed at a scratch
# directory (containing a fake SpecHub CLI, when the case needs one) and
# with HERDR_ENV / HERDR_PANE_ID / ORCA_PANE_KEY explicitly unset and then
# re-set as the case requires, so nothing leaks in from the real session
# this suite happens to be running inside.
#
# The report also names the OWNER of the checkout it is looking at. A checkout
# is one git worktree directory, and its path root names the owner: a path
# under $HOME/orca/workspaces/ belongs to orca, a path under herdr's worktree
# root belongs to herdr, and anything else belongs to plain git. Cases that
# care about the owner therefore run the script from a scratch directory built
# under the case's fake HOME, or pass that directory as the script's first
# argument.
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

# Write a fake SpecHub CLI at $1/.claude/spechub/bin/spechub that answers
# EVERY invocation the same way: printing $2 (verbatim, plus a trailing
# newline) and exiting with code $3 (default 0). For the cases where the tool
# itself is the subject, so what it was asked does not matter.
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

# Write a fake SpecHub CLI that answers the two orchestrator axes separately:
# `config get host.orchestrators.herdr` prints $2 and exits $3, and
# `config get host.orchestrators.orca` prints $4 and exits $5.
#
# Any other key exits 1 without printing, so a script that still asks the
# retired `host.orchestrator` key reads as a tool failure rather than
# silently passing these cases.
mk_cli_axes() {
  local home_dir="$1"
  local bin_dir="$home_dir/.claude/spechub/bin"
  mkdir -p "$bin_dir"
  printf '%s' "$2" > "$bin_dir/.herdr.output"
  printf '%s' "$3" > "$bin_dir/.herdr.exitcode"
  printf '%s' "$4" > "$bin_dir/.orca.output"
  printf '%s' "$5" > "$bin_dir/.orca.exitcode"
  cat > "$bin_dir/spechub" <<'CLIEOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${3:-}" in
  host.orchestrators.herdr) axis=herdr ;;
  host.orchestrators.orca)  axis=orca ;;
  *) exit 1 ;;
esac
cat "$DIR/.$axis.output"
exit "$(cat "$DIR/.$axis.exitcode")"
CLIEOF
  chmod +x "$bin_dir/spechub"
}

# The readable form of mk_cli_axes: each of $2 (herdr) and $3 (orca) is one
# of true, false or unset, and is turned into the answer a real CLI would
# give – the JSON boolean on exit 0, or exit 2 with no output for a key that
# was never set.
mk_cli_declared() {
  local home_dir="$1" herdr="$2" orca="$3"
  local h_out h_code o_out o_code
  case "$herdr" in
    true)  h_out="true";  h_code=0 ;;
    false) h_out="false"; h_code=0 ;;
    unset) h_out="";      h_code=2 ;;
    *) echo "mk_cli_declared: bad herdr spec: $herdr" >&2; exit 1 ;;
  esac
  case "$orca" in
    true)  o_out="true";  o_code=0 ;;
    false) o_out="false"; o_code=0 ;;
    unset) o_out="";      o_code=2 ;;
    *) echo "mk_cli_declared: bad orca spec: $orca" >&2; exit 1 ;;
  esac
  mk_cli_axes "$home_dir" "$h_out" "$h_code" "$o_out" "$o_code"
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

# run_case, but from a given working directory ($2), so the case controls which
# checkout the script is looking at. cd is left logical on purpose: a case that
# hands over a symlinked path is testing that the script resolves it itself.
run_case_in() {
  local home_dir="$1" cwd_dir="$2" env_setup="$3"
  (
    unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
    export HOME="$home_dir"
    cd "$cwd_dir" || exit 1
    eval "$env_setup"
    bash "$SUT" 2>/dev/null
  )
}

# run_case, but passing $2 as the script's first argument, so the case names the
# checkout to examine rather than standing in it.
run_case_arg() {
  local home_dir="$1" path_arg="$2" env_setup="$3"
  (
    unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
    export HOME="$home_dir"
    eval "$env_setup"
    bash "$SUT" "$path_arg" 2>/dev/null
  )
}

# Create the checkout $2/$3 under home $1's default herdr worktree root and echo
# its path.
mk_herdr_checkout() {
  local path="$1/.herdr/worktrees/$2/$3"
  mkdir -p "$path"
  printf '%s\n' "$path"
}

# Create the orca workspace $2 under home $1 and echo its path.
mk_orca_checkout() {
  local path="$1/orca/workspaces/$2"
  mkdir -p "$path"
  printf '%s\n' "$path"
}

# Write herdr's config file under home $1 with a [worktrees] section naming $2
# as the worktree root. $2 is written verbatim, so a case can pass either a
# "~/..." path or an absolute one.
mk_herdr_config() {
  local home_dir="$1" dir="$2"
  mkdir -p "$home_dir/.config/herdr"
  cat > "$home_dir/.config/herdr/config.toml" <<EOF
[worktrees]
directory = "$dir"
EOF
}

# Write a herdr config file under home $1 that exists but says nothing about
# worktrees, so the default root still applies.
mk_herdr_config_without_worktrees() {
  local home_dir="$1"
  mkdir -p "$home_dir/.config/herdr"
  cat > "$home_dir/.config/herdr/config.toml" <<'EOF'
[general]
theme = "dark"
EOF
}

echo "Testing: $SUT"
echo "Workdir: $WORK"
echo ""

# =========================================================================
# R1 – output shape: one line per declared orchestrator, then the rest
# =========================================================================
echo "Case 1: basic run – output shape (R1)"
H1="$(new_home)"
mk_cli_declared "$H1" false false
OUT="$(run_case "$H1" '')"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                        '[ "$CODE" -eq 0 ]'
check "prints exactly 6 lines"                '[ "$LINES" -eq 6 ]'
check "line 1 is declared_herdr="             'printf "%s\n" "$OUT" | sed -n "1p" | grep -q "^declared_herdr="'
check "line 2 is declared_orca="              'printf "%s\n" "$OUT" | sed -n "2p" | grep -q "^declared_orca="'
check "line 3 is detected="                   'printf "%s\n" "$OUT" | sed -n "3p" | grep -q "^detected="'
check "line 4 is active="                     'printf "%s\n" "$OUT" | sed -n "4p" | grep -q "^active="'
check "line 5 is owner="                      'printf "%s\n" "$OUT" | sed -n "5p" | grep -q "^owner="'
check "line 6 is warning="                    'printf "%s\n" "$OUT" | sed -n "6p" | grep -q "^warning="'
check "no bare declared= line remains"        '! printf "%s\n" "$OUT" | grep -q "^declared="'
check "declared_herdr=false"                  '[ "$(get_val "$OUT" declared_herdr)" = "false" ]'
check "declared_orca=false"                   '[ "$(get_val "$OUT" declared_orca)" = "false" ]'
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'
check "active=none"                           '[ "$(get_val "$OUT" active)" = "none" ]'
check "owner=none (a plain git checkout)"     '[ "$(get_val "$OUT" owner)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R2 – declared: two independent booleans
# =========================================================================
echo "Case 2: CLI prints true with surrounding whitespace -> trimmed (R2)"
H2="$(new_home)"
mk_cli_axes "$H2" "  true  " 0 "  false  " 0
OUT="$(run_case "$H2" '')"
check "declared_herdr=true (trimmed)"         '[ "$(get_val "$OUT" declared_herdr)" = "true" ]'
check "declared_orca=false (trimmed)"         '[ "$(get_val "$OUT" declared_orca)" = "false" ]'

echo "Case 3: the two booleans are read independently (R2)"
H3="$(new_home)"
mk_cli_declared "$H3" false true
OUT="$(run_case "$H3" '')"
check "declared_herdr=false"                  '[ "$(get_val "$OUT" declared_herdr)" = "false" ]'
check "declared_orca=true"                    '[ "$(get_val "$OUT" declared_orca)" = "true" ]'

echo "Case 4: both are declared true (R2)"
H4="$(new_home)"
mk_cli_declared "$H4" true true
OUT="$(run_case "$H4" '')"
check "declared_herdr=true"                   '[ "$(get_val "$OUT" declared_herdr)" = "true" ]'
check "declared_orca=true"                    '[ "$(get_val "$OUT" declared_orca)" = "true" ]'

echo "Case 5: CLI exits 2 for both keys (never declared) -> unset, no warning (R2)"
H5="$(new_home)"
mk_cli_declared "$H5" unset unset
OUT="$(run_case "$H5" '')"
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                   '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
check "no warning (nothing is hosting either)" '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 6: one key unset, the other declared -> only that one is unset (R2)"
H6="$(new_home)"
mk_cli_axes "$H6" "true" 0 "" 2
OUT="$(run_case "$H6" '')"
check "declared_herdr=true"                   '[ "$(get_val "$OUT" declared_herdr)" = "true" ]'
check "declared_orca=unset"                   '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'

echo "Case 7: CLI exits 0 with an unrecognised value -> that key is unset, the other still read (R2)"
H7="$(new_home)"
mk_cli_axes "$H7" "tmux" 0 "true" 0
OUT="$(run_case "$H7" '')"
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=true (unaffected)"       '[ "$(get_val "$OUT" declared_orca)" = "true" ]'
check "warning mentions the unrecognised value" 'printf "%s" "$(get_val "$OUT" warning)" | grep -q "tmux"'

echo "Case 8: CLI path does not exist -> both declarations unreadable (R2)"
H8="$(new_home)"
mkdir -p "$H8"
OUT="$(run_case "$H8" '')"
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                   '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
WARN8="$(get_val "$OUT" warning)"
check "warning says CLI could not be run"     'printf "%s" "$WARN8" | grep -qi "spechub"'
check "warning mentions restarting Claude Code" 'printf "%s" "$WARN8" | grep -qi "restart"'

echo "Case 9: CLI exists but is not executable (R2)"
H9="$(new_home)"
mk_cli_declared "$H9" true false
chmod -x "$H9/.claude/spechub/bin/spechub"
OUT="$(run_case "$H9" '')"
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                   '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
WARN9="$(get_val "$OUT" warning)"
check "warning says CLI could not be run"     'printf "%s" "$WARN9" | grep -qi "spechub"'
check "warning mentions restarting Claude Code" 'printf "%s" "$WARN9" | grep -qi "restart"'

echo "Case 10: CLI exits with an unrelated non-zero code (R2)"
H10="$(new_home)"
mk_cli "$H10" "boom" 1
OUT="$(run_case "$H10" '')"
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                   '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
check "warning mentions the CLI failed"       'printf "%s" "$(get_val "$OUT" warning)" | grep -qi "fail"'

# =========================================================================
# R3 – detected: environment markers, read without help from the CLI
# =========================================================================
echo "Case 11: HERDR_ENV set, herdr declared true -> detected=herdr, no warning (R3)"
H11="$(new_home)"
mk_cli_declared "$H11" true false
OUT="$(run_case "$H11" 'export HERDR_ENV=1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr"                          '[ "$(get_val "$OUT" active)" = "herdr" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 12: HERDR_PANE_ID set, herdr declared true -> detected=herdr (R3)"
H12="$(new_home)"
mk_cli_declared "$H12" true false
OUT="$(run_case "$H12" 'export HERDR_PANE_ID=pane-1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 13: ORCA_PANE_KEY set, orca declared true -> detected=orca, no warning (R3)"
H13="$(new_home)"
mk_cli_declared "$H13" false true
OUT="$(run_case "$H13" 'export ORCA_PANE_KEY=key-1')"
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
check "active=orca"                           '[ "$(get_val "$OUT" active)" = "orca" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 14: HERDR_ENV set but empty -> detected=none (R3)"
H14="$(new_home)"
mk_cli_declared "$H14" true false
OUT="$(run_case "$H14" 'export HERDR_ENV=""')"
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'

echo "Case 15: all markers set but empty -> detected=none (R3)"
H15="$(new_home)"
mk_cli_declared "$H15" true true
OUT="$(run_case "$H15" 'export HERDR_ENV="" HERDR_PANE_ID="" ORCA_PANE_KEY=""')"
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'

echo "Case 16: markers are read even when the CLI cannot be run (R3)"
H16="$(new_home)"
mkdir -p "$H16"
OUT="$(run_case "$H16" 'export HERDR_ENV=1')"
check "detected=herdr despite no readable CLI" '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr"                           '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN16="$(get_val "$OUT" warning)"
check "warning is the actionable CLI one (restart)" 'printf "%s" "$WARN16" | grep -qi "restart"'

# =========================================================================
# R4 – hosting without a declaration is a warning, not an error
# =========================================================================
echo "Case 17: herdr markers, herdr declared false -> active=herdr, warned (R4)"
H17="$(new_home)"
mk_cli_declared "$H17" false false
OUT="$(run_case "$H17" 'export HERDR_ENV=1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr (hosting beats declaring)" '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN17="$(get_val "$OUT" warning)"
check "warning is non-empty"                  '[ -n "$WARN17" ]'
check "warning names herdr"                   'printf "%s" "$WARN17" | grep -qi "herdr"'
check "warning mentions declaring"            'printf "%s" "$WARN17" | grep -qi "declare"'

echo "Case 18: herdr markers, herdr declaration unset -> active=herdr, warned (R4)"
H18="$(new_home)"
mk_cli_declared "$H18" unset unset
OUT="$(run_case "$H18" 'export HERDR_ENV=1')"
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "active=herdr"                          '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN18="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN18" | grep -qi "herdr"'
check "warning mentions declaring"            'printf "%s" "$WARN18" | grep -qi "declare"'

echo "Case 19: orca markers, orca declared false -> active=orca, warned (R4)"
H19="$(new_home)"
mk_cli_declared "$H19" true false
OUT="$(run_case "$H19" 'export ORCA_PANE_KEY=key-1')"
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
check "active=orca"                           '[ "$(get_val "$OUT" active)" = "orca" ]'
WARN19="$(get_val "$OUT" warning)"
check "warning names orca"                    'printf "%s" "$WARN19" | grep -qi "orca"'
check "warning mentions declaring"            'printf "%s" "$WARN19" | grep -qi "declare"'

# =========================================================================
# R5 – no markers: nothing is hosting, and that is not worth a warning
# =========================================================================
echo "Case 20: no markers, herdr declared true -> active=none, no warning (R5)"
H20="$(new_home)"
mk_cli_declared "$H20" true false
OUT="$(run_case "$H20" '')"
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'
check "active=none (not herdr)"               '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty (installed is not hosting)" '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 21: no markers, both declared true -> active=none, no warning (R5)"
H21="$(new_home)"
mk_cli_declared "$H21" true true
OUT="$(run_case "$H21" '')"
check "active=none"                           '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 22: no markers, both declared false -> active=none, no warning (R5)"
H22="$(new_home)"
mk_cli_declared "$H22" false false
OUT="$(run_case "$H22" '')"
check "active=none"                           '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R6 – both marker families at once, in a checkout nobody owns
#
# The checkout's owner settles this first: when the checkout belongs to herdr
# or to orca, that owner is the one hosting the session and there is nothing
# ambiguous to say. Those cases live under R16.
#
# Every case below runs from a plain git checkout, so the owner is none and the
# older reconciliation still applies: the declared booleans break the tie when
# exactly one orchestrator is declared true, and when both or neither are,
# herdr is picked and the reader is told why.
# =========================================================================
echo "Case 23: both markers, only herdr declared true -> active=herdr (R6)"
H23="$(new_home)"
mk_cli_declared "$H23" true false
OUT="$(run_case "$H23" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr"                          '[ "$(get_val "$OUT" active)" = "herdr" ]'

echo "Case 24: both markers, only orca declared true -> active=orca (R6)"
H24="$(new_home)"
mk_cli_declared "$H24" false true
OUT="$(run_case "$H24" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
check "active=orca"                           '[ "$(get_val "$OUT" active)" = "orca" ]'

echo "Case 25: both markers, both declared true -> active=herdr, warning names both (R6)"
H25="$(new_home)"
mk_cli_declared "$H25" true true
OUT="$(run_case "$H25" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "active=herdr (the tie-break default)"  '[ "$(get_val "$OUT" active)" = "herdr" ]'
check "owner=none (a plain git checkout)"     '[ "$(get_val "$OUT" owner)" = "none" ]'
WARN25="$(get_val "$OUT" warning)"
check "warning is non-empty"                  '[ -n "$WARN25" ]'
check "warning names herdr"                   'printf "%s" "$WARN25" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN25" | grep -qi "orca"'

echo "Case 26: both markers, neither declared true -> active=herdr, warning names both (R6)"
H26="$(new_home)"
mk_cli_declared "$H26" false false
OUT="$(run_case "$H26" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "active=herdr (the tie-break default)"  '[ "$(get_val "$OUT" active)" = "herdr" ]'
check "owner=none (a plain git checkout)"     '[ "$(get_val "$OUT" owner)" = "none" ]'
WARN26="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN26" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN26" | grep -qi "orca"'

echo "Case 27: both markers, both declarations unset -> active=herdr, warning names both (R6)"
H27="$(new_home)"
mk_cli_declared "$H27" unset unset
OUT="$(run_case "$H27" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "active=herdr (the tie-break default)"  '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN27="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN27" | grep -qi "herdr"'
check "warning names orca"                    'printf "%s" "$WARN27" | grep -qi "orca"'

# =========================================================================
# R7 – purity: no filesystem writes, anywhere
# =========================================================================
echo "Case 28: purity – a run leaves the scratch dir untouched (R7)"
H28="$(new_home)"
mk_cli_declared "$H28" true false
SCRATCH="$WORK/scratch28"
mkdir -p "$SCRATCH"
cd "$SCRATCH" || exit 1
BEFORE="$(find . | sort)"
(
  unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
  export HOME="$H28"
  export HERDR_ENV=1
  bash "$SUT" >/dev/null 2>/dev/null
)
AFTER="$(find . | sort)"
cd "$WORK" || exit 1
check "scratch dir listing unchanged by the run" '[ "$BEFORE" = "$AFTER" ]'

echo "Case 29: purity – a run touches nothing under HOME and adds no global git config (R7)"
H29="$(new_home)"
mk_cli_declared "$H29" true false
BEFORE_TREE29="$(find "$H29" | sort)"
BEFORE_GITCFG29="$(HOME="$H29" git config --global --list 2>/dev/null || true)"
(
  unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
  export HOME="$H29"
  export HERDR_ENV=1
  bash "$SUT" >/dev/null 2>/dev/null
)
AFTER_TREE29="$(find "$H29" | sort)"
AFTER_GITCFG29="$(HOME="$H29" git config --global --list 2>/dev/null || true)"
check "whole HOME tree unchanged by the run"   '[ "$BEFORE_TREE29" = "$AFTER_TREE29" ]'
check "no global git config added"             '[ "$BEFORE_GITCFG29" = "$AFTER_GITCFG29" ]'

# =========================================================================
# R8 – a malformed CLI answer must not break the six-line contract
# =========================================================================
echo "Case 30: CLI exits 0 and prints two lines -> six-line contract still holds (R8)"
H30="$(new_home)"
mk_cli "$H30" $'true\nfalse' 0
OUT="$(run_case "$H30" '')"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "prints exactly 6 lines"                 '[ "$LINES" -eq 6 ]'
check "line 1 is declared_herdr="              'printf "%s\n" "$OUT" | sed -n "1p" | grep -q "^declared_herdr="'
check "line 2 is declared_orca="               'printf "%s\n" "$OUT" | sed -n "2p" | grep -q "^declared_orca="'
check "line 3 is detected="                    'printf "%s\n" "$OUT" | sed -n "3p" | grep -q "^detected="'
check "line 4 is active="                      'printf "%s\n" "$OUT" | sed -n "4p" | grep -q "^active="'
check "line 5 is owner="                       'printf "%s\n" "$OUT" | sed -n "5p" | grep -q "^owner="'
check "line 6 is warning="                     'printf "%s\n" "$OUT" | sed -n "6p" | grep -q "^warning="'
check "declared_herdr=unset (a two-line answer is not a boolean)" '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "warning is non-empty"                   '[ -n "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R9 – a directory at the CLI path is not runnable
# =========================================================================
echo "Case 31: a directory sits at the CLI path -> warning names the fix (restart) (R9)"
H31="$(new_home)"
mkdir -p "$H31/.claude/spechub/bin/spechub"
OUT="$(run_case "$H31" '')"
CODE=$?
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "declared_herdr=unset"                   '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                    '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
WARN31="$(get_val "$OUT" warning)"
check "warning mentions restarting Claude Code (the fix), not the generic CLI-failed message" 'printf "%s" "$WARN31" | grep -qi "restart"'

# =========================================================================
# R10 – an empty answer with exit 0 is not the same as an unset key
# =========================================================================
echo "Case 32: CLI exits 0 and prints nothing -> not an unset key, and not silent (R10)"
H32="$(new_home)"
mk_cli "$H32" "" 0
OUT="$(run_case "$H32" '')"
CODE=$?
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "declared_herdr=unset"                   '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                    '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
WARN32="$(get_val "$OUT" warning)"
check "warning is non-empty (not silent)"      '[ -n "$WARN32" ]'
check "warning says the tool gave an empty answer" 'printf "%s" "$WARN32" | grep -qi "empty"'
DQ32='""'
check "warning does not quote an empty value back at the user" '! printf "%s" "$WARN32" | grep -qF "$DQ32"'

# =========================================================================
# R11 – HOME is not set at all
# =========================================================================
echo "Case 33: HOME is not set at all -> same contract, same fix as the missing-tool case (R11)"
OUT="$(
  env -u HOME -u HERDR_ENV -u HERDR_PANE_ID -u ORCA_PANE_KEY \
    bash "$SUT" 2>/dev/null
)"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                         '[ "$CODE" -eq 0 ]'
check "prints exactly 6 lines"                 '[ "$LINES" -eq 6 ]'
check "line 1 is declared_herdr="              'printf "%s\n" "$OUT" | sed -n "1p" | grep -q "^declared_herdr="'
check "line 2 is declared_orca="               'printf "%s\n" "$OUT" | sed -n "2p" | grep -q "^declared_orca="'
check "line 3 is detected="                    'printf "%s\n" "$OUT" | sed -n "3p" | grep -q "^detected="'
check "line 4 is active="                      'printf "%s\n" "$OUT" | sed -n "4p" | grep -q "^active="'
check "line 5 is owner="                       'printf "%s\n" "$OUT" | sed -n "5p" | grep -q "^owner="'
check "line 6 is warning="                     'printf "%s\n" "$OUT" | sed -n "6p" | grep -q "^warning="'
check "declared_herdr=unset"                   '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                    '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
check "owner=none (no HOME, so neither root resolves)" '[ "$(get_val "$OUT" owner)" = "none" ]'
WARN33="$(get_val "$OUT" warning)"
check "warning is non-empty"                   '[ -n "$WARN33" ]'
check "warning mentions restarting Claude Code (the same fix as the missing-tool case)" 'printf "%s" "$WARN33" | grep -qi "restart"'

# =========================================================================
# R12 – owner: which orchestrator owns the checkout being looked at
#
# A checkout is one git worktree directory, and its path root names the
# owner: a path under $HOME/orca/workspaces/ belongs to orca, a path under
# herdr's worktree root belongs to herdr, and anything else belongs to plain
# git and has no owner. The owner comes from the path alone – no markers, no
# declarations.
# =========================================================================
echo "Case 34: inside a herdr checkout, no markers -> owner=herdr (R12)"
H34="$(new_home)"
mk_cli_declared "$H34" false false
WT34="$(mk_herdr_checkout "$H34" repo-a branch-a)"
OUT="$(run_case_in "$H34" "$WT34" '')"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0"                        '[ "$CODE" -eq 0 ]'
check "prints exactly 6 lines"                '[ "$LINES" -eq 6 ]'
check "line 5 is owner="                      'printf "%s\n" "$OUT" | sed -n "5p" | grep -q "^owner="'
check "line 6 is warning="                    'printf "%s\n" "$OUT" | sed -n "6p" | grep -q "^warning="'
check "owner=herdr"                           '[ "$(get_val "$OUT" owner)" = "herdr" ]'
check "detected=none (owning is not hosting)" '[ "$(get_val "$OUT" detected)" = "none" ]'
check "active=none"                           '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 35: inside an orca workspace, no markers -> owner=orca (R12)"
H35="$(new_home)"
mk_cli_declared "$H35" false false
WS35="$(mk_orca_checkout "$H35" project-a)"
OUT="$(run_case_in "$H35" "$WS35" '')"
check "owner=orca"                            '[ "$(get_val "$OUT" owner)" = "orca" ]'
check "active=none"                           '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 36: inside a checkout under neither root -> owner=none (R12)"
H36="$(new_home)"
mk_cli_declared "$H36" true true
PLAIN36="$WORK/plain36/repo"
mkdir -p "$PLAIN36"
OUT="$(run_case_in "$H36" "$PLAIN36" '')"
check "owner=none"                            '[ "$(get_val "$OUT" owner)" = "none" ]'

echo "Case 37: the owner is reported even when the CLI cannot be run (R12)"
H37="$(new_home)"
mkdir -p "$H37"
WT37="$(mk_herdr_checkout "$H37" repo-b branch-b)"
OUT="$(run_case_in "$H37" "$WT37" '')"
check "owner=herdr despite no readable CLI"   '[ "$(get_val "$OUT" owner)" = "herdr" ]'
check "declared_herdr=unset"                  '[ "$(get_val "$OUT" declared_herdr)" = "unset" ]'
check "declared_orca=unset"                   '[ "$(get_val "$OUT" declared_orca)" = "unset" ]'
check "warning is still the actionable CLI one" 'printf "%s" "$(get_val "$OUT" warning)" | grep -qi "restart"'

echo "Case 38: the declared booleans do not move the owner (R12)"
H38A="$(new_home)"
mk_cli_declared "$H38A" true true
WS38="$(mk_orca_checkout "$H38A" project-b)"
OUT="$(run_case_in "$H38A" "$WS38" '')"
check "owner=orca with both declared true"    '[ "$(get_val "$OUT" owner)" = "orca" ]'
H38B="$(new_home)"
mk_cli_declared "$H38B" false false
WT38="$(mk_herdr_checkout "$H38B" repo-c branch-c)"
OUT="$(run_case_in "$H38B" "$WT38" '')"
check "owner=herdr with both declared false"  '[ "$(get_val "$OUT" owner)" = "herdr" ]'

# =========================================================================
# R13 – the optional path argument names the checkout to examine
# =========================================================================
echo "Case 39: a path argument replaces the working directory (R13)"
H39="$(new_home)"
mk_cli_declared "$H39" false false
WS39="$(mk_orca_checkout "$H39" project-c)"
WT39="$(mk_herdr_checkout "$H39" repo-d branch-d)"
PLAIN39="$WORK/plain39/repo"
mkdir -p "$PLAIN39"
OUT="$(run_case_arg "$H39" "$WS39" '')"
CODE=$?
LINES="$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
check "exit code is 0 with an argument"       '[ "$CODE" -eq 0 ]'
check "still prints exactly 6 lines"          '[ "$LINES" -eq 6 ]'
check "owner=orca from the named path"        '[ "$(get_val "$OUT" owner)" = "orca" ]'
OUT="$(
  (
    unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
    export HOME="$H39"
    cd "$WT39" || exit 1
    bash "$SUT" "$PLAIN39" 2>/dev/null
  )
)"
check "the argument wins over a herdr-owned cwd" '[ "$(get_val "$OUT" owner)" = "none" ]'

# =========================================================================
# R14 – the path is resolved before it is judged
#
# Symlinks and .. segments are resolved first, and the root directory itself
# is not a checkout: only what sits underneath it counts.
# =========================================================================
echo "Case 40: symlinks are resolved before the path is judged (R14)"
H40="$(new_home)"
mk_cli_declared "$H40" false false
WT40="$(mk_herdr_checkout "$H40" repo-e branch-e)"
SYM40="$WORK/sym40"
ln -s "$WT40" "$SYM40"
OUT="$(run_case_in "$H40" "$SYM40" '')"
check "a symlink into the herdr root -> owner=herdr" '[ "$(get_val "$OUT" owner)" = "herdr" ]'
OUTSIDE40="$WORK/outside40"
mkdir -p "$OUTSIDE40"
mkdir -p "$H40/.herdr/worktrees/repo-f"
ln -s "$OUTSIDE40" "$H40/.herdr/worktrees/repo-f/branch-f"
OUT="$(run_case_in "$H40" "$H40/.herdr/worktrees/repo-f/branch-f" '')"
check "a symlink out of the herdr root -> owner=none" '[ "$(get_val "$OUT" owner)" = "none" ]'

echo "Case 41: .. segments are resolved before the path is judged (R14)"
H41="$(new_home)"
mk_cli_declared "$H41" false false
WT41="$(mk_herdr_checkout "$H41" repo-g branch-g)"
mkdir -p "$H41/elsewhere"
OUT="$(run_case_arg "$H41" "$H41/.herdr/worktrees/repo-g/branch-g/../branch-g" '')"
check ".. that lands back inside -> owner=herdr" '[ "$(get_val "$OUT" owner)" = "herdr" ]'
OUT="$(run_case_arg "$H41" "$H41/.herdr/worktrees/../elsewhere" '')"
check ".. that climbs out -> owner=none"         '[ "$(get_val "$OUT" owner)" = "none" ]'

echo "Case 42: the root itself is not a checkout (R14)"
H42="$(new_home)"
mk_cli_declared "$H42" false false
mkdir -p "$H42/.herdr/worktrees" "$H42/orca/workspaces"
OUT="$(run_case_arg "$H42" "$H42/.herdr/worktrees" '')"
check "the herdr worktree root itself -> owner=none" '[ "$(get_val "$OUT" owner)" = "none" ]'
OUT="$(run_case_arg "$H42" "$H42/orca/workspaces" '')"
check "the orca workspaces root itself -> owner=none" '[ "$(get_val "$OUT" owner)" = "none" ]'

echo "Case 43: a sibling whose name merely starts with a root's name is not owned (R14)"
H43="$(new_home)"
mk_cli_declared "$H43" false false
mkdir -p "$H43/.herdr/worktrees-old/repo-h/branch-h"
mkdir -p "$H43/orca/workspaces-archive/project-d"
OUT="$(run_case_arg "$H43" "$H43/.herdr/worktrees-old/repo-h/branch-h" '')"
check ".herdr/worktrees-old is not the herdr root" '[ "$(get_val "$OUT" owner)" = "none" ]'
OUT="$(run_case_arg "$H43" "$H43/orca/workspaces-archive/project-d" '')"
check "orca/workspaces-archive is not the orca root" '[ "$(get_val "$OUT" owner)" = "none" ]'

# =========================================================================
# R15 – herdr's config names its own worktree root
#
# $HOME/.config/herdr/config.toml may set [worktrees] directory. When it
# does, that is the herdr root and the default one is not. A leading ~/ is
# the home directory.
# =========================================================================
echo "Case 44: config.toml moves the herdr root, and the default stops counting (R15)"
H44="$(new_home)"
mk_cli_declared "$H44" false false
mk_herdr_config "$H44" '~/custom/wt'
mkdir -p "$H44/custom/wt/repo-i/branch-i"
mkdir -p "$H44/.herdr/worktrees/repo-i/branch-i"
OUT="$(run_case_arg "$H44" "$H44/custom/wt/repo-i/branch-i" '')"
check "the configured root owns its checkouts"   '[ "$(get_val "$OUT" owner)" = "herdr" ]'
OUT="$(run_case_arg "$H44" "$H44/.herdr/worktrees/repo-i/branch-i" '')"
check "the default root no longer owns anything" '[ "$(get_val "$OUT" owner)" = "none" ]'

echo "Case 45: config.toml may name the root as an absolute path (R15)"
H45="$(new_home)"
mk_cli_declared "$H45" false false
mk_herdr_config "$H45" "$H45/abs/wt"
mkdir -p "$H45/abs/wt/repo-j/branch-j"
OUT="$(run_case_arg "$H45" "$H45/abs/wt/repo-j/branch-j" '')"
check "an absolute configured root owns its checkouts" '[ "$(get_val "$OUT" owner)" = "herdr" ]'

echo "Case 46: a config.toml without a [worktrees] section falls back to the default (R15)"
H46="$(new_home)"
mk_cli_declared "$H46" false false
mk_herdr_config_without_worktrees "$H46"
WT46="$(mk_herdr_checkout "$H46" repo-k branch-k)"
OUT="$(run_case_arg "$H46" "$WT46" '')"
check "the default root still owns its checkouts" '[ "$(get_val "$OUT" owner)" = "herdr" ]'

# =========================================================================
# R16 – both marker families at once, in a checkout somebody owns
#
# When both families are present the owner settles it outright, ahead of the
# declared booleans, and there is nothing ambiguous left to warn about.
# =========================================================================
echo "Case 47: both markers, orca owns the checkout, both declared true -> active=orca (R16)"
H47="$(new_home)"
mk_cli_declared "$H47" true true
WS47="$(mk_orca_checkout "$H47" project-e)"
OUT="$(run_case_in "$H47" "$WS47" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "owner=orca"                            '[ "$(get_val "$OUT" owner)" = "orca" ]'
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
check "active=orca"                           '[ "$(get_val "$OUT" active)" = "orca" ]'
check "warning is empty (nothing ambiguous)"  '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 48: both markers, herdr owns the checkout, both declared true -> active=herdr (R16)"
H48="$(new_home)"
mk_cli_declared "$H48" true true
WT48="$(mk_herdr_checkout "$H48" repo-l branch-l)"
OUT="$(run_case_in "$H48" "$WT48" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "owner=herdr"                           '[ "$(get_val "$OUT" owner)" = "herdr" ]'
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr"                          '[ "$(get_val "$OUT" active)" = "herdr" ]'
check "warning is empty (nothing ambiguous)"  '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 49: both markers, orca owns the checkout, only herdr declared true -> active=orca (R16)"
H49="$(new_home)"
mk_cli_declared "$H49" true false
WS49="$(mk_orca_checkout "$H49" project-f)"
OUT="$(run_case_in "$H49" "$WS49" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "active=orca (the owner outranks the declarations)" '[ "$(get_val "$OUT" active)" = "orca" ]'
WARN49="$(get_val "$OUT" warning)"
check "no ambiguity warning (it does not name both)" '! { printf "%s" "$WARN49" | grep -qi "herdr" && printf "%s" "$WARN49" | grep -qi "orca"; }'

echo "Case 50: both markers, herdr owns the checkout, only orca declared true -> active=herdr (R16)"
H50="$(new_home)"
mk_cli_declared "$H50" false true
WT50="$(mk_herdr_checkout "$H50" repo-m branch-m)"
OUT="$(run_case_in "$H50" "$WT50" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "active=herdr (the owner outranks the declarations)" '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN50="$(get_val "$OUT" warning)"
check "no ambiguity warning (it does not name both)" '! { printf "%s" "$WARN50" | grep -qi "herdr" && printf "%s" "$WARN50" | grep -qi "orca"; }'

echo "Case 51: both markers, orca owns the checkout, neither declared true -> active=orca (R16)"
H51="$(new_home)"
mk_cli_declared "$H51" false false
WS51="$(mk_orca_checkout "$H51" project-g)"
OUT="$(run_case_in "$H51" "$WS51" 'export HERDR_ENV=1 ORCA_PANE_KEY=key-1')"
check "active=orca"                           '[ "$(get_val "$OUT" active)" = "orca" ]'
WARN51="$(get_val "$OUT" warning)"
check "no ambiguity warning (it does not name both)" '! { printf "%s" "$WARN51" | grep -qi "herdr" && printf "%s" "$WARN51" | grep -qi "orca"; }'

# =========================================================================
# R17 – one marker family, or none, is unaffected by the owner
#
# The owner only ever settles a tie. A single family of markers is already
# unambiguous, and no markers at all means nothing is hosting this session,
# however the checkout is owned.
# =========================================================================
echo "Case 52: herdr markers only, inside an orca workspace -> active=herdr (R17)"
H52="$(new_home)"
mk_cli_declared "$H52" true false
WS52="$(mk_orca_checkout "$H52" project-h)"
OUT="$(run_case_in "$H52" "$WS52" 'export HERDR_ENV=1')"
check "owner=orca"                            '[ "$(get_val "$OUT" owner)" = "orca" ]'
check "detected=herdr"                        '[ "$(get_val "$OUT" detected)" = "herdr" ]'
check "active=herdr (markers beat the owner)" '[ "$(get_val "$OUT" active)" = "herdr" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 53: orca markers only, inside a herdr checkout -> active=orca (R17)"
H53="$(new_home)"
mk_cli_declared "$H53" false true
WT53="$(mk_herdr_checkout "$H53" repo-n branch-n)"
OUT="$(run_case_in "$H53" "$WT53" 'export ORCA_PANE_KEY=key-1')"
check "owner=herdr"                           '[ "$(get_val "$OUT" owner)" = "herdr" ]'
check "detected=orca"                         '[ "$(get_val "$OUT" detected)" = "orca" ]'
check "active=orca (markers beat the owner)"  '[ "$(get_val "$OUT" active)" = "orca" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

echo "Case 54: one family undeclared is still warned about, whoever owns the checkout (R17)"
H54="$(new_home)"
mk_cli_declared "$H54" false false
WS54="$(mk_orca_checkout "$H54" project-i)"
OUT="$(run_case_in "$H54" "$WS54" 'export HERDR_ENV=1')"
check "active=herdr"                          '[ "$(get_val "$OUT" active)" = "herdr" ]'
WARN54="$(get_val "$OUT" warning)"
check "warning names herdr"                   'printf "%s" "$WARN54" | grep -qi "herdr"'
check "warning mentions declaring"            'printf "%s" "$WARN54" | grep -qi "declare"'

echo "Case 55: no markers at all, inside a herdr checkout -> active=none (R17)"
H55="$(new_home)"
mk_cli_declared "$H55" true true
WT55="$(mk_herdr_checkout "$H55" repo-o branch-o)"
OUT="$(run_case_in "$H55" "$WT55" '')"
check "owner=herdr"                           '[ "$(get_val "$OUT" owner)" = "herdr" ]'
check "detected=none"                         '[ "$(get_val "$OUT" detected)" = "none" ]'
check "active=none (owning is not hosting)"   '[ "$(get_val "$OUT" active)" = "none" ]'
check "warning is empty"                      '[ -z "$(get_val "$OUT" warning)" ]'

# =========================================================================
# R18 – purity: working out the owner changes nothing on disk
# =========================================================================
echo "Case 56: a run from inside an owned git checkout writes nothing (R18)"
H56="$(new_home)"
mk_cli_declared "$H56" true true
WT56="$(mk_herdr_checkout "$H56" repo-p branch-p)"
git init -q "$WT56" 2>/dev/null
BEFORE_TREE56="$(find "$H56" | sort)"
BEFORE_GITCFG56="$(HOME="$H56" git config --global --list 2>/dev/null || true)"
(
  unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
  export HOME="$H56"
  cd "$WT56" || exit 1
  export HERDR_ENV=1 ORCA_PANE_KEY=key-1
  bash "$SUT" >/dev/null 2>/dev/null
)
AFTER_TREE56="$(find "$H56" | sort)"
AFTER_GITCFG56="$(HOME="$H56" git config --global --list 2>/dev/null || true)"
check "the whole HOME tree is unchanged"      '[ "$BEFORE_TREE56" = "$AFTER_TREE56" ]'
check "no global git config added"            '[ "$BEFORE_GITCFG56" = "$AFTER_GITCFG56" ]'

echo "Case 57: a run in a directory that is not a git repo creates no repository (R18)"
H57="$(new_home)"
mk_cli_declared "$H57" true false
WT57="$(mk_herdr_checkout "$H57" repo-q branch-q)"
(
  unset HERDR_ENV HERDR_PANE_ID ORCA_PANE_KEY
  export HOME="$H57"
  cd "$WT57" || exit 1
  bash "$SUT" >/dev/null 2>/dev/null
)
check "no .git directory was created"         '[ ! -e "$WT57/.git" ]'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
