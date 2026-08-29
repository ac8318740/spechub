#!/usr/bin/env bash
# Local test harness for install-orca.sh and install-herdr-block.sh.
#
# Both scripts install a dev setup on a fresh Linux machine, entirely under
# $HOME, with no root. Both have a plan mode that only prints and an apply mode
# that acts. This harness drives them hermetically: every external tool they
# reach for is either a small fake executable we control (which logs its argv
# so a test can assert on what was called) or is deliberately absent, so the
# result is fully determined by what each case wires up.
#
# The real machine this harness runs on already has herdr, orca-ide, curl,
# systemctl and a real ~/.config/herdr/config.toml. Nothing real may be
# touched, so PATH is built from scratch per case rather than inherited: only a
# curated whitelist of generic coreutils is let through from the real
# filesystem, and curl / systemctl / uname / sudo are deliberately NOT on that
# whitelist so that every case controls them via fakes or omission. HOME points
# at a private temp directory, so no network call, no systemctl against the
# real user bus and no write outside the temp dir is possible.
#
# Run it:  bash tests/test-host-install.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_ORCA="${SCRIPT_DIR}/../skills/host/install-orca.sh"
SCRIPT_HERDR="${SCRIPT_DIR}/../skills/host/install-herdr-block.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# Every check is about the observable behaviour of a script that was just run,
# so a check can never pass when the script under test is absent: RAN_OK is set
# by run_orca / run_herdr and gates the whole suite. Once both scripts exist
# this gate is a no-op.
RAN_OK=0
check() { if [ "${RAN_OK:-0}" = "1" ] && eval "$2"; then ok "$1"; else no "$1"; fi; }

# --- a curated "safe" PATH dir: generic coreutils the scripts may legitimately
# need internally, symlinked from the real filesystem. Deliberately excludes
# curl, systemctl, uname and sudo, so each case fully controls those. ---------
SAFE_TOOLS_DIR="$WORK/.safe-bin"
mkdir -p "$SAFE_TOOLS_DIR"
for name in bash sh cat grep egrep fgrep sed awk gawk cut tr wc dirname \
            basename readlink realpath env mktemp head tail sort uniq \
            find stat expr date id pwd ls tee xargs \
            mkdir rmdir cp mv rm ln chmod touch install \
            diff cmp sha256sum md5sum; do
  for d in /usr/bin /bin /usr/local/bin; do
    if [ -x "$d/$name" ] && [ ! -e "$SAFE_TOOLS_DIR/$name" ]; then
      ln -s "$d/$name" "$SAFE_TOOLS_DIR/$name"
    fi
  done
done

# ============================================================================
# Fixture builders (fakes)
# ============================================================================

# The platform gate's only input. Logs every invocation so "--help performs no
# detection" is assertable.
fake_uname() { # $1=dir $2=value $3=logfile
  cat > "$1/uname" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$3"
printf '%s\n' '$2'
exit 0
EOF
  chmod +x "$1/uname"
}

# Download fake. The success variant writes a known payload to the path given
# after -o / --output (and to stdout when neither is given, so a redirect-style
# download works too). The failure variant exits 7 and creates nothing. Both
# log their argv.
fake_curl() { # $1=dir $2=ok|fail $3=logfile
  if [ "$2" = "ok" ]; then
    cat > "$1/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$3"
out=""
prev=""
for a in "\$@"; do
  case "\$prev" in -o|--output) out="\$a" ;; esac
  case "\$a" in --output=*) out="\${a#--output=}" ;; esac
  prev="\$a"
done
if [ -n "\$out" ]; then
  mkdir -p "\$(dirname "\$out")"
  printf 'FAKE-ORCA-APPIMAGE-PAYLOAD\n' > "\$out"
else
  printf 'FAKE-ORCA-APPIMAGE-PAYLOAD\n'
fi
exit 0
EOF
  else
    cat > "$1/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$3"
exit 7
EOF
  fi
  chmod +x "$1/curl"
}

# Stateful systemctl fake: answers is-enabled / is-active from state files the
# case sets up, and updates them when enable/start runs, so an apply followed
# by a second apply sees the unit as already enabled and active. Logs argv.
fake_systemctl() { # $1=dir $2=logfile $3=statedir $4=enabled|disabled $5=active|inactive
  printf '%s\n' "$4" > "$3/systemctl.enabled"
  printf '%s\n' "$5" > "$3/systemctl.active"
  cat > "$1/systemctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$2"
SD='$3'
case " \$* " in
  *" is-enabled "*)
    v="\$(cat "\$SD/systemctl.enabled")"
    printf '%s\n' "\$v"
    if [ "\$v" = "enabled" ]; then exit 0; else exit 1; fi ;;
  *" is-active "*)
    v="\$(cat "\$SD/systemctl.active")"
    printf '%s\n' "\$v"
    if [ "\$v" = "active" ]; then exit 0; else exit 3; fi ;;
  *" enable "*)
    printf 'enabled\n' > "\$SD/systemctl.enabled"
    case " \$* " in *" --now "*) printf 'active\n' > "\$SD/systemctl.active" ;; esac
    exit 0 ;;
  *" start "*|*" restart "*)
    printf 'active\n' > "\$SD/systemctl.active"; exit 0 ;;
  *" disable "*)
    printf 'disabled\n' > "\$SD/systemctl.enabled"; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$1/systemctl"
}

# Journal reader. Prints the readiness block Orca emits when the server starts,
# with a recognisable pairing URL in it, and logs its argv.
fake_journalctl() { # $1=dir $2=logfile
  cat > "$1/journalctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$2"
printf '%s\n' 'Aug 23 05:00:00 host orca[4242]: starting orca server'
printf '%s\n' '{"event":"orca_server_ready","pairing":"orca://pair?code=TESTCODE123","port":6768}'
exit 0
EOF
  chmod +x "$1/journalctl"
}

# Present on PATH purely so that any attempt to escalate is recorded rather
# than failing with "command not found".
fake_sudo() { # $1=dir $2=logfile
  cat > "$1/sudo" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$2"
exit 0
EOF
  chmod +x "$1/sudo"
}

# ============================================================================
# Per-case environment
# ============================================================================
CN=0
RUNI=0
new_case() {
  CN=$((CN + 1))
  CASE="$WORK/c$CN"
  BIN="$CASE/bin"
  HOME_DIR="$CASE/home"
  CWD_DIR="$CASE/cwd"
  mkdir -p "$BIN" "$HOME_DIR" "$CWD_DIR"
  RUN_PATH="$BIN:$SAFE_TOOLS_DIR"
  RAN_OK=0

  UNAME_LOG="$CASE/uname.log"
  CURL_LOG="$CASE/curl.log"
  SYSCTL_LOG="$CASE/systemctl.log"
  SUDO_LOG="$CASE/sudo.log"
  JOURNALCTL_LOG="$CASE/journalctl.log"
  # Extra environment variables to let through `env -i`, as NAME=value words.
  ENV_EXTRA=()

  # Paths the contract fixes for install-orca.sh.
  APPIMG="$HOME_DIR/.local/opt/orca/orca-linux.AppImage"
  LINK_IDE="$HOME_DIR/.local/bin/orca-ide"
  LINK_ORCA="$HOME_DIR/.local/bin/orca"
  UNIT="$HOME_DIR/.config/systemd/user/orca.service"
  # Path the contract fixes for install-herdr-block.sh.
  CFG="$HOME_DIR/.config/herdr/config.toml"

  fake_uname "$BIN" "Linux" "$UNAME_LOG"
  fake_sudo "$BIN" "$SUDO_LOG"
}

with_systemctl() { # $1=enabled|disabled $2=active|inactive
  fake_systemctl "$BIN" "$SYSCTL_LOG" "$CASE" "$1" "$2"
}

with_journalctl() { fake_journalctl "$BIN" "$JOURNALCTL_LOG"; }

# Runs a script fully hermetically: only $RUN_PATH, $HOME_DIR and cwd=$CWD_DIR
# reach it. Everything else the real shell has is stripped by `env -i`.
# Sets $OUT, $EC, $ERR.
_run() { # $1=script, rest=args
  local script="$1"; shift
  RUNI=$((RUNI + 1))
  local stderr_file="$CASE/stderr.$RUNI"
  RAN_OK=0
  [ -f "$script" ] && RAN_OK=1
  OUT="$(cd "$CWD_DIR" && env -i PATH="$RUN_PATH" HOME="$HOME_DIR" "${ENV_EXTRA[@]}" bash "$script" "$@" 2>"$stderr_file")"
  EC=$?
  ERR="$(cat "$stderr_file" 2>/dev/null)"
}
run_orca()  { _run "$SCRIPT_ORCA" "$@"; }
run_herdr() { _run "$SCRIPT_HERDR" "$@"; }

# ============================================================================
# Assertion helpers
# ============================================================================

# Recursive content+size+symlink-target snapshot, for "writes nothing" and
# "same on-disk result" checks.
snapshot_dir() {
  find "$1" 2>/dev/null | sort | while read -r p; do
    if [ -L "$p" ]; then
      printf '%s|link|%s\n' "$p" "$(readlink "$p" 2>/dev/null)"
    elif [ -f "$p" ]; then
      printf '%s|%s|%s\n' "$p" "$(stat -c '%s' "$p" 2>/dev/null)" "$(sha256sum "$p" 2>/dev/null | cut -d' ' -f1)"
    else
      printf '%s|dir\n' "$p"
    fi
  done
}

