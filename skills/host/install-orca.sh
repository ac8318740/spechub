#!/usr/bin/env bash
# SpecHub host setup: install Orca as a headless server for this user.
#
# Orca is an agent integrated development environment. This script installs it
# as a background service that serves its interface over the network, so a
# machine with no screen - a development virtual machine, say - can host it
# while you pair a browser or a phone with it from somewhere else.
#
# Everything it touches lives under $HOME and no step needs root:
#
#   ~/.local/opt/orca/orca-linux.AppImage      the binary
#   ~/.local/bin/orca-ide, ~/.local/bin/orca   symlinks onto PATH
#   ~/.config/systemd/user/orca.service        the systemd user unit
#
# There are two modes and no default. --plan prints the five steps with the
# status each one would have and writes nothing at all; --apply does the work.
# Every step is idempotent, so a second --apply reports every step as skipped
# and leaves the machine byte for byte as it was. Plan mode cannot write by
# accident, because every write in this script lives inside a step's doer
# function and a doer is only ever called on the apply path.
#
# A step that cannot finish says so on stderr and stops the run non-zero. It
# never carries on to the next step, because a half-configured service that
# reports success is worse than one that is missing.
#
# Every tool it needs is looked up on PATH and every path it writes derives from
# $HOME. That is what makes it testable: tests/test-host-install.sh runs it under
# `env -i` with a PATH of fake executables and a temporary HOME, so the result is
# entirely determined by what the test wired up. Reaching past PATH or $HOME to a
# real location would defeat that, so don't.

set -u

PROG="install-orca.sh"
TOTAL=5

# --- defaults --------------------------------------------------------------

# Upstream's own documented download link. The asset name carries no version, so
# the `latest` alias resolves to whatever the current release is.
DEFAULT_APPIMAGE_URL="https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage"
DEFAULT_PORT="6768"
# Where the kernel release string lives on Linux. An option overrides it, which
# is what lets a test hand the Windows Subsystem for Linux check its own file.
DEFAULT_OSRELEASE_FILE="/proc/sys/kernel/osrelease"

usage() {
  cat <<'USAGE'
install-orca.sh - install Orca as a headless systemd user service.

Usage:
  install-orca.sh --plan [options]    Print the steps and their status. Writes nothing.
  install-orca.sh --apply [options]   Do the work. Every step is idempotent.
  install-orca.sh --help              Print this help and exit.

Options:
  --appimage-path PATH    Install this local AppImage instead of downloading one.
  --appimage-url URL      Download the AppImage from here. Defaults to the latest
                          orca-linux.AppImage on the upstream releases page.
  --port N                Port the server listens on. Default: 6768.
  --pairing-address ADDR  Address to advertise in the pairing URL, a Tailscale
                          address for example. Left out of the unit when unset.
  --mobile-pairing        Also advertise the server to the Orca mobile app.
  --osrelease-file PATH   Kernel release file the Windows Subsystem for Linux
                          check reads. Default: /proc/sys/kernel/osrelease.

Exactly one of --plan and --apply is required; neither is the default, because
this script changes a machine and guessing which way is not a kindness.

Everything is installed under your home directory and no step needs root:
  ~/.local/opt/orca/orca-linux.AppImage
  ~/.local/bin/orca-ide, ~/.local/bin/orca
  ~/.config/systemd/user/orca.service

Exit codes: 0 all good, 1 a step failed, 3 this machine is not Linux,
64 the command line was wrong.
USAGE
}

# --- small helpers ---------------------------------------------------------

err() { printf '%s: %s\n' "$PROG" "$1" >&2; }

# A step could not finish. Say so and stop: nothing further is attempted.
fail() { err "$1"; exit 1; }

die_usage() {
  err "$1"
  err "run with --help for usage."
  exit 64
}

# $1 wrapped in single quotes, safe to paste inside a /bin/sh command string.
# An embedded single quote is closed, escaped and reopened, which is the only
# form /bin/sh accepts. Home directories with a space in them are ordinary, so
# the AppImage path genuinely needs this.
shq() {
  local s="$1"
  printf "'%s'" "${s//\'/\'\\\'\'}"
}

# --- argument parsing ------------------------------------------------------
#
# Parsed in full before anything else happens, so --help and a bad command line
# cost nothing: no platform detection, no systemctl call, no file touched.

MODE=""
APPIMAGE_URL="$DEFAULT_APPIMAGE_URL"
APPIMAGE_PATH=""
PORT="$DEFAULT_PORT"
PAIRING_ADDRESS=""
MOBILE_PAIRING=0
OSRELEASE_FILE="$DEFAULT_OSRELEASE_FILE"

