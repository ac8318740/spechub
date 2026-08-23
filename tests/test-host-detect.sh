#!/usr/bin/env bash
# Local test harness for detect-host.sh.
#
# detect-host.sh reports, as one JSON object, what dev-setup tooling exists on
# the machine it runs on (orchestrator, browser, tailscale preview, element
# picker, orca topology, claude settings, project). It is read-only. This
# harness drives it hermetically: every tool it looks up on PATH is either a
# small fake executable we control, or deliberately absent, so the result is
# fully determined by what each case wires up. The real dev machine this
# harness runs on already has herdr/orca/agent-browser/tailscale/stagewise/
# chrome installed, so PATH is built from scratch per case rather than
# inherited, and only a curated whitelist of generic coreutils (plus git) is
# ever let through from the real filesystem.
#
# Run it:  bash tests/test-host-detect.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/../skills/host/detect-host.sh"

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

# --- jq-backed JSON assertion helpers (operate on $OUT) -----------------------
JQ=/usr/bin/jq
[ -x "$JQ" ] || JQ="jq"
jval()      { printf '%s' "$OUT" | "$JQ" -r "$1" 2>/dev/null; }
jraw()      { printf '%s' "$OUT" | "$JQ" -c "$1" 2>/dev/null; }
valid_json(){ printf '%s' "$OUT" | "$JQ" -e . >/dev/null 2>&1; }
field_is()  { [ "$(jval "$1")" = "$2" ]; }
array_is()  { [ "$(jraw "$1")" = "$2" ]; }

# --- a curated "safe" PATH dir: generic coreutils the script may legitimately
# need internally, symlinked from the real filesystem. Deliberately excludes
# every tool this contract detects (herdr, orca[-ide], agent-browser,
# tailscale, stagewise, the browsers, curl, systemctl) and jq, so each case
# fully controls those via fakes or omission. -----------------------------
SAFE_TOOLS_DIR="$WORK/.safe-bin"
mkdir -p "$SAFE_TOOLS_DIR"
for name in bash sh cat grep egrep fgrep sed awk gawk cut tr wc dirname \
            basename readlink realpath env uname mktemp head tail sort \
            find stat expr date id pwd git; do
  for d in /usr/bin /bin /usr/local/bin; do
    if [ -x "$d/$name" ] && [ ! -e "$SAFE_TOOLS_DIR/$name" ]; then
      ln -s "$d/$name" "$SAFE_TOOLS_DIR/$name"
    fi
  done
done

# --- fixture builders -----------------------------------------------------
# A trivial "the tool exists and does nothing interesting" fake.
fake_simple() { # $1=dir $2=name
  cat > "$1/$2" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$1/$2"
}

# Fake tailscale: always answers `status --json` the same way, since that's
# the only call this contract describes.
fake_tailscale() { # $1=dir $2=BackendState value
  cat > "$1/tailscale" <<EOF
#!/usr/bin/env bash
printf '%s\n' '{"BackendState":"$2"}'
exit 0
EOF
  chmod +x "$1/tailscale"
}

# Fake systemctl: always answers `--user is-active orca` the same way.
fake_systemctl() { # $1=dir $2=active|inactive
  local state="$2" ec=0
  [ "$state" = "active" ] || ec=3
  cat > "$1/systemctl" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$state'
exit $ec
EOF
  chmod +x "$1/systemctl"
}

# Fake curl: succeeds or fails the bridge-port probe unconditionally.
fake_curl() { # $1=dir $2=ok|fail
  if [ "$2" = "ok" ]; then
    cat > "$1/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"Browser":"HeadlessChrome"}'
exit 0
EOF
  else
    cat > "$1/curl" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
  fi
  chmod +x "$1/curl"
}

# --- per-case environment ---------------------------------------------------
CN=0
new_case() {
  CN=$((CN + 1))
  BIN="$WORK/c$CN/bin"
  HOME_DIR="$WORK/c$CN/home"
  CWD_DIR="$WORK/c$CN/cwd"
  mkdir -p "$BIN" "$HOME_DIR" "$CWD_DIR"
  RUN_PATH="$BIN:$SAFE_TOOLS_DIR"
  ENV_EXTRA=()
}