# stdout assertions. out_lacks deliberately requires non-empty output, so an
# absence claim can never pass by the script printing nothing at all.
out_has()     { printf '%s\n' "$OUT" | grep -qF -- "$1"; }
out_lacks()   { [ -n "$OUT" ] && ! printf '%s\n' "$OUT" | grep -qF -- "$1"; }
out_matches() { printf '%s\n' "$OUT" | grep -Eq -- "$1"; }

# Combined stdout+stderr, for messages whose stream the contract leaves open.
msg()         { printf '%s\n%s\n' "$OUT" "$ERR"; }
msg_has()     { msg | grep -qF -- "$1"; }
msg_matches() { msg | grep -Eqi -- "$1"; }

# Step lines are numbered from 1 in a stable order, one line per step. This
# picks the line for step N, accepting the common numbering shapes:
#   "1. ...", "1) ...", "[1/5] ...", "Step 1: ...", "1 ..."
nth_line()  { printf '%s\n' "$OUT" | grep -E "^[[:space:]]*(\[|[Ss]tep )?$1[^0-9]" | head -1; }
step_has()  { nth_line "$1" | grep -qF -- "$2"; }
step_status_present() { nth_line "$1" | grep -Eq '\[(todo\]|done\]|skip:|skipped:)'; }
# The reason inside a step's [skip: ...] / [skipped: ...] bracket. A step that
# is not skipped at all has no reason, so this is never vacuously true.
step_reason_has() { nth_line "$1" | grep -Eq "\[skip(ped)?:[^]]*$2"; }
# True when ONE single line, other than step $1's own reported line, carries
# every one of the remaining substrings. Step $1's description may quote the
# same command, and other lines may mention parts of it, so requiring all the
# parts together on one other line is what tells a real separate hint from
# either of those.
hint_line_has_all() { # $1=step number, rest=substrings
  local step lines sub
  step="$(nth_line "$1")"
  lines="$(printf '%s\n' "$OUT" | grep -vxF -- "$step")"
  for sub in "${@:2}"; do
    lines="$(printf '%s\n' "$lines" | grep -F -- "$sub")"
    [ -n "$lines" ] || return 1
  done
  return 0
}

count_out() { printf '%s\n' "$OUT" | grep -cF -- "$1"; }

# A fake's argv log: absent entirely, or present without a given subcommand.
no_log()    { [ ! -f "$1" ]; }
log_has()   { [ -f "$1" ] && grep -qF -- "$2" "$1"; }
log_lacks() { [ ! -f "$1" ] || ! grep -qF -- "$2" "$1"; }
# Word-matching variants: plain substring matching cannot tell the query
# `is-enabled` apart from the state change `enable`.
log_has_word()   { [ -f "$1" ] && grep -qw -- "$2" "$1"; }
log_lacks_word() { [ ! -f "$1" ] || ! grep -qw -- "$2" "$1"; }
log_count()      { local n=0; [ -f "$1" ] && n="$(grep -cF -- "$2" "$1")"; printf '%s\n' "${n:-0}"; }
# A fake appends to one log for the whole case. Rotating it between runs lets a
# check speak about what a single run called, not the case's running total.
rotate_log()     { [ -f "$1" ] && mv -f "$1" "$1.$2"; return 0; }

file_has()   { [ -f "$1" ] && grep -qF -- "$2" "$1"; }
file_lacks() { [ -f "$1" ] && ! grep -qF -- "$2" "$1"; }
file_matches() { [ -f "$1" ] && grep -Eq -- "$2" "$1"; }

# Substrings must all be present in the file, each on a later line than the one
# before it.
lines_in_order() { # $1=file, rest=substrings
  local f="$1"; shift
  local prev=0 n s
  [ -f "$f" ] || return 1
  for s in "$@"; do
    n="$(grep -nF -- "$s" "$f" 2>/dev/null | head -1 | cut -d: -f1)"
    [ -n "$n" ] || return 1
    [ "$n" -gt "$prev" ] || return 1
    prev="$n"
  done
  return 0
}

sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# The managed block, exactly.
BLOCK_START='# >>> spechub terminal-workspace >>>'
BLOCK_END='# <<< spechub terminal-workspace <<<'
BLOCK_TABLE='[worktrees]'
BLOCK_DIR_DEFAULT='directory = "~/.herdr/worktrees"'
EXPECTED_BLOCK="$(printf '%s\n%s\n%s\n%s\n' "$BLOCK_START" "$BLOCK_TABLE" "$BLOCK_DIR_DEFAULT" "$BLOCK_END")"

block_text() { sed -n "/^# >>> spechub terminal-workspace >>>\$/,/^# <<< spechub terminal-workspace <<<\$/p" "$1" 2>/dev/null; }
block_is_exactly_default() { [ "$(block_text "$1")" = "$EXPECTED_BLOCK" ]; }
count_in_file() { local n=0; [ -f "$1" ] && n="$(grep -cF -- "$2" "$1")"; printf '%s\n' "${n:-0}"; }

# The block terminal-workspace setup.sh writes: the same two markers around
# [keys], one [[keys.command]] per binding, and [worktrees] at the end. Both
# scripts fence their block with these markers, so this is the block the herdr
# installer must never replace.
write_wide_block() { # $1=file, $2=worktrees directory
  mkdir -p "$(dirname "$1")"
  {
    printf '[ui]\nagent_panel_sort = "recent"\n\n'
    printf '%s\n' "$BLOCK_START"
    printf '[keys]\ngoto = "prefix+t"\n\n'
    printf '[[keys.command]]\nkey = "alt+g"\ncommand = "lazygit"\n\n'
    printf '%s\n' "$BLOCK_TABLE"
    printf 'directory = "%s"\n' "$2"
    printf '%s\n' "$BLOCK_END"
  } > "$1"
}

# The refusal message for a doubled block must name both blocks: either both
# start-marker line numbers, or a word meaning "more than one".
mentions_multiple_blocks() { # $1,$2 = the two start-marker line numbers
  if msg | grep -qw -- "$1" && msg | grep -qw -- "$2"; then
    return 0
  fi
  msg_matches 'more than one|multiple|twice|duplicat|two '
}

echo "Testing: $SCRIPT_ORCA"
echo "         $SCRIPT_HERDR"
echo "Workdir: $WORK"
if [ ! -f "$SCRIPT_ORCA" ] || [ ! -f "$SCRIPT_HERDR" ]; then
  echo ""
  echo "NOTE: one or both scripts under test do not exist yet."
  echo "      Every check below is expected to FAIL until they are written."
  [ -f "$SCRIPT_ORCA" ]  || echo "      missing: $SCRIPT_ORCA"
  [ -f "$SCRIPT_HERDR" ] || echo "      missing: $SCRIPT_HERDR"
fi
echo ""

# ############################################################################
# PART 1 - SHARED CONTRACT: invocation
# ############################################################################

echo "Case 1: install-orca.sh invocation"
new_case; with_systemctl disabled inactive
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --help
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --help exits 0"                          '[ "$EC" -eq 0 ]'
check "orca --help prints usage to stdout"           '[ -n "$OUT" ]'
check "orca --help performs no action"               '[ "$BEFORE" = "$AFTER" ]'
check "orca --help performs no detection (no uname)" 'no_log "$UNAME_LOG"'
check "orca --help runs no systemctl"                'no_log "$SYSCTL_LOG"'

new_case; with_systemctl disabled inactive
run_orca
check "orca with no mode exits 64"                   '[ "$EC" -eq 64 ]'
check "orca with no mode writes to stderr"           '[ -n "$ERR" ]'
check "orca with no mode writes nothing"             '[ ! -e "$UNIT" ]'

new_case; with_systemctl disabled inactive
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --plan --apply
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca with both modes exits 64"                '[ "$EC" -eq 64 ]'
check "orca with both modes writes to stderr"        '[ -n "$ERR" ]'
check "orca with both modes changes nothing"         '[ "$BEFORE" = "$AFTER" ]'

new_case; with_systemctl disabled inactive
run_orca --bogus-flag-nobody-defined
check "orca unknown argument exits 64"               '[ "$EC" -eq 64 ]'
check "orca unknown argument writes to stderr"       '[ -n "$ERR" ]'

new_case; with_systemctl disabled inactive
run_orca --plan --bogus-flag-nobody-defined
check "orca unknown argument beside --plan exits 64" '[ "$EC" -eq 64 ]'
check "orca unknown argument beside --plan errors"   '[ -n "$ERR" ]'

echo "Case 2: install-herdr-block.sh invocation"
new_case
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --help
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --help exits 0"                          '[ "$EC" -eq 0 ]'
check "herdr --help prints usage to stdout"           '[ -n "$OUT" ]'
check "herdr --help performs no action"               '[ "$BEFORE" = "$AFTER" ]'
check "herdr --help performs no detection (no uname)" 'no_log "$UNAME_LOG"'
check "herdr --help creates no config file"           '[ ! -e "$CFG" ]'