# $1=option name, $2=how many arguments are left including the option itself.
need_value() {
  [ "$2" -ge 2 ] || die_usage "$1 needs a value."
}

set_mode() {
  [ -z "$MODE" ] || die_usage "choose exactly one of --plan and --apply."
  MODE="$1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan)  set_mode "plan" ;;
    --apply) set_mode "apply" ;;
    --appimage-path)   need_value "$1" "$#"; APPIMAGE_PATH="$2"; shift ;;
    --appimage-url)    need_value "$1" "$#"; APPIMAGE_URL="$2"; shift ;;
    --port)            need_value "$1" "$#"; PORT="$2"; shift ;;
    --pairing-address) need_value "$1" "$#"; PAIRING_ADDRESS="$2"; shift ;;
    --mobile-pairing)  MOBILE_PAIRING=1 ;;
    --osrelease-file)  need_value "$1" "$#"; OSRELEASE_FILE="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$MODE" ] || die_usage "one of --plan and --apply is required."

case "$PORT" in
  ''|*[!0-9]*) die_usage "--port takes a number, not: $PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  die_usage "--port must be between 1 and 65535, not: $PORT"
fi

# The pairing address is written into the unit unquoted, so that the unit reads
# the way the upstream examples do. Keep it to the characters a host name or an
# IP address can hold, and nothing that a shell would act on can get in.
case "$PAIRING_ADDRESS" in
  '') ;;
  *[!A-Za-z0-9._:-]*) die_usage "--pairing-address may hold only letters, digits, dot, colon, hyphen and underscore, not: $PAIRING_ADDRESS" ;;
esac

[ -n "${HOME:-}" ] || fail "HOME is not set, so there is nowhere to install to."

# --- platform gate ---------------------------------------------------------
#
# systemd user units and AppImages are Linux things. Anywhere else this script
# would produce a confident-looking mess, so it stops before touching anything.

PLATFORM="$(uname -s 2>/dev/null || true)"
if [ "$PLATFORM" != "Linux" ]; then
  printf '%s: this installer supports Linux only. This machine reports: %s\n' \
    "$PROG" "${PLATFORM:-unknown}"
  printf '%s: nothing has been changed.\n' "$PROG"
  exit 3
fi

# --- the Windows Subsystem for Linux is not supported ----------------------
#
# The Windows Subsystem for Linux is a Linux environment running on Windows. It
# answers `Linux` to `uname -s`, so the gate above lets it straight through, and
# neither a systemd user unit nor an AppImage behaves there the way this install
# assumes. Two markers give it away and either one on its own is enough.

WSL_EVIDENCE=""
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  WSL_EVIDENCE="the WSL_DISTRO_NAME environment variable is set to: $WSL_DISTRO_NAME"
elif [ -f "$OSRELEASE_FILE" ] && [ -r "$OSRELEASE_FILE" ] &&
     grep -qi microsoft "$OSRELEASE_FILE" 2>/dev/null; then
  # Matched without regard to case: the kernel release reads `microsoft` on WSL2
  # and `Microsoft` on WSL1.
  WSL_EVIDENCE="the kernel release in $OSRELEASE_FILE names microsoft: $(head -n 1 "$OSRELEASE_FILE" 2>/dev/null)"
fi

# An osrelease file that is not there says nothing about the environment, so a
# machine without one carries on rather than being refused on a missing file.
if [ -n "$WSL_EVIDENCE" ]; then
  printf '%s: this is the Windows Subsystem for Linux (WSL), which is not supported.\n' "$PROG"
  printf '%s: %s\n' "$PROG" "$WSL_EVIDENCE"
  printf '%s: nothing has been changed.\n' "$PROG"
  exit 3
fi

# --- the paths this script owns --------------------------------------------

APPIMAGE_DIR="$HOME/.local/opt/orca"
APPIMAGE="$APPIMAGE_DIR/orca-linux.AppImage"
BIN_DIR="$HOME/.local/bin"
LINK_IDE="$BIN_DIR/orca-ide"
LINK_ORCA="$BIN_DIR/orca"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="orca.service"
UNIT="$UNIT_DIR/$UNIT_NAME"
JOURNAL_CMD="journalctl --user -u $UNIT_NAME -n 100 --no-pager"

HAVE_SYSTEMCTL=0
command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMCTL=1