# Runs the script fully hermetically: only $RUN_PATH, $HOME_DIR, cwd=$CWD_DIR
# and whatever's in $ENV_EXTRA reach it. Everything else the real shell has
# (DISPLAY, HERDR_ENV, ORCA_PANE_KEY, or anything else) is stripped by `env -i`
# unless a case adds it back via ENV_EXTRA. Sets $OUT, $EC, $ERR.
run_detect() {
  local stderr_file="$WORK/.stderr.$CN"
  OUT="$(cd "$CWD_DIR" && env -i PATH="$RUN_PATH" HOME="$HOME_DIR" "${ENV_EXTRA[@]}" bash "$SCRIPT" "$@" 2>"$stderr_file")"
  EC=$?
  ERR="$(cat "$stderr_file" 2>/dev/null)"
}

# Recursive content+size snapshot of a directory, for the "writes nothing" check.
snapshot_dir() {
  find "$1" 2>/dev/null | sort | while read -r p; do
    if [ -f "$p" ]; then
      printf '%s|%s|%s\n' "$p" "$(stat -c '%s' "$p" 2>/dev/null)" "$(sha256sum "$p" 2>/dev/null | cut -d' ' -f1)"
    else
      printf '%s|dir\n' "$p"
    fi
  done
}

echo "Testing: $SCRIPT"
echo "Workdir: $WORK"
echo ""

# ============================================================================
# 1. Invocation: --help, bogus argument
# ============================================================================
echo "Case 1: --help and a bogus argument"
new_case
run_detect --help
check "--help exits 0"                        '[ "$EC" -eq 0 ]'
check "--help prints something to stdout"      '[ -n "$OUT" ]'
check "--help performs no detection (not JSON)" '! valid_json'

new_case
run_detect --bogus-flag-nobody-defined
check "unknown argument exits 64"              '[ "$EC" -eq 64 ]'
check "unknown argument writes to stderr"      '[ -n "$ERR" ]'

# ============================================================================
# 2. Completely bare host
# ============================================================================
echo "Case 2: bare host (nothing installed, empty HOME, cwd not a git repo)"
new_case
run_detect
check "bare host exits 0"                              '[ "$EC" -eq 0 ]'
check "bare host prints valid JSON"                     'valid_json'
check "herdr_binary is null"                             'field_is ".orchestrator.herdr_binary" "null"'
check "orca_binary is null"                               'field_is ".orchestrator.orca_binary" "null"'
check "hosting_this_session is none"                      'field_is ".orchestrator.hosting_this_session" "none"'
check "orchestrator.recommended is none"                  'field_is ".orchestrator.recommended" "none"'
check "agent_browser_binary is null"                       'field_is ".browser.agent_browser_binary" "null"'
check "bridge_port_answers is false"                        'field_is ".browser.bridge_port_answers" "false"'
check "chromium_binaries is empty array"                    'array_is ".browser.chromium_binaries" "[]"'
check "display is false"                                    'field_is ".browser.display" "false"'
check "browser.recommended.remote is false"                  'field_is ".browser.recommended.remote" "false"'
check "browser.recommended.headless is false"                'field_is ".browser.recommended.headless" "false"'
check "browser.recommended.local is false"                   'field_is ".browser.recommended.local" "false"'
check "tailscale_binary is null"                              'field_is ".preview.tailscale_binary" "null"'
check "tailscale_logged_in is false"                          'field_is ".preview.tailscale_logged_in" "false"'
check "preview.recommended is false"                          'field_is ".preview.recommended" "false"'
check "stagewise_binary is null"                               'field_is ".element_picker.stagewise_binary" "null"'
check "element_picker.recommended is none"                     'field_is ".element_picker.recommended" "none"'
check "serve_unit_active is false"                              'field_is ".orca_topology.serve_unit_active" "false"'
check "orca_topology.recommended is null"                       'field_is ".orca_topology.recommended" "null"'
check "orca_hooks_present is false"                              'field_is ".claude_settings.orca_hooks_present" "false"'
check "backup_exists is false"                                   'field_is ".claude_settings.backup_exists" "false"'
check "project.root is null"                                      'field_is ".project.root" "null"'
check "project.has_frontend is false"                              'field_is ".project.has_frontend" "false"'