new_case
run_herdr
check "herdr with no mode exits 64"                   '[ "$EC" -eq 64 ]'
check "herdr with no mode writes to stderr"           '[ -n "$ERR" ]'
check "herdr with no mode creates no config"          '[ ! -e "$CFG" ]'

new_case
run_herdr --plan --apply
check "herdr with both modes exits 64"                '[ "$EC" -eq 64 ]'
check "herdr with both modes writes to stderr"        '[ -n "$ERR" ]'
check "herdr with both modes creates no config"       '[ ! -e "$CFG" ]'

new_case
run_herdr --bogus-flag-nobody-defined
check "herdr unknown argument exits 64"               '[ "$EC" -eq 64 ]'
check "herdr unknown argument writes to stderr"       '[ -n "$ERR" ]'

new_case
run_herdr --apply --bogus-flag-nobody-defined
check "herdr unknown argument beside --apply exits 64" '[ "$EC" -eq 64 ]'
check "herdr unknown argument beside --apply errors"   '[ -n "$ERR" ]'

# ############################################################################
# PART 2 - SHARED CONTRACT: platform gate (Linux only)
# ############################################################################

echo "Case 3: install-orca.sh platform gate"
new_case; with_systemctl disabled inactive
fake_uname "$BIN" "Darwin" "$UNAME_LOG"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --plan
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --plan on Darwin exits 3"                 '[ "$EC" -eq 3 ]'
check "orca --plan on Darwin prints to stdout"        '[ -n "$OUT" ]'
check "orca --plan on Darwin names the platform"      'out_has "Darwin"'
check "orca --plan on Darwin writes nothing"          '[ "$BEFORE" = "$AFTER" ]'

new_case; with_systemctl disabled inactive
fake_uname "$BIN" "Darwin" "$UNAME_LOG"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --apply --appimage-url https://example.invalid/orca.AppImage
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --apply on Darwin exits 3"                '[ "$EC" -eq 3 ]'
check "orca --apply on Darwin prints to stdout"       '[ -n "$OUT" ]'
check "orca --apply on Darwin names the platform"     'out_has "Darwin"'
check "orca --apply on Darwin writes nothing"         '[ "$BEFORE" = "$AFTER" ]'
check "orca --apply on Darwin runs no systemctl"      'no_log "$SYSCTL_LOG"'

new_case; with_systemctl disabled inactive
fake_uname "$BIN" "MINGW64_NT-10.0" "$UNAME_LOG"
run_orca --plan
check "orca --plan on MINGW64 exits 3"                '[ "$EC" -eq 3 ]'
check "orca --plan on MINGW64 names the platform"     'out_has "MINGW64_NT-10.0"'

new_case; with_systemctl disabled inactive
fake_uname "$BIN" "MINGW64_NT-10.0" "$UNAME_LOG"
run_orca --apply
check "orca --apply on MINGW64 exits 3"               '[ "$EC" -eq 3 ]'
check "orca --apply on MINGW64 names the platform"    'out_has "MINGW64_NT-10.0"'

echo "Case 4: install-herdr-block.sh platform gate"
new_case
fake_uname "$BIN" "Darwin" "$UNAME_LOG"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --plan
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --plan on Darwin exits 3"                '[ "$EC" -eq 3 ]'
check "herdr --plan on Darwin prints to stdout"       '[ -n "$OUT" ]'
check "herdr --plan on Darwin names the platform"     'out_has "Darwin"'
check "herdr --plan on Darwin writes nothing"         '[ "$BEFORE" = "$AFTER" ]'

new_case
fake_uname "$BIN" "Darwin" "$UNAME_LOG"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --apply
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --apply on Darwin exits 3"               '[ "$EC" -eq 3 ]'
check "herdr --apply on Darwin prints to stdout"      '[ -n "$OUT" ]'
check "herdr --apply on Darwin names the platform"    'out_has "Darwin"'
check "herdr --apply on Darwin creates no config"     '[ ! -e "$CFG" ]'
check "herdr --apply on Darwin writes nothing"        '[ "$BEFORE" = "$AFTER" ]'

new_case
fake_uname "$BIN" "MINGW64_NT-10.0" "$UNAME_LOG"
run_herdr --plan
check "herdr --plan on MINGW64 exits 3"               '[ "$EC" -eq 3 ]'
check "herdr --plan on MINGW64 names the platform"    'out_has "MINGW64_NT-10.0"'

new_case
fake_uname "$BIN" "MINGW64_NT-10.0" "$UNAME_LOG"
run_herdr --apply
check "herdr --apply on MINGW64 exits 3"              '[ "$EC" -eq 3 ]'
check "herdr --apply on MINGW64 names the platform"   'out_has "MINGW64_NT-10.0"'

# ############################################################################
# PART 3 - install-orca.sh
# ############################################################################

echo "Case 5: orca --plan on a bare host"
new_case; with_systemctl disabled inactive; with_journalctl
fake_curl "$BIN" ok "$CURL_LOG"
BEFORE="$(snapshot_dir "$HOME_DIR")"
BEFORE_CWD="$(snapshot_dir "$CWD_DIR")"
run_orca --plan --appimage-url https://example.invalid/orca.AppImage
AFTER="$(snapshot_dir "$HOME_DIR")"
AFTER_CWD="$(snapshot_dir "$CWD_DIR")"
check "orca --plan exits 0"                              '[ "$EC" -eq 0 ]'
check "step 1 is the AppImage placement"                 'step_has 1 "AppImage"'
check "step 1 is [todo] on a bare host"                  'step_has 1 "[todo]"'
check "step 2 is the orca-ide symlink"                   'step_has 2 "orca-ide"'
check "step 2 is [todo] on a bare host"                  'step_has 2 "[todo]"'
check "step 3 is the systemd unit"                       'step_has 3 "orca.service"'
check "step 3 is [todo] on a bare host"                  'step_has 3 "[todo]"'
check "step 4 is the enable step"                        'step_has 4 "enable"'
check "step 4 is [todo] on a bare host"                  'step_has 4 "[todo]"'
check "step 5 names journalctl"                          'step_has 5 "journalctl"'
check "step 5 names --user"                              'step_has 5 "--user"'
check "step 5 names orca"                                'step_has 5 "orca"'
check "step 5 carries a bracketed status"                'step_status_present 5'
check "plan never reads the journal"                     'no_log "$JOURNALCTL_LOG"'
check "plan prints no pairing URL"                       'out_lacks "orca://pair"'
check "plan states the ~/.claude/settings.json effect"   'out_has "~/.claude/settings.json"'
check "plan names the settings.json.bak backup"          'out_has "settings.json.bak"'
check "plan reports nothing as [done]"                   'out_lacks "[done]"'
check "plan never mentions sudo"                         'out_lacks "sudo"'
check "plan never invokes sudo"                          'no_log "$SUDO_LOG"'
check "plan downloads nothing"                           'no_log "$CURL_LOG"'
check "plan runs no daemon-reload"                       'log_lacks "$SYSCTL_LOG" "daemon-reload"'
check "plan runs no enable"                              'log_lacks_word "$SYSCTL_LOG" "enable"'
check "plan leaves HOME untouched"                       '[ "$BEFORE" = "$AFTER" ]'
check "plan leaves cwd untouched"                        '[ "$BEFORE_CWD" = "$AFTER_CWD" ]'
check "plan writes no AppImage"                          '[ ! -e "$APPIMG" ]'
check "plan writes no unit file"                         '[ ! -e "$UNIT" ]'
check "plan creates no symlinks"                         '[ ! -e "$LINK_IDE" ] && [ ! -e "$LINK_ORCA" ]'

echo "Case 6: orca --apply from a local --appimage-path"
new_case; with_systemctl disabled inactive; with_journalctl
fake_curl "$BIN" ok "$CURL_LOG"
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
BEFORE_CWD="$(snapshot_dir "$CWD_DIR")"
run_orca --apply --appimage-path "$SRC" --port 6768
AFTER_CWD="$(snapshot_dir "$CWD_DIR")"
check "orca --apply exits 0"                             '[ "$EC" -eq 0 ]'
check "AppImage lands at the contract path"              '[ -f "$APPIMG" ]'
check "AppImage is executable"                           '[ -x "$APPIMG" ]'
check "AppImage holds the source bytes"                  'cmp -s "$SRC" "$APPIMG"'
check "step 1 reports [done]"                            'step_has 1 "[done]"'
check "orca-ide symlink exists"                          '[ -L "$LINK_IDE" ]'
check "orca-ide points at the AppImage"                  '[ "$(readlink "$LINK_IDE")" = "$APPIMG" ]'
check "orca symlink exists"                              '[ -L "$LINK_ORCA" ]'
check "orca points at the AppImage"                      '[ "$(readlink "$LINK_ORCA")" = "$APPIMG" ]'
check "step 2 reports [done]"                            'step_has 2 "[done]"'
check "unit file lands at the contract path"             '[ -f "$UNIT" ]'
check "step 3 reports [done]"                            'step_has 3 "[done]"'
check "apply runs systemctl daemon-reload"               'log_has "$SYSCTL_LOG" "daemon-reload"'
check "apply runs systemctl --user"                      'log_has "$SYSCTL_LOG" "--user"'
check "apply enables the unit"                           'log_has_word "$SYSCTL_LOG" "enable"'
check "apply enables with --now"                         'log_has "$SYSCTL_LOG" "--now"'
check "apply restarts nothing that was never running"    'log_lacks_word "$SYSCTL_LOG" "restart"'
check "step 4 reports [done]"                            'step_has 4 "[done]"'
check "step 5 reads the journal"                         '[ -f "$JOURNALCTL_LOG" ]'
check "step 5 reads the journal for this user"           'log_has "$JOURNALCTL_LOG" "--user"'
check "step 5 names the unit it reads"                   'log_has "$JOURNALCTL_LOG" "orca.service"'
check "step 5 reads the journal with --no-pager"         'log_has "$JOURNALCTL_LOG" "--no-pager"'
check "step 5 prints the pairing URL it found"           'out_has "orca://pair?code=TESTCODE123"'
check "step 5 reports [done] after starting the server"  'step_has 5 "[done]"'
check "apply with a local path downloads nothing"        'no_log "$CURL_LOG"'
check "apply never mentions sudo"                        'out_lacks "sudo"'
check "apply never invokes sudo"                         'no_log "$SUDO_LOG"'
check "apply leaves cwd untouched"                       '[ "$BEFORE_CWD" = "$AFTER_CWD" ]'