if [ "$MODE" = "apply" ] && [ "$HAVE_SYSTEMCTL" -eq 0 ]; then
  fail "systemctl is not on PATH, so the user service cannot be installed. Nothing has been changed."
fi

# --- the unit file ---------------------------------------------------------

# The server invocation, as one /bin/sh command string.
ORCA_CMD="$(shq "$APPIMAGE") serve --port $PORT"
[ -n "$PAIRING_ADDRESS" ] && ORCA_CMD="$ORCA_CMD --pairing-address $PAIRING_ADDRESS"
[ "$MOBILE_PAIRING" -eq 1 ] && ORCA_CMD="$ORCA_CMD --mobile-pairing"

# Built once, up front: step 3 compares it against what is on disk, and step 4
# needs to know whether step 3 will rewrite the file.
UNIT_TEXT="$(cat <<UNIT
[Unit]
Description=Orca headless server
Documentation=https://github.com/stablyai/orca
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Orca prints its readiness block - the pairing URL among it - only when it
# believes it is talking to a terminal. Started plainly, the server runs fine
# but the journal holds nothing, and there is then no way to retrieve the
# pairing URL. /usr/bin/script gives the server a pseudo-terminal and copies
# everything written to it onto stdout, which systemd captures into the journal.
# -q drops script's own start and done banners, -e makes script exit with the
# server's status so Restart= behaves, -c is the command to run, and the
# trailing /dev/null is where script's transcript file goes, because we want the
# journal copy and not a second one on disk.
ExecStart=/usr/bin/script -qec "$ORCA_CMD" /dev/null
Environment=ORCA_TELEMETRY_DISABLED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
)"

# --- step state ------------------------------------------------------------
#
# Every step's status is worked out here, before any of them runs. Two reasons:
# plan mode and apply mode then report from exactly the same reasoning, and
# step 4 can see whether step 3 is about to rewrite the unit.

# Step 1: the AppImage. An existing file counts only when it is non-empty and
# executable - a truncated download or a lost permission bit is not an install.
STEP1_NEEDED=1
STEP1_REASON=""
if [ -f "$APPIMAGE" ] && [ -s "$APPIMAGE" ] && [ -x "$APPIMAGE" ]; then
  STEP1_NEEDED=0
  STEP1_REASON="already present and executable"
fi

# Step 2: the two symlinks. Anything that is not a symlink pointing at the
# AppImage - a stale link, a copied binary, nothing at all - is replaced.
points_at_appimage() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$APPIMAGE" ]
}
STEP2_NEEDED=1
STEP2_REASON=""
if points_at_appimage "$LINK_IDE" && points_at_appimage "$LINK_ORCA"; then
  STEP2_NEEDED=0
  STEP2_REASON="both links already point at the AppImage"
fi

# Step 3: the unit file, compared whole. Any difference at all - a changed port,
# an added pairing address, an edit by hand - is a rewrite.
STEP3_NEEDED=1
STEP3_REASON=""
if [ -f "$UNIT" ] && [ "$(cat "$UNIT" 2>/dev/null)" = "$UNIT_TEXT" ]; then
  STEP3_NEEDED=0
  STEP3_REASON="already exactly this unit"
fi

# Step 4: reload, enable, start. The unit's current state comes from systemd
# itself; these are queries and change nothing.
UNIT_ENABLED=0
UNIT_ACTIVE=0
if [ "$HAVE_SYSTEMCTL" -eq 1 ]; then
  systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1 && UNIT_ENABLED=1
  systemctl --user is-active  "$UNIT_NAME" >/dev/null 2>&1 && UNIT_ACTIVE=1
fi

# It skips only when the unit is already enabled and already running AND step 3
# is not rewriting the unit in this same run. When step 3 does rewrite it, the
# running server is still on the old unit until systemd is told otherwise.
STEP4_NEEDED=1
STEP4_REASON=""
if [ "$UNIT_ENABLED" -eq 1 ] && [ "$UNIT_ACTIVE" -eq 1 ] && [ "$STEP3_NEEDED" -eq 0 ]; then
  STEP4_NEEDED=0
  STEP4_REASON="already enabled and running on this unit"
fi

# Step 5: the pairing URL - the link a client uses to connect to this server.
# Orca prints it once, when the server starts, so it is worth reading back
# exactly when step 4 has just started or restarted the server. An untouched
# server's pairing URL has not changed, so there is nothing to re-read.
#
# This step only ever reads. It is a convenience on the end of an install that
# has already succeeded, so nothing it runs into can fail the run: a missing
# journalctl or a journal with no readiness line in it yet reports as skipped,
# says why, and prints the command to run by hand.
STEP5_NEEDED="$STEP4_NEEDED"
STEP5_REASON="the server was left running untouched, so its pairing URL has not changed"
PAIRING_URL=""
SHOW_JOURNAL_HINT=0