# ============================================================================
# 3. Fully equipped host
# ============================================================================
echo "Case 3: fully equipped host"
new_case
fake_simple "$BIN" herdr
fake_simple "$BIN" orca-ide
fake_simple "$BIN" agent-browser
fake_tailscale "$BIN" "Running"
fake_simple "$BIN" stagewise
fake_simple "$BIN" chromium
fake_simple "$BIN" google-chrome-stable
fake_curl "$BIN" ok
fake_systemctl "$BIN" active
mkdir -p "$HOME_DIR/.claude"
printf 'orca hooks configured\n' > "$HOME_DIR/.claude/settings.json"
printf 'backup\n' > "$HOME_DIR/.claude/settings.json.bak"
ENV_EXTRA=(DISPLAY=":0")
run_detect
check "fully equipped exits 0"                              '[ "$EC" -eq 0 ]'
check "fully equipped prints valid JSON"                     'valid_json'
check "herdr_binary resolves to the fake"                    'field_is ".orchestrator.herdr_binary" "'"$BIN"'/herdr"'
check "orca_binary resolves to orca-ide"                     'field_is ".orchestrator.orca_binary" "'"$BIN"'/orca-ide"'
check "hosting_this_session is none (no env vars set)"       'field_is ".orchestrator.hosting_this_session" "none"'
check "orchestrator.recommended falls back to herdr"         'field_is ".orchestrator.recommended" "herdr"'
check "agent_browser_binary resolves"                        'field_is ".browser.agent_browser_binary" "'"$BIN"'/agent-browser"'
check "bridge_port_answers is true"                           'field_is ".browser.bridge_port_answers" "true"'
check "chromium_binaries lists both in contract order"        'array_is ".browser.chromium_binaries" "[\"'"$BIN"'/chromium\",\"'"$BIN"'/google-chrome-stable\"]"'
check "display is true"                                       'field_is ".browser.display" "true"'
check "browser.recommended.remote is true"                     'field_is ".browser.recommended.remote" "true"'
check "browser.recommended.headless is true"                   'field_is ".browser.recommended.headless" "true"'
check "browser.recommended.local is true"                      'field_is ".browser.recommended.local" "true"'
check "tailscale_binary resolves"                                'field_is ".preview.tailscale_binary" "'"$BIN"'/tailscale"'
check "tailscale_logged_in is true"                              'field_is ".preview.tailscale_logged_in" "true"'
check "preview.recommended is true"                               'field_is ".preview.recommended" "true"'
check "stagewise_binary resolves"                                  'field_is ".element_picker.stagewise_binary" "'"$BIN"'/stagewise"'
check "element_picker.recommended is stagewise"                    'field_is ".element_picker.recommended" "stagewise"'
check "serve_unit_active is true"                                    'field_is ".orca_topology.serve_unit_active" "true"'
check "orca_topology.recommended is local (display is true)"         'field_is ".orca_topology.recommended" "local"'
check "orca_hooks_present is true"                                     'field_is ".claude_settings.orca_hooks_present" "true"'
check "backup_exists is true"                                           'field_is ".claude_settings.backup_exists" "true"'
check "project.root is null (cwd not a git repo)"                        'field_is ".project.root" "null"'
check "project.has_frontend is false"                                     'field_is ".project.has_frontend" "false"'

# ============================================================================
# 4. hosting_this_session precedence
# ============================================================================
echo "Case 4: hosting_this_session precedence"
new_case; ENV_EXTRA=(ORCA_PANE_KEY="pane-1"); run_detect
check "ORCA_PANE_KEY alone -> orca"            'field_is ".orchestrator.hosting_this_session" "orca"'
check "recommended mirrors hosting_this_session (orca)" 'field_is ".orchestrator.recommended" "orca"'

new_case; ENV_EXTRA=(HERDR_ENV="prod"); run_detect
check "HERDR_ENV alone -> herdr"               'field_is ".orchestrator.hosting_this_session" "herdr"'
check "recommended mirrors hosting_this_session (herdr)" 'field_is ".orchestrator.recommended" "herdr"'