echo "Case 7: the unit file written by Case 6"
check "unit has an ExecStart line"                       'file_has "$UNIT" "ExecStart="'
check "ExecStart wraps the command in /usr/bin/script"   'file_has "$UNIT" "/usr/bin/script -qec"'
check "ExecStart discards the pty log to /dev/null"      'file_has "$UNIT" "/dev/null"'
check "ExecStart names the AppImage path"                'file_has "$UNIT" "$APPIMG"'
check "ExecStart carries the serve subcommand"           'file_has "$UNIT" "serve"'
check "ExecStart carries the default --port 6768"        'file_has "$UNIT" "--port 6768"'
check "unit disables orca telemetry"                     'file_has "$UNIT" "Environment=ORCA_TELEMETRY_DISABLED=1"'
check "unit does not ship LIBGL_ALWAYS_SOFTWARE"         'file_lacks "$UNIT" "LIBGL_ALWAYS_SOFTWARE"'
check "unit has no --pairing-address when unset"         'file_lacks "$UNIT" "--pairing-address"'
check "unit has no --mobile-pairing when unset"          'file_lacks "$UNIT" "--mobile-pairing"'
check "unit has an [Install] section"                    'file_has "$UNIT" "[Install]"'
check "unit is wanted by default.target"                 'file_has "$UNIT" "WantedBy=default.target"'
check "unit restarts on failure"                         'file_has "$UNIT" "Restart=on-failure"'

echo "Case 8: orca --apply with every option set"
new_case; with_systemctl disabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC" --port 7100 \
         --pairing-address 100.64.0.5 --mobile-pairing
check "apply with all options exits 0"                   '[ "$EC" -eq 0 ]'
check "unit carries the chosen --port 7100"              'file_has "$UNIT" "--port 7100"'
check "unit omits the default port"                      'file_lacks "$UNIT" "--port 6768"'
check "unit carries --pairing-address 100.64.0.5"        'file_has "$UNIT" "--pairing-address 100.64.0.5"'
check "unit carries --mobile-pairing"                    'file_has "$UNIT" "--mobile-pairing"'
check "unit still disables telemetry"                    'file_has "$UNIT" "Environment=ORCA_TELEMETRY_DISABLED=1"'
check "unit still omits LIBGL_ALWAYS_SOFTWARE"           'file_lacks "$UNIT" "LIBGL_ALWAYS_SOFTWARE"'
check "unit still wraps the command in /usr/bin/script"  'file_has "$UNIT" "/usr/bin/script -qec"'

echo "Case 9: orca --apply downloading from --appimage-url"
new_case; with_systemctl disabled inactive
fake_curl "$BIN" ok "$CURL_LOG"
run_orca --apply --appimage-url https://example.invalid/orca-linux.AppImage
check "apply via URL exits 0"                            '[ "$EC" -eq 0 ]'
check "apply via URL calls curl"                         '[ -f "$CURL_LOG" ]'
check "curl is given the URL"                            'log_has "$CURL_LOG" "https://example.invalid/orca-linux.AppImage"'
check "downloaded AppImage lands at the contract path"   '[ -f "$APPIMG" ]'
check "downloaded AppImage is non-empty"                 '[ -s "$APPIMG" ]'
check "downloaded AppImage is executable"                '[ -x "$APPIMG" ]'
check "unit file is written after a good download"       '[ -f "$UNIT" ]'
check "step 1 reports [done] after a good download"      'step_has 1 "[done]"'

echo "Case 10: orca --apply when the download fails"
new_case; with_systemctl disabled inactive
fake_curl "$BIN" fail "$CURL_LOG"
run_orca --apply --appimage-url https://example.invalid/orca-linux.AppImage
check "a failed download exits non-zero"                 '[ "$EC" -ne 0 ]'
check "a failed download is reported"                    'msg_matches "fail|error|could not|unable"'
check "curl was actually attempted"                      '[ -f "$CURL_LOG" ]'
check "no unit file is written after a failed download"  '[ ! -e "$UNIT" ]'
check "the unit is not enabled after a failed download"  'log_lacks_word "$SYSCTL_LOG" "enable"'
check "no daemon-reload after a failed download"         'log_lacks "$SYSCTL_LOG" "daemon-reload"'
check "a failed download never escalates with sudo"      'no_log "$SUDO_LOG"'

echo "Case 11: orca --apply is idempotent"
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
EC1="$EC"
AFTER_FIRST="$(snapshot_dir "$HOME_DIR")"
rotate_log "$SYSCTL_LOG" 1
rotate_log "$JOURNALCTL_LOG" 1
run_orca --apply --appimage-path "$SRC"
AFTER_SECOND="$(snapshot_dir "$HOME_DIR")"
check "first apply exits 0"                              '[ "$EC1" -eq 0 ]'
check "first apply reloads the systemd daemon"           'log_has "$SYSCTL_LOG.1" "daemon-reload"'
check "first apply enables the unit"                     'log_has_word "$SYSCTL_LOG.1" "enable"'
check "second apply exits 0"                             '[ "$EC" -eq 0 ]'
check "second apply reports nothing as [done]"           'out_lacks "[done]"'
check "second apply skips every one of the 5 steps"      '[ "$(count_out "[skipped:")" -ge 5 ]'
check "second apply leaves the same on-disk result"      '[ "$AFTER_FIRST" = "$AFTER_SECOND" ]'
check "second apply runs no daemon-reload"               'log_lacks "$SYSCTL_LOG" "daemon-reload"'
check "second apply restarts nothing"                    'log_lacks_word "$SYSCTL_LOG" "restart"'
check "second apply enables nothing"                     'log_lacks_word "$SYSCTL_LOG" "enable"'
check "first apply read the journal"                     '[ -f "$JOURNALCTL_LOG.1" ]'
check "second apply reports step 5 as [skipped:]"        'step_has 5 "[skipped:"'
check "an untouched server's journal is not re-read"     'no_log "$JOURNALCTL_LOG"'
check "second apply still never uses sudo"               'no_log "$SUDO_LOG"'

echo "Case 12: orca --plan after a completed --apply"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --plan --appimage-path "$SRC"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "plan after apply exits 0"                         '[ "$EC" -eq 0 ]'
check "plan after apply reports nothing as [todo]"       'out_lacks "[todo]"'
check "plan after apply skips every one of the 5 steps"  '[ "$(count_out "[skip:")" -ge 5 ]'
check "plan after apply reports step 5 as [skip:]"       'step_has 5 "[skip:"'
check "plan after apply does not read the journal"       'no_log "$JOURNALCTL_LOG"'
check "plan after apply writes nothing"                  '[ "$BEFORE" = "$AFTER" ]'

echo "Case 13: orca step 1 skip conditions"
new_case; with_systemctl disabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
mkdir -p "$(dirname "$APPIMG")"
printf 'ALREADY-INSTALLED\n' > "$APPIMG"
chmod +x "$APPIMG"
run_orca --plan --appimage-path "$SRC"
check "an existing executable AppImage skips step 1"     'step_has 1 "[skip:"'
check "step 2 is still [todo] with no symlinks"          'step_has 2 "[todo]"'
check "step 3 is still [todo] with no unit"              'step_has 3 "[todo]"'

new_case; with_systemctl disabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
mkdir -p "$(dirname "$APPIMG")"
: > "$APPIMG"
chmod +x "$APPIMG"
run_orca --plan --appimage-path "$SRC"
check "an empty AppImage does not skip step 1"           'step_has 1 "[todo]"'

new_case; with_systemctl disabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
mkdir -p "$(dirname "$APPIMG")"
printf 'ALREADY-INSTALLED\n' > "$APPIMG"
chmod -x "$APPIMG"
run_orca --plan --appimage-path "$SRC"
check "a non-executable AppImage does not skip step 1"   'step_has 1 "[todo]"'