# --- the doers -------------------------------------------------------------
#
# Every write in this script is in one of these three functions, and they are
# only ever called from the apply path. That is what makes plan mode inert.

do_step1() {
  mkdir -p "$APPIMAGE_DIR" || { err "could not create $APPIMAGE_DIR"; return 1; }

  local tmp
  # Staged next to its destination, so the move into place is atomic and a
  # failed download never leaves a half-written AppImage where a working one
  # is expected.
  tmp="$(mktemp "$APPIMAGE_DIR/.orca-install.XXXXXX")" || {
    err "could not create a temporary file in $APPIMAGE_DIR"; return 1; }

  if [ -n "$APPIMAGE_PATH" ]; then
    if [ ! -f "$APPIMAGE_PATH" ]; then
      rm -f "$tmp"; err "no AppImage at $APPIMAGE_PATH"; return 1
    fi
    if [ ! -s "$APPIMAGE_PATH" ]; then
      rm -f "$tmp"; err "the AppImage at $APPIMAGE_PATH is empty"; return 1
    fi
    if ! cp -f "$APPIMAGE_PATH" "$tmp"; then
      rm -f "$tmp"; err "could not copy $APPIMAGE_PATH into $APPIMAGE_DIR"; return 1
    fi
  else
    if ! command -v curl >/dev/null 2>&1; then
      rm -f "$tmp"
      err "curl is not on PATH, so the AppImage cannot be downloaded. Pass --appimage-path to install a local copy instead."
      return 1
    fi
    if ! curl -fL --retry 2 --connect-timeout 20 --output "$tmp" "$APPIMAGE_URL"; then
      rm -f "$tmp"; err "failed to download the Orca AppImage from $APPIMAGE_URL"; return 1
    fi
    if [ ! -s "$tmp" ]; then
      rm -f "$tmp"; err "the download from $APPIMAGE_URL produced an empty file"; return 1
    fi
  fi

  if ! chmod +x "$tmp"; then
    rm -f "$tmp"; err "could not make $tmp executable"; return 1
  fi
  if ! mv -f "$tmp" "$APPIMAGE"; then
    rm -f "$tmp"; err "could not move the AppImage into $APPIMAGE"; return 1
  fi
}

do_step2() {
  mkdir -p "$BIN_DIR" || { err "could not create $BIN_DIR"; return 1; }
  # -n so that an existing symlink is replaced rather than followed, which is
  # what makes a link pointing at a directory safe to overwrite.
  ln -sfn "$APPIMAGE" "$LINK_IDE" || { err "could not link $LINK_IDE"; return 1; }
  ln -sfn "$APPIMAGE" "$LINK_ORCA" || { err "could not link $LINK_ORCA"; return 1; }
}

do_step3() {
  mkdir -p "$UNIT_DIR" || { err "could not create $UNIT_DIR"; return 1; }
  printf '%s\n' "$UNIT_TEXT" > "$UNIT" || { err "could not write $UNIT"; return 1; }
}

do_step4() {
  systemctl --user daemon-reload || { err "systemctl --user daemon-reload failed"; return 1; }
  if [ "$UNIT_ENABLED" -eq 0 ] || [ "$UNIT_ACTIVE" -eq 0 ]; then
    # Not enabled, or enabled but not running: --now does both jobs at once.
    systemctl --user enable --now "$UNIT_NAME" || {
      err "systemctl --user enable --now $UNIT_NAME failed"; return 1; }
  else
    # Already enabled and running, and we are here only because the unit was
    # rewritten: pick the new unit up without touching the enablement.
    systemctl --user restart "$UNIT_NAME" || {
      err "systemctl --user restart $UNIT_NAME failed"; return 1; }
  fi
}