new_case; ENV_EXTRA=(ORCA_PANE_KEY="pane-1" HERDR_ENV="prod"); run_detect
check "both set -> ORCA_PANE_KEY wins"         'field_is ".orchestrator.hosting_this_session" "orca"'

new_case; run_detect
check "neither set -> none"                    'field_is ".orchestrator.hosting_this_session" "none"'

new_case; ENV_EXTRA=(ORCA_PANE_KEY="" HERDR_ENV="prod"); run_detect
check "empty ORCA_PANE_KEY does not count as set" 'field_is ".orchestrator.hosting_this_session" "herdr"'

new_case; ENV_EXTRA=(HERDR_ENV=""); run_detect
check "empty HERDR_ENV does not count as set"     'field_is ".orchestrator.hosting_this_session" "none"'

# ============================================================================
# 5. orchestrator.recommended fallback (no env vars set)
# ============================================================================
echo "Case 5: orchestrator.recommended fallback"
new_case; fake_simple "$BIN" orca-ide; run_detect
check "only orca binary -> recommended orca"   'field_is ".orchestrator.recommended" "orca"'

new_case; fake_simple "$BIN" herdr; run_detect
check "only herdr binary -> recommended herdr" 'field_is ".orchestrator.recommended" "herdr"'

new_case; fake_simple "$BIN" herdr; fake_simple "$BIN" orca-ide; run_detect
check "both binaries -> herdr preferred"       'field_is ".orchestrator.recommended" "herdr"'

new_case; run_detect
check "neither binary -> recommended none"     'field_is ".orchestrator.recommended" "none"'

# ============================================================================
# 6. orca-ide vs orca binary selection
# ============================================================================
echo "Case 6: orca-ide vs orca fallback"
new_case; fake_simple "$BIN" orca; run_detect
check "orca-ide absent, orca present -> uses orca" 'field_is ".orchestrator.orca_binary" "'"$BIN"'/orca"'

new_case; run_detect
check "both absent -> orca_binary null"            'field_is ".orchestrator.orca_binary" "null"'

# ============================================================================
# 7. browser.recommended combinations
# ============================================================================
echo "Case 7: browser.recommended combinations"

# 7a: no browsers, no display, bridge answers -> remote only
new_case
fake_curl "$BIN" ok
run_detect
check "no browsers/no display/curl ok: remote true"    'field_is ".browser.recommended.remote" "true"'
check "no browsers/no display/curl ok: headless false"  'field_is ".browser.recommended.headless" "false"'
check "no browsers/no display/curl ok: local false"      'field_is ".browser.recommended.local" "false"'

# 7b: browsers present, no display, bridge fails -> headless only
new_case
fake_simple "$BIN" chromium
fake_curl "$BIN" fail
run_detect
check "browsers/no display/curl fail: remote false"    'field_is ".browser.recommended.remote" "false"'
check "browsers/no display/curl fail: headless true"    'field_is ".browser.recommended.headless" "true"'
check "browsers/no display/curl fail: local false"       'field_is ".browser.recommended.local" "false"'

# 7c: browsers present, display present, curl absent -> local (and headless), not remote
new_case
fake_simple "$BIN" chromium
ENV_EXTRA=(DISPLAY=":0")
run_detect
check "browsers/display/curl absent: remote false"     'field_is ".browser.recommended.remote" "false"'
check "browsers/display/curl absent: headless true"     'field_is ".browser.recommended.headless" "true"'
check "browsers/display/curl absent: local true"          'field_is ".browser.recommended.local" "true"'
check "browsers/display/curl absent: bridge_port_answers false" 'field_is ".browser.bridge_port_answers" "false"'

# 7d: curl tri-state, isolated (no browsers, no display)
new_case; fake_curl "$BIN" ok; run_detect
check "curl succeeds -> bridge_port_answers true"       'field_is ".browser.bridge_port_answers" "true"'

new_case; fake_curl "$BIN" fail; run_detect
check "curl fails -> bridge_port_answers false"          'field_is ".browser.bridge_port_answers" "false"'

new_case; run_detect
check "curl absent -> bridge_port_answers false"          'field_is ".browser.bridge_port_answers" "false"'