echo "Case 14: orca replaces a symlink pointing elsewhere"
new_case; with_systemctl disabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
mkdir -p "$HOME_DIR/.local/bin"
ln -s "$CASE/somewhere-else" "$LINK_IDE"
run_orca --apply --appimage-path "$SRC"
check "apply over a stale symlink exits 0"               '[ "$EC" -eq 0 ]'
check "step 2 reports [done] when a link was wrong"      'step_has 2 "[done]"'
check "orca-ide now points at the AppImage"              '[ "$(readlink "$LINK_IDE")" = "$APPIMG" ]'
check "orca now points at the AppImage"                  '[ "$(readlink "$LINK_ORCA")" = "$APPIMG" ]'

echo "Case 15: orca rewrites the unit when an option changes"
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC" --port 6768
check "first apply with --port 6768 exits 0"             '[ "$EC" -eq 0 ]'
check "unit carries --port 6768 after the first apply"   'file_has "$UNIT" "--port 6768"'
rotate_log "$SYSCTL_LOG" 1
rotate_log "$JOURNALCTL_LOG" 1
run_orca --apply --appimage-path "$SRC" --port 7000
check "second apply with --port 7000 exits 0"            '[ "$EC" -eq 0 ]'
check "step 3 reports [done] when the unit changed"      'step_has 3 "[done]"'
check "unit now carries --port 7000"                     'file_has "$UNIT" "--port 7000"'
check "unit no longer carries --port 6768"               'file_lacks "$UNIT" "--port 6768"'
check "step 1 is skipped on the second apply"            'step_has 1 "[skipped:"'
check "step 2 is skipped on the second apply"            'step_has 2 "[skipped:"'
# Step 4 cannot skip here: step 3 rewrote the unit in this same run, so the
# running server is still on the old one until systemd is told otherwise.
check "step 4 reports [done] when the unit was rewritten" 'step_has 4 "[done]"'
check "the rewrite reloads the systemd daemon"           'log_has "$SYSCTL_LOG" "daemon-reload"'
check "the rewrite restarts the running unit"            'log_has_word "$SYSCTL_LOG" "restart"'
check "the rewrite does not re-enable an enabled unit"   'log_lacks_word "$SYSCTL_LOG" "enable"'
check "a restarted server has its journal read again"    '[ -f "$JOURNALCTL_LOG" ]'
check "step 5 reports [done] after a restart"            'step_has 5 "[done]"'
check "step 5 prints the pairing URL after a restart"    'out_has "orca://pair?code=TESTCODE123"'

# Step 4 skips only when the unit is already enabled AND active AND step 3 did
# not write the unit file in this same run.
echo "Case 16: orca step 4 skip conditions"
new_case; with_systemctl enabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
check "enabled but inactive still runs step 4"           'step_has 4 "[done]"'
check "enabled but inactive calls systemctl enable"      'log_has_word "$SYSCTL_LOG" "enable"'
check "enabled but inactive enables with --now"          'log_has "$SYSCTL_LOG" "--now"'
check "enabled but inactive reloads the daemon"          'log_has "$SYSCTL_LOG" "daemon-reload"'

new_case; with_systemctl disabled active
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
check "active but disabled still runs step 4"            'step_has 4 "[done]"'
check "active but disabled calls systemctl enable"       'log_has_word "$SYSCTL_LOG" "enable"'
check "active but disabled enables with --now"           'log_has "$SYSCTL_LOG" "--now"'

new_case; with_systemctl enabled active
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --plan --appimage-path "$SRC"
check "enabled and active but no unit yet: step 3 [todo]" 'step_has 3 "[todo]"'
check "a planned unit write keeps step 4 [todo] too"      'step_has 4 "[todo]"'
check "planning an enabled unit still writes nothing"     '[ ! -e "$UNIT" ]'

# ############################################################################
# PART 4 - install-herdr-block.sh
# ############################################################################

echo "Case 17: herdr --plan when the config file is absent"
new_case
BEFORE="$(snapshot_dir "$HOME_DIR")"
BEFORE_CWD="$(snapshot_dir "$CWD_DIR")"
run_herdr --plan
AFTER="$(snapshot_dir "$HOME_DIR")"
AFTER_CWD="$(snapshot_dir "$CWD_DIR")"
check "plan on an absent config exits 0"                 '[ "$EC" -eq 0 ]'
check "plan names the default config path"               'out_has "$CFG"'
check "plan reports step 1 with a status"                'step_status_present 1'
check "plan reports work still to do"                    'out_has "[todo]"'
check "plan reports nothing as [done]"                   'out_lacks "[done]"'
check "plan creates no config file"                      '[ ! -e "$CFG" ]'
check "plan creates no config directory"                 '[ ! -e "$HOME_DIR/.config/herdr" ]'
check "plan leaves HOME untouched"                       '[ "$BEFORE" = "$AFTER" ]'
check "plan leaves cwd untouched"                        '[ "$BEFORE_CWD" = "$AFTER_CWD" ]'
check "plan never mentions sudo"                         'out_lacks "sudo"'
check "plan never invokes sudo"                          'no_log "$SUDO_LOG"'

echo "Case 18: herdr --apply when the config file is absent"
new_case
run_herdr --apply
check "apply on an absent config exits 0"                '[ "$EC" -eq 0 ]'
check "apply creates the parent directory"               '[ -d "$HOME_DIR/.config/herdr" ]'
check "apply creates the config file"                    '[ -f "$CFG" ]'
check "config carries the start marker"                  'file_has "$CFG" "$BLOCK_START"'
check "config carries the [worktrees] table"             'file_has "$CFG" "$BLOCK_TABLE"'
check "config carries the default directory line"        'file_has "$CFG" "$BLOCK_DIR_DEFAULT"'
check "config carries the end marker"                    'file_has "$CFG" "$BLOCK_END"'
check "the four block lines appear in order"             'lines_in_order "$CFG" "$BLOCK_START" "$BLOCK_TABLE" "$BLOCK_DIR_DEFAULT" "$BLOCK_END"'
check "the block is exactly the four contract lines"     'block_is_exactly_default "$CFG"'
check "the tilde path is written literally, unexpanded"  'file_lacks "$CFG" "$HOME_DIR/.herdr"'
check "apply reports the work as [done]"                 'out_has "[done]"'
check "apply never mentions sudo"                        'out_lacks "sudo"'
check "apply never invokes sudo"                         'no_log "$SUDO_LOG"'

echo "Case 19: herdr --apply on a config with no managed block"
new_case
mkdir -p "$(dirname "$CFG")"
cat > "$CFG" <<'FIXTURE'
# hand written herdr config
[theme]
name = "dark"
FIXTURE
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on a block-less config exits 0"              '[ "$EC" -eq 0 ]'
check "plan on a block-less config reports [todo]"       'out_has "[todo]"'
check "plan on a block-less config changes nothing"      '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a block-less config exits 0"             '[ "$EC" -eq 0 ]'
check "apply reports the work as [done]"                 'out_has "[done]"'
check "the leading comment survives"                     'file_has "$CFG" "# hand written herdr config"'
check "the [theme] table survives"                       'file_has "$CFG" "[theme]"'
check "the theme name survives"                          'file_has "$CFG" "name = \"dark\""'
check "pre-existing lines keep their original order"     'lines_in_order "$CFG" "# hand written herdr config" "[theme]" "name = \"dark\""'
check "the block is appended after existing content"     'lines_in_order "$CFG" "name = \"dark\"" "$BLOCK_START" "$BLOCK_END"'
check "the block is exactly the four contract lines"     'block_is_exactly_default "$CFG"'
check "exactly one start marker exists"                  '[ "$(count_in_file "$CFG" "$BLOCK_START")" -eq 1 ]'
check "exactly one end marker exists"                    '[ "$(count_in_file "$CFG" "$BLOCK_END")" -eq 1 ]'

echo "Case 20: herdr on a config whose block already matches"
new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '# top of file\n'
  printf '[theme]\nname = "dark"\n'
  printf '%s\n' "$BLOCK_START"
  printf '%s\n' "$BLOCK_TABLE"
  printf '%s\n' "$BLOCK_DIR_DEFAULT"
  printf '%s\n' "$BLOCK_END"
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on an up-to-date config exits 0"             '[ "$EC" -eq 0 ]'
check "plan on an up-to-date config reports [skip:"      'out_has "[skip:"'
check "plan on an up-to-date config has no [todo]"       'out_lacks "[todo]"'
check "plan on an up-to-date config changes nothing"     '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on an up-to-date config exits 0"            '[ "$EC" -eq 0 ]'
check "apply on an up-to-date config reports [skipped:"  'out_has "[skipped:"'
check "apply on an up-to-date config has no [done]"      'out_lacks "[done]"'
check "apply leaves the file byte-identical"             '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'