# Orca announces itself with one line of JSON carrying an "orca_server_ready"
# event and a "pairing" value. jq is one of the things a bare machine may not
# have, and needing a JSON tool to finish installing the tools would be a poor
# joke, so the value is cut out with sed. The last matching line wins: the
# journal is chronological, so the newest readiness line is the one belonging to
# the server running now.
extract_pairing_url() { # $1 = journal text
  printf '%s\n' "$1" \
    | grep -F 'orca_server_ready' \
    | tail -n 1 \
    | sed -n 's/.*"pairing"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Reads the journal and sets PAIRING_URL. On any outcome but success it turns
# step 5 into a skip that explains itself, and never returns non-zero: see the
# note on STEP5_NEEDED above.
read_pairing_url() {
  if ! command -v journalctl >/dev/null 2>&1; then
    STEP5_NEEDED=0
    STEP5_REASON="journalctl is not on PATH, so the pairing URL cannot be read here"
    SHOW_JOURNAL_HINT=1
    return 0
  fi

  # The server has only just been told to start, and Orca takes a moment to get
  # as far as printing its readiness line. Look again a few times before giving
  # up. `sleep` is a command like any other and not on every PATH; where it is
  # missing we settle for a single look rather than spinning.
  local attempts=1 n=1 journal=""
  command -v sleep >/dev/null 2>&1 && attempts=10

  while [ "$n" -le "$attempts" ]; do
    journal="$(journalctl --user -u "$UNIT_NAME" -n 100 --no-pager 2>/dev/null || true)"
    PAIRING_URL="$(extract_pairing_url "$journal")"
    [ -n "$PAIRING_URL" ] && return 0
    n=$((n + 1))
    [ "$n" -le "$attempts" ] && sleep 1
  done

  STEP5_NEEDED=0
  STEP5_REASON="journalctl showed no readiness line for $UNIT_NAME yet"
  SHOW_JOURNAL_HINT=1
  return 0
}

# --- reporting -------------------------------------------------------------

# One line per step: number, what it is, and a bracketed status. Plan mode says
# what would happen ([todo] / [skip: ...]), apply mode says what did
# ([done] / [skipped: ...]).
step_line() { # $1=number $2=description $3=needed $4=reason
  local status
  if [ "$3" -eq 1 ]; then
    if [ "$MODE" = "plan" ]; then status="[todo]"; else status="[done]"; fi
  else
    if [ "$MODE" = "plan" ]; then status="[skip: $4]"; else status="[skipped: $4]"; fi
  fi
  printf '[%s/%s] %s %s\n' "$1" "$TOTAL" "$2" "$status"
}

# Does the step when there is work and we are applying, then reports it. The
# work comes first so that a failure never gets to print [done].
run_step() { # $1=number $2=description $3=needed $4=reason $5=doer
  if [ "$3" -eq 1 ] && [ "$MODE" = "apply" ]; then
    "$5" || fail "step $1 failed: $2"
  fi
  step_line "$1" "$2" "$3" "$4"
}

print_notes() {
  cat <<'NOTES'

Notes:
  Orca rewrites ~/.claude/settings.json on its first run, to add its own hooks,
  and keeps the file it found as ~/.claude/settings.json.bak. That is Orca's
  own doing and this script never touches either file, but it is worth knowing
  before you start the server.
  The pairing URL is printed once, when the server starts. The journalctl
  command in step 5 is how you read it back afterwards.
  Nothing here needs root: every path is under your home directory.
NOTES
}

# --- run -------------------------------------------------------------------

if [ "$MODE" = "plan" ]; then
  printf '%s: plan only. Nothing on this machine is changed.\n\n' "$PROG"
else
  printf '%s: applying.\n\n' "$PROG"
fi

run_step 1 "AppImage at $APPIMAGE" \
  "$STEP1_NEEDED" "$STEP1_REASON" do_step1
run_step 2 "symlinks orca-ide and orca in $BIN_DIR" \
  "$STEP2_NEEDED" "$STEP2_REASON" do_step2
run_step 3 "systemd user unit $UNIT" \
  "$STEP3_NEEDED" "$STEP3_REASON" do_step3
run_step 4 "systemctl --user daemon-reload, then enable and start $UNIT_NAME" \
  "$STEP4_NEEDED" "$STEP4_REASON" do_step4
# Step 5 is reported by hand rather than through run_step, because reading the
# journal can turn the step into a skip and run_step's status is fixed before
# its doer runs. Plan mode never gets here, so it never calls journalctl.
if [ "$MODE" = "apply" ] && [ "$STEP5_NEEDED" -eq 1 ]; then
  read_pairing_url
fi
step_line 5 "pairing URL: $JOURNAL_CMD" "$STEP5_NEEDED" "$STEP5_REASON"
if [ -n "$PAIRING_URL" ]; then
  printf '      %s\n' "$PAIRING_URL"
fi
if [ "$SHOW_JOURNAL_HINT" -eq 1 ]; then
  printf '      read it yourself, once the server has settled, with:\n'
  printf '      %s\n' "$JOURNAL_CMD"
fi

print_notes