# 7e: display can come from WAYLAND_DISPLAY alone
new_case; ENV_EXTRA=(WAYLAND_DISPLAY="wayland-0"); run_detect
check "WAYLAND_DISPLAY alone sets display true"           'field_is ".browser.display" "true"'

# 7f: an empty DISPLAY does not count as set
new_case; ENV_EXTRA=(DISPLAY=""); run_detect
check "empty DISPLAY does not set display true"           'field_is ".browser.display" "false"'

# ============================================================================
# 8. tailscale_logged_in / preview.recommended when not logged in
# ============================================================================
echo "Case 8: tailscale present but not logged in"
new_case
fake_tailscale "$BIN" "NeedsLogin"
run_detect
check "tailscale_binary resolves"                    'field_is ".preview.tailscale_binary" "'"$BIN"'/tailscale"'
check "NeedsLogin -> tailscale_logged_in false"       'field_is ".preview.tailscale_logged_in" "false"'
check "NeedsLogin -> preview.recommended false"        'field_is ".preview.recommended" "false"'

# ============================================================================
# 9. element_picker.recommended outcomes
# ============================================================================
echo "Case 9: element_picker.recommended outcomes"

# stagewise present takes precedence, even with orca present and topology local
new_case
fake_simple "$BIN" stagewise
fake_simple "$BIN" orca-ide
run_detect
check "stagewise present -> recommended stagewise"     'field_is ".element_picker.recommended" "stagewise"'

# stagewise absent, orca present, topology local -> orca-design-mode
new_case
fake_simple "$BIN" orca-ide
run_detect
check "topology is local in this setup"                'field_is ".orca_topology.recommended" "local"'
check "orca present + topology local -> orca-design-mode" 'field_is ".element_picker.recommended" "orca-design-mode"'

# stagewise absent, orca present, topology remote -> none (orca alone isn't enough)
new_case
fake_simple "$BIN" orca-ide
fake_systemctl "$BIN" active
run_detect
check "topology is remote in this setup"                'field_is ".orca_topology.recommended" "remote"'
check "orca present + topology remote -> none"           'field_is ".element_picker.recommended" "none"'

# neither stagewise nor orca -> none
new_case; run_detect
check "no stagewise, no orca -> none"                    'field_is ".element_picker.recommended" "none"'

# ============================================================================
# 10. orca_topology.recommended
# ============================================================================
echo "Case 10: orca_topology.recommended"

new_case; run_detect
check "no orca binary -> topology recommended null"     'field_is ".orca_topology.recommended" "null"'

new_case
fake_simple "$BIN" orca-ide
fake_systemctl "$BIN" active
run_detect
check "active + no display -> remote"                     'field_is ".orca_topology.recommended" "remote"'

new_case
fake_simple "$BIN" orca-ide
fake_systemctl "$BIN" active
ENV_EXTRA=(DISPLAY=":0")
run_detect
check "active + display -> local"                          'field_is ".orca_topology.recommended" "local"'

new_case
fake_simple "$BIN" orca-ide
fake_systemctl "$BIN" inactive
run_detect
check "inactive + no display -> local"                       'field_is ".orca_topology.recommended" "local"'

new_case
fake_simple "$BIN" orca-ide
run_detect
check "systemctl absent -> local"                             'field_is ".orca_topology.recommended" "local"'

# ============================================================================
# 11. claude_settings
# ============================================================================
echo "Case 11: claude_settings"

new_case
mkdir -p "$HOME_DIR/.claude"
printf 'ORCA_HOOK_ENABLED=1\n' > "$HOME_DIR/.claude/settings.json"
printf 'backup contents\n' > "$HOME_DIR/.claude/settings.json.bak"
run_detect
check "settings.json mentions orca case-insensitively -> hooks true" 'field_is ".claude_settings.orca_hooks_present" "true"'
check "backup file present -> backup_exists true"                     'field_is ".claude_settings.backup_exists" "true"'