echo "Case 21: herdr replaces a stale managed block in place"
new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '# top comment\n'
  printf '[theme]\nname = "dark"\n'
  printf '%s\n' "$BLOCK_START"
  printf '[worktrees]\n'
  printf 'directory = "/old/place"\n'
  printf 'extra = true\n'
  printf '%s\n' "$BLOCK_END"
  printf '[tail]\nkeep = 1\n'
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on a stale block exits 0"                    '[ "$EC" -eq 0 ]'
check "plan on a stale block reports [todo]"             'out_has "[todo]"'
check "plan on a stale block changes nothing"            '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a stale block exits 0"                   '[ "$EC" -eq 0 ]'
check "apply on a stale block reports [done]"            'out_has "[done]"'
check "the stale directory value is gone"                'file_lacks "$CFG" "/old/place"'
check "the stale extra key is gone"                      'file_lacks "$CFG" "extra = true"'
check "the default directory line is present"            'file_has "$CFG" "$BLOCK_DIR_DEFAULT"'
check "the block holds only the four contract lines"     'block_is_exactly_default "$CFG"'
check "the leading comment survives"                     'file_has "$CFG" "# top comment"'
check "the [theme] table survives"                       'file_has "$CFG" "[theme]"'
check "the trailing [tail] table survives"               'file_has "$CFG" "[tail]"'
check "the trailing key survives"                        'file_has "$CFG" "keep = 1"'
check "content before and after the block keeps order"   'lines_in_order "$CFG" "# top comment" "[theme]" "$BLOCK_START" "$BLOCK_END" "[tail]" "keep = 1"'
check "still exactly one start marker"                   '[ "$(count_in_file "$CFG" "$BLOCK_START")" -eq 1 ]'
check "still exactly one end marker"                     '[ "$(count_in_file "$CFG" "$BLOCK_END")" -eq 1 ]'

echo "Case 22: herdr refuses a config with two managed blocks"
new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '# top comment\n'
  printf '%s\n' "$BLOCK_START"
  printf '[worktrees]\n'
  printf 'directory = "/first"\n'
  printf '%s\n' "$BLOCK_END"
  printf '[theme]\nname = "dark"\n'
  printf '%s\n' "$BLOCK_START"
  printf '[worktrees]\n'
  printf 'directory = "/second"\n'
  printf '%s\n' "$BLOCK_END"
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
FIRST_LN="$(grep -nF -- "$BLOCK_START" "$CFG" | head -1 | cut -d: -f1)"
SECOND_LN="$(grep -nF -- "$BLOCK_START" "$CFG" | tail -1 | cut -d: -f1)"
run_herdr --plan
check "plan on a doubled block exits 4"                  '[ "$EC" -eq 4 ]'
check "plan on a doubled block says something"           '[ -n "$OUT$ERR" ]'
check "plan names both blocks"                           'mentions_multiple_blocks "$FIRST_LN" "$SECOND_LN"'
check "plan on a doubled block changes nothing"          '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a doubled block exits 4"                 '[ "$EC" -eq 4 ]'
check "apply on a doubled block says something"          '[ -n "$OUT$ERR" ]'
check "apply names both blocks"                          'mentions_multiple_blocks "$FIRST_LN" "$SECOND_LN"'
check "apply on a doubled block changes nothing"         '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
check "apply on a doubled block adds no third block"     '[ "$(count_in_file "$CFG" "$BLOCK_START")" -eq 2 ]'

echo "Case 23: herdr refuses an unmanaged [worktrees] table"
new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '# top comment\n'
  printf '[worktrees]\n'
  printf 'directory = "/somewhere/else"\n'
  printf '[theme]\nname = "dark"\n'
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on an unmanaged [worktrees] exits 4"         '[ "$EC" -eq 4 ]'
check "plan on an unmanaged [worktrees] says something"  '[ -n "$OUT$ERR" ]'
check "plan names the [worktrees] table"                 'msg_has "[worktrees]"'
check "plan says the table would be defined twice"       'msg_matches "twice|duplicat|redefin|two [a-z]*definition"'
check "plan on an unmanaged [worktrees] changes nothing" '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on an unmanaged [worktrees] exits 4"        '[ "$EC" -eq 4 ]'
check "apply names the [worktrees] table"                'msg_has "[worktrees]"'
check "apply says the table would be defined twice"      'msg_matches "twice|duplicat|redefin|two [a-z]*definition"'
check "apply on an unmanaged [worktrees] writes nothing" '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
check "apply adds no managed block"                      'file_lacks "$CFG" "$BLOCK_START"'

echo "Case 24: herdr --worktree-dir overrides the directory line"
new_case
run_herdr --apply --worktree-dir /custom/path
check "apply with --worktree-dir exits 0"                '[ "$EC" -eq 0 ]'
check "the block carries the custom directory"           'file_has "$CFG" "directory = \"/custom/path\""'
check "the default directory is not written"             'file_lacks "$CFG" "~/.herdr/worktrees"'
check "the markers are still the managed ones"           'file_has "$CFG" "$BLOCK_START"'
check "the block still carries [worktrees]"              'file_has "$CFG" "$BLOCK_TABLE"'
check "the four block lines still appear in order"       'lines_in_order "$CFG" "$BLOCK_START" "$BLOCK_TABLE" "directory = \"/custom/path\"" "$BLOCK_END"'

new_case
run_herdr --plan --worktree-dir /custom/path
check "plan with --worktree-dir exits 0"                 '[ "$EC" -eq 0 ]'
check "plan with --worktree-dir writes nothing"          '[ ! -e "$CFG" ]'

echo "Case 25: herdr --config overrides the config path"
new_case
ALT="$HOME_DIR/elsewhere/herdr.toml"
run_herdr --apply --config "$ALT"
check "apply with --config exits 0"                      '[ "$EC" -eq 0 ]'
check "the chosen config file is created"                '[ -f "$ALT" ]'
check "the chosen config carries the block"              'block_is_exactly_default "$ALT"'
check "the default config path is left alone"            '[ ! -e "$CFG" ]'

new_case
ALT="$HOME_DIR/elsewhere/herdr.toml"
run_herdr --plan --config "$ALT"
check "plan with --config exits 0"                       '[ "$EC" -eq 0 ]'
check "plan with --config names the chosen path"         'out_has "$ALT"'
check "plan with --config writes nothing"                '[ ! -e "$ALT" ]'

echo "Case 26: herdr --apply is idempotent"
new_case
run_herdr --apply
EC1="$EC"
AFTER_FIRST="$(snapshot_dir "$HOME_DIR")"
SHA_FIRST="$(sha "$CFG")"
run_herdr --apply
AFTER_SECOND="$(snapshot_dir "$HOME_DIR")"
check "first apply exits 0"                              '[ "$EC1" -eq 0 ]'
check "second apply exits 0"                             '[ "$EC" -eq 0 ]'
check "second apply reports nothing as [done]"           'out_lacks "[done]"'
check "second apply reports a [skipped: ...] step"       'out_has "[skipped:"'
check "second apply leaves the file byte-identical"      '[ "$(sha "$CFG")" = "$SHA_FIRST" ]'
check "second apply leaves the same on-disk result"      '[ "$AFTER_FIRST" = "$AFTER_SECOND" ]'
check "second apply adds no second block"                '[ "$(count_in_file "$CFG" "$BLOCK_START")" -eq 1 ]'

echo "Case 27: herdr --plan after a completed --apply"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --plan
AFTER="$(snapshot_dir "$HOME_DIR")"
check "plan after apply exits 0"                         '[ "$EC" -eq 0 ]'
check "plan after apply reports nothing as [todo]"       'out_lacks "[todo]"'
check "plan after apply reports a [skip: ...] step"      'out_has "[skip:"'
check "plan after apply writes nothing"                  '[ "$BEFORE" = "$AFTER" ]'

echo "Case 28: orca step 5 when journalctl is not installed"
# journalctl is deliberately absent from PATH here. Reading the journal is a
# convenience, not the install, so a missing reader must not fail the run.
new_case; with_systemctl disabled inactive
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
check "a missing journalctl does not fail the run"       '[ "$EC" -eq 0 ]'
check "steps 1 to 4 still complete without journalctl"   'step_has 4 "[done]"'
check "the unit file is still written"                   '[ -f "$UNIT" ]'
check "step 5 is skipped when journalctl is missing"     'step_has 5 "[skipped:"'
check "the skip reason names the missing tool"           'step_reason_has 5 "journalctl"'
check "the command to run by hand is printed"            'step_has 5 "[skipped:" && hint_line_has_all 5 "journalctl" "--user" "--no-pager"'
check "the by-hand hint names the unit it reads"         'step_has 5 "[skipped:" && hint_line_has_all 5 "journalctl" "orca.service"'
check "no pairing URL is invented when none was read"    'out_lacks "orca://pair"'

# ############################################################################
# PART 5 - the Windows Subsystem for Linux is not supported
#
# The Windows Subsystem for Linux is a Linux environment running on Windows. It
# reports `Linux` from `uname -s`, so the platform gate alone lets it through,
# and neither systemd user units nor an AppImage behave there the way this
# install assumes. Two markers give it away: the WSL_DISTRO_NAME environment
# variable, and the word microsoft in /proc/sys/kernel/osrelease. The osrelease
# path comes from --osrelease-file so a test can supply its own.
# ############################################################################

echo "Case 29: orca refuses WSL named by WSL_DISTRO_NAME"
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
ENV_EXTRA=(WSL_DISTRO_NAME="Ubuntu-22.04")
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --plan
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --plan under WSL exits 3"                    '[ "$EC" -eq 3 ]'
check "orca --plan under WSL says something"             '[ "$EC" -eq 3 ] && [ -n "$OUT$ERR" ]'
check "orca --plan under WSL names the environment"      'msg_matches "WSL|Windows Subsystem"'
check "orca --plan under WSL writes nothing"             '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --apply --appimage-path "$SRC"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --apply under WSL exits 3"                   '[ "$EC" -eq 3 ]'
check "orca --apply under WSL names the environment"     'msg_matches "WSL|Windows Subsystem"'
check "orca --apply under WSL writes nothing"            '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
check "orca --apply under WSL installs no AppImage"      '[ "$EC" -eq 3 ] && [ ! -e "$APPIMG" ]'
check "orca --apply under WSL runs no systemctl"         '[ "$EC" -eq 3 ] && no_log "$SYSCTL_LOG"'

echo "Case 30: herdr refuses WSL named by WSL_DISTRO_NAME"
new_case
ENV_EXTRA=(WSL_DISTRO_NAME="Ubuntu-22.04")
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --plan
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --plan under WSL exits 3"                   '[ "$EC" -eq 3 ]'
check "herdr --plan under WSL says something"            '[ "$EC" -eq 3 ] && [ -n "$OUT$ERR" ]'
check "herdr --plan under WSL names the environment"     'msg_matches "WSL|Windows Subsystem"'
check "herdr --plan under WSL writes nothing"            '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
run_herdr --apply
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --apply under WSL exits 3"                  '[ "$EC" -eq 3 ]'
check "herdr --apply under WSL names the environment"    'msg_matches "WSL|Windows Subsystem"'
check "herdr --apply under WSL creates no config"        '[ "$EC" -eq 3 ] && [ ! -e "$CFG" ]'
check "herdr --apply under WSL writes nothing"           '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'

echo "Case 31: orca refuses WSL named by the osrelease file"
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
OSR="$CASE/osrelease-wsl"
printf '5.15.146.1-microsoft-standard-WSL2\n' > "$OSR"
OSR_CAPS="$CASE/osrelease-wsl-caps"
printf '4.4.0-19041-Microsoft\n' > "$OSR_CAPS"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --plan --osrelease-file "$OSR"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --plan on a microsoft osrelease exits 3"     '[ "$EC" -eq 3 ]'
check "orca --plan on a microsoft osrelease explains"    'msg_matches "WSL|Windows Subsystem"'
check "orca --plan on a microsoft osrelease writes none" '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --apply --osrelease-file "$OSR" --appimage-path "$SRC"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "orca --apply on a microsoft osrelease exits 3"    '[ "$EC" -eq 3 ]'
check "orca --apply on a microsoft osrelease writes none" '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
check "orca --apply on a microsoft osrelease no systemctl" '[ "$EC" -eq 3 ] && no_log "$SYSCTL_LOG"'
run_orca --plan --osrelease-file "$OSR_CAPS"
check "a capitalised Microsoft is detected too"          '[ "$EC" -eq 3 ]'
check "the capitalised case explains itself too"         'msg_matches "WSL|Windows Subsystem"'

echo "Case 32: herdr refuses WSL named by the osrelease file"
new_case
OSR="$CASE/osrelease-wsl"
printf '5.15.146.1-microsoft-standard-WSL2\n' > "$OSR"
OSR_CAPS="$CASE/osrelease-wsl-caps"
printf '4.4.0-19041-Microsoft\n' > "$OSR_CAPS"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --plan --osrelease-file "$OSR"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --plan on a microsoft osrelease exits 3"    '[ "$EC" -eq 3 ]'
check "herdr --plan on a microsoft osrelease explains"   'msg_matches "WSL|Windows Subsystem"'
check "herdr --plan on a microsoft osrelease writes none" '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
run_herdr --apply --osrelease-file "$OSR"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "herdr --apply on a microsoft osrelease exits 3"   '[ "$EC" -eq 3 ]'
check "herdr --apply on a microsoft osrelease writes none" '[ "$EC" -eq 3 ] && [ "$BEFORE" = "$AFTER" ]'
check "herdr --apply on a microsoft osrelease no config"  '[ "$EC" -eq 3 ] && [ ! -e "$CFG" ]'
run_herdr --plan --osrelease-file "$OSR_CAPS"
check "a capitalised Microsoft is detected by herdr too" '[ "$EC" -eq 3 ]'

echo "Case 33: a plain Linux host is untouched by the WSL checks"
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
OSR_OK="$CASE/osrelease-plain"
printf '6.8.0-138-generic\n' > "$OSR_OK"
ENV_EXTRA=(WSL_DISTRO_NAME="")
run_orca --plan --osrelease-file "$OSR_OK"
check "an empty WSL_DISTRO_NAME does not count as set"   '[ "$EC" -eq 0 ]'
check "a plain osrelease file still plans the install"   'step_has 1 "[todo]"'
run_orca --apply --osrelease-file "$OSR_OK" --appimage-path "$SRC"
check "a plain Linux host still applies"                 '[ "$EC" -eq 0 ]'
check "the AppImage installs on a plain Linux host"      '[ -f "$APPIMG" ]'
check "the unit installs on a plain Linux host"          '[ -f "$UNIT" ]'

new_case
OSR_OK="$CASE/osrelease-plain"
printf '6.8.0-138-generic\n' > "$OSR_OK"
ENV_EXTRA=(WSL_DISTRO_NAME="")
run_herdr --plan --osrelease-file "$OSR_OK"
check "herdr plans normally on a plain Linux host"       '[ "$EC" -eq 0 ]'
run_herdr --apply --osrelease-file "$OSR_OK"
check "herdr applies normally on a plain Linux host"     '[ "$EC" -eq 0 ]'
check "herdr writes the block on a plain Linux host"     'block_is_exactly_default "$CFG"'

new_case; with_systemctl disabled inactive; with_journalctl
ENV_EXTRA=(WSL_DISTRO_NAME="")
run_orca --plan
check "an empty WSL_DISTRO_NAME alone still plans"       '[ "$EC" -eq 0 ]'
run_herdr --plan
check "an empty WSL_DISTRO_NAME alone still plans herdr" '[ "$EC" -eq 0 ]'

# An osrelease file that is not there says nothing about the environment. A
# machine with no /proc/sys/kernel/osrelease is not the Windows Subsystem for
# Linux, so the run carries on rather than refusing on a missing file.
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
MISSING_OSR="$CASE/no-such-osrelease"
run_orca --plan --osrelease-file "$MISSING_OSR"
check "orca plans on when the osrelease file is absent"  '[ "$EC" -eq 0 ]'
check "an absent osrelease file still plans the install" 'step_has 1 "[todo]"'
run_orca --apply --osrelease-file "$MISSING_OSR" --appimage-path "$SRC"
check "orca applies when the osrelease file is absent"   '[ "$EC" -eq 0 ]'
check "the AppImage installs with no osrelease file"     '[ -f "$APPIMG" ]'
run_herdr --plan --osrelease-file "$MISSING_OSR"
check "herdr plans on when the osrelease file is absent" '[ "$EC" -eq 0 ]'
run_herdr --apply --osrelease-file "$MISSING_OSR"
check "herdr applies when the osrelease file is absent"  '[ "$EC" -eq 0 ]'
check "herdr writes the block with no osrelease file"    'block_is_exactly_default "$CFG"'

# ############################################################################
# PART 6 - guard branches
# ############################################################################

echo "Case 34: herdr refuses a config path that is not a regular file"
new_case
NOTAFILE="$HOME_DIR/notafile.toml"
mkdir -p "$NOTAFILE"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_herdr --plan --config "$NOTAFILE"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "plan on a directory config exits 4"               '[ "$EC" -eq 4 ]'
check "plan on a directory config says why"              '[ -n "$OUT$ERR" ]'
check "plan on a directory config names the path"        'msg_has "$NOTAFILE"'
check "plan on a directory config changes nothing"       '[ "$BEFORE" = "$AFTER" ]'
run_herdr --apply --config "$NOTAFILE"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "apply on a directory config exits 4"              '[ "$EC" -eq 4 ]'
check "apply on a directory config says why"             '[ -n "$OUT$ERR" ]'
check "apply on a directory config changes nothing"      '[ "$BEFORE" = "$AFTER" ]'
check "apply writes nothing inside that directory"       '[ -z "$(ls -A "$NOTAFILE")" ]'

echo "Case 35: herdr refuses a fence that does not pair up"
new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '# top comment\n'
  printf '%s\n' "$BLOCK_START"
  printf '[worktrees]\n'
  printf 'directory = "/x"\n'
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on a block that never closes exits 4"        '[ "$EC" -eq 4 ]'
check "plan on a block that never closes says why"       '[ -n "$OUT$ERR" ]'
check "plan on a block that never closes changes none"   '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a block that never closes exits 4"       '[ "$EC" -eq 4 ]'
check "apply on a block that never closes changes none"  '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
check "apply on a block that never closes adds no end"   '[ "$(count_in_file "$CFG" "$BLOCK_END")" -eq 0 ]'

new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '# top comment\n'
  printf '%s\n' "$BLOCK_END"
  printf '[theme]\nname = "dark"\n'
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on a stray end marker exits 4"               '[ "$EC" -eq 4 ]'
check "plan on a stray end marker says why"              '[ -n "$OUT$ERR" ]'
check "plan on a stray end marker changes nothing"       '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a stray end marker exits 4"              '[ "$EC" -eq 4 ]'
check "apply on a stray end marker changes nothing"      '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'