new_case
mkdir -p "$HOME_DIR/.claude"
printf '{"some": "other", "config": true}\n' > "$HOME_DIR/.claude/settings.json"
run_detect
check "settings.json without orca -> hooks false"                     'field_is ".claude_settings.orca_hooks_present" "false"'
check "no backup file -> backup_exists false"                          'field_is ".claude_settings.backup_exists" "false"'

new_case; run_detect
check "no ~/.claude/settings.json at all -> hooks false"               'field_is ".claude_settings.orca_hooks_present" "false"'
check "no ~/.claude/settings.json.bak at all -> backup_exists false"    'field_is ".claude_settings.backup_exists" "false"'

# ============================================================================
# 12. project.root / project.has_frontend
# ============================================================================
echo "Case 12: project.root and project.has_frontend"

new_case
git init -q "$CWD_DIR"
mkdir -p "$CWD_DIR/spechub"
printf 'frontend:\n  framework: react\n' > "$CWD_DIR/spechub/project.yaml"
EXPECTED_ROOT="$(git -C "$CWD_DIR" rev-parse --show-toplevel)"
run_detect
check "root matches the git repo top-level"           'field_is ".project.root" "'"$EXPECTED_ROOT"'"'
check "top-level frontend key -> has_frontend true"     'field_is ".project.has_frontend" "true"'

new_case
git init -q "$CWD_DIR"
mkdir -p "$CWD_DIR/spechub"
printf 'name: backend-only\n' > "$CWD_DIR/spechub/project.yaml"
run_detect
check "no frontend key -> has_frontend false"            'field_is ".project.has_frontend" "false"'

new_case
git init -q "$CWD_DIR"
mkdir -p "$CWD_DIR/spechub"
printf 'workflow:\n  frontend: true\n' > "$CWD_DIR/spechub/project.yaml"
run_detect
check "indented frontend key (not column 0) -> has_frontend false" 'field_is ".project.has_frontend" "false"'

new_case
git init -q "$CWD_DIR"
run_detect
check "no project.yaml at all -> has_frontend false"     'field_is ".project.has_frontend" "false"'
check "root still resolves when no project.yaml"          '[ "$(jval ".project.root")" != "null" ]'

new_case
git init -q "$CWD_DIR"
mkdir -p "$CWD_DIR/spechub"
printf 'frontend:\n  framework: vue\n' > "$CWD_DIR/spechub/project.yaml"
mkdir -p "$CWD_DIR/nested/deeper"
EXPECTED_ROOT="$(git -C "$CWD_DIR" rev-parse --show-toplevel)"
CWD_DIR="$CWD_DIR/nested/deeper"
run_detect
check "root resolves to top-level from a nested cwd"       'field_is ".project.root" "'"$EXPECTED_ROOT"'"'
check "has_frontend still true from a nested cwd"            'field_is ".project.has_frontend" "true"'

# ============================================================================
# 13. read-only: nothing on disk changes
# ============================================================================
echo "Case 13: script writes nothing"
new_case
fake_simple "$BIN" herdr
fake_simple "$BIN" orca-ide
fake_simple "$BIN" agent-browser
fake_tailscale "$BIN" "Running"
fake_simple "$BIN" stagewise
fake_simple "$BIN" chromium
fake_curl "$BIN" ok
fake_systemctl "$BIN" active
mkdir -p "$HOME_DIR/.claude"
printf 'orca hooks\n' > "$HOME_DIR/.claude/settings.json"
git init -q "$CWD_DIR"
mkdir -p "$CWD_DIR/spechub"
printf 'frontend:\n  framework: react\n' > "$CWD_DIR/spechub/project.yaml"
ENV_EXTRA=(DISPLAY=":0")
BEFORE_HOME="$(snapshot_dir "$HOME_DIR")"
BEFORE_CWD="$(snapshot_dir "$CWD_DIR")"
run_detect
AFTER_HOME="$(snapshot_dir "$HOME_DIR")"
AFTER_CWD="$(snapshot_dir "$CWD_DIR")"
check "run succeeded"                          '[ "$EC" -eq 0 ]'
check "HOME directory is unchanged"             '[ "$BEFORE_HOME" = "$AFTER_HOME" ]'
check "cwd (git repo) is unchanged"              '[ "$BEFORE_CWD" = "$AFTER_CWD" ]'

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