new_case
mkdir -p "$(dirname "$CFG")"
{
  printf '%s\n' "$BLOCK_END"
  printf '# middle\n'
  printf '%s\n' "$BLOCK_START"
  printf '[worktrees]\n'
} > "$CFG"
BEFORE_SHA="$(sha "$CFG")"
run_herdr --apply
check "apply on a closed-then-opened fence exits 4"      '[ "$EC" -eq 4 ]'
check "apply on a closed-then-opened fence changes none" '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'

echo "Case 36: orca rejects a --pairing-address holding a forbidden character"
for BAD in "100.64.0.5 rm" "100.64.0.5/24" "100.64.0.5;reboot"; do
  new_case; with_systemctl disabled inactive; with_journalctl
  SRC="$CASE/source-orca.AppImage"
  printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
  BEFORE="$(snapshot_dir "$HOME_DIR")"
  run_orca --apply --appimage-path "$SRC" --pairing-address "$BAD"
  AFTER="$(snapshot_dir "$HOME_DIR")"
  check "--pairing-address [$BAD] exits 64"              '[ "$EC" -eq 64 ]'
  check "--pairing-address [$BAD] writes to stderr"      '[ -n "$ERR" ]'
  check "--pairing-address [$BAD] changes nothing"       '[ "$BEFORE" = "$AFTER" ]'
  check "--pairing-address [$BAD] writes no unit"        '[ ! -e "$UNIT" ]'
  check "--pairing-address [$BAD] runs no systemctl"     'no_log "$SYSCTL_LOG"'
done

# The guard must reject bad input without rejecting good input.
for GOOD in "100.80.93.45" "dev-vm.tail1234.ts.net"; do
  new_case; with_systemctl disabled inactive; with_journalctl
  SRC="$CASE/source-orca.AppImage"
  printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
  run_orca --apply --appimage-path "$SRC" --pairing-address "$GOOD"
  check "--pairing-address [$GOOD] is accepted"          '[ "$EC" -eq 0 ]'
  check "--pairing-address [$GOOD] reaches the unit"     'file_has "$UNIT" "--pairing-address $GOOD"'
done

echo "Case 37: orca fails up front when systemctl is missing"
new_case; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
BEFORE="$(snapshot_dir "$HOME_DIR")"
run_orca --apply --appimage-path "$SRC"
AFTER="$(snapshot_dir "$HOME_DIR")"
check "a missing systemctl fails the run"                '[ "$EC" -ne 0 ]'
check "a missing systemctl is explained on stderr"       '[ -n "$ERR" ]'
check "the message names systemctl"                      'msg_has "systemctl"'
check "no unit file is written without systemctl"        '[ ! -e "$UNIT" ]'
check "no AppImage is installed without systemctl"       '[ ! -e "$APPIMG" ]'
check "no symlinks are created without systemctl"        '[ ! -e "$LINK_IDE" ] && [ ! -e "$LINK_ORCA" ]'
check "nothing under HOME changes without systemctl"     '[ "$BEFORE" = "$AFTER" ]'

echo "Case 38: orca fails up front when curl is missing and no local AppImage is given"
new_case; with_systemctl disabled inactive; with_journalctl
run_orca --apply --appimage-url https://example.invalid/orca-linux.AppImage
check "a missing curl fails the run"                     '[ "$EC" -ne 0 ]'
check "a missing curl is explained on stderr"            '[ -n "$ERR" ]'
# Naming curl alone is not enough: with no guard at all, the shell's own
# "curl: command not found" names it too. The guard is what tells the user the
# way out, so that is what is pinned.
check "the message names curl and the way around it"     'msg_has "curl" && msg_has "--appimage-path"'
check "no AppImage is installed without curl"            '[ ! -e "$APPIMG" ]'
check "no symlinks are created without curl"             '[ ! -e "$LINK_IDE" ] && [ ! -e "$LINK_ORCA" ]'
check "no unit file is written without curl"             '[ ! -e "$UNIT" ]'
check "the unit is never enabled without curl"           'log_lacks_word "$SYSCTL_LOG" "enable"'

echo "Case 39: orca repairs a half-broken symlink pair"
# Step 2 owns two links. A pair where one is right and the other is not is the
# state a check on only one of them cannot see: it reports the pair as already
# correct and leaves a broken install behind. Each variant below starts from a
# completed install and breaks exactly one link.

# 39a: orca is missing, orca-ide is correct.
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
rm -f "$LINK_ORCA"
run_orca --apply --appimage-path "$SRC"
check "a missing orca link makes step 2 work again"      'step_has 2 "[done]"'
check "the missing orca link is restored"                '[ -L "$LINK_ORCA" ]'
check "the restored orca link points at the AppImage"    '[ "$(readlink "$LINK_ORCA")" = "$APPIMG" ]'
check "the intact orca-ide link still points there"      '[ "$(readlink "$LINK_IDE")" = "$APPIMG" ]'
check "repairing a link does not redo the AppImage"      'step_has 1 "[skipped:"'
check "repairing a link does not rewrite the unit"       'step_has 3 "[skipped:"'

# 39b: orca points somewhere else, orca-ide is correct.
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
ln -sfn "$CASE/somewhere-else" "$LINK_ORCA"
run_orca --apply --appimage-path "$SRC"
check "a wrong orca link makes step 2 work again"        'step_has 2 "[done]"'
check "the wrong orca link is repointed at the AppImage" '[ "$(readlink "$LINK_ORCA")" = "$APPIMG" ]'
check "the intact orca-ide link is left pointing there"  '[ "$(readlink "$LINK_IDE")" = "$APPIMG" ]'

# 39c: the mirror. orca-ide is missing, orca is correct.
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
rm -f "$LINK_IDE"
run_orca --apply --appimage-path "$SRC"
check "a missing orca-ide link makes step 2 work again"  'step_has 2 "[done]"'
check "the missing orca-ide link is restored"            '[ -L "$LINK_IDE" ]'
check "the restored orca-ide link points at the AppImage" '[ "$(readlink "$LINK_IDE")" = "$APPIMG" ]'
check "the intact orca link still points there"          '[ "$(readlink "$LINK_ORCA")" = "$APPIMG" ]'

# 39d: the mirror. orca-ide points somewhere else, orca is correct.
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
ln -sfn "$CASE/somewhere-else" "$LINK_IDE"
run_orca --apply --appimage-path "$SRC"
check "a wrong orca-ide link makes step 2 work again"    'step_has 2 "[done]"'
check "the wrong orca-ide link is repointed"             '[ "$(readlink "$LINK_IDE")" = "$APPIMG" ]'
check "the intact orca link is left pointing there"      '[ "$(readlink "$LINK_ORCA")" = "$APPIMG" ]'

# 39e: a half-broken pair must never be reported as already correct.
new_case; with_systemctl disabled inactive; with_journalctl
SRC="$CASE/source-orca.AppImage"
printf 'LOCAL-APPIMAGE-BYTES\n' > "$SRC"
run_orca --apply --appimage-path "$SRC"
rm -f "$LINK_ORCA"
run_orca --plan --appimage-path "$SRC"
check "plan sees a half-broken pair as work to do"       'step_has 2 "[todo]"'
check "plan on a half-broken pair repairs nothing"       '[ ! -e "$LINK_ORCA" ]'

echo "Case 40: herdr leaves a terminal-workspace block that already sets the directory"
new_case
write_wide_block "$CFG" '~/.herdr/worktrees'
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on a wide block that agrees exits 0"         '[ "$EC" -eq 0 ]'
check "plan on a wide block that agrees reports [skip:"  'out_has "[skip:"'
check "plan on a wide block that agrees has no [todo]"   'out_lacks "[todo]"'
check "plan on a wide block that agrees changes nothing" '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a wide block that agrees exits 0"        '[ "$EC" -eq 0 ]'
check "apply on a wide block that agrees skips"          'out_has "[skipped:"'
check "apply leaves the wide block byte-identical"       '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
check "the keymap survives"                              'file_has "$CFG" "goto = \"prefix+t\""'
check "the popup key binding survives"                   'file_has "$CFG" "command = \"lazygit\""'

echo "Case 41: herdr refuses a terminal-workspace block naming another directory"
new_case
write_wide_block "$CFG" '/somewhere/else'
BEFORE_SHA="$(sha "$CFG")"
run_herdr --plan
check "plan on a wide block that disagrees exits 4"      '[ "$EC" -eq 4 ]'
check "plan names the tables it does not own"            'msg_has "[keys]"'
check "plan points at terminal-workspace setup.sh"       'msg_has "setup.sh"'
check "plan on a wide block that disagrees writes none"  '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
run_herdr --apply
check "apply on a wide block that disagrees exits 4"     '[ "$EC" -eq 4 ]'
check "apply on a wide block that disagrees writes none" '[ "$(sha "$CFG")" = "$BEFORE_SHA" ]'
check "the keymap survives the refusal"                  'file_has "$CFG" "goto = \"prefix+t\""'
check "the popup binding survives the refusal"           'file_has "$CFG" "command = \"lazygit\""'
check "the other directory is left in place"             'file_has "$CFG" "directory = \"/somewhere/else\""'
check "no second block is appended"                      '[ "$(count_in_file "$CFG" "$BLOCK_START")" -eq 1 ]'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
