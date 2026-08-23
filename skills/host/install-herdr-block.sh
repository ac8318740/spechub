#!/usr/bin/env bash
# SpecHub host setup: tell herdr where to put its worktrees.
#
# herdr is the terminal workspace this project drives agents from. It makes a
# git worktree per unit of work, and where those worktrees land is one setting
# in ~/.config/herdr/config.toml. This script writes that one setting and
# nothing else, inside a fenced block it owns:
#
#   # >>> spechub terminal-workspace >>>
#   [worktrees]
#   directory = "~/.herdr/worktrees"
#   # <<< spechub terminal-workspace <<<
#
# The fence is what makes the script safe to run twice, and safe to run against
# a file somebody has been editing by hand. Every line outside the block
# survives, in its original order, with its content unchanged, and only the
# block's own lines are ever rewritten. Two edits outside the block are possible
# and both are deliberate: a blank separator line goes in ahead of a block being
# appended to a file that already had content, and a file that ended without a
# newline gains one.
#
# It refuses, and writes nothing, in two cases: when the file already holds more
# than one such block, and when it defines [worktrees] outside the block. Either
# way there is no edit that leaves a file herdr can still read - TOML rejects a
# table defined twice - and guessing which copy the user meant to keep would be
# the wrong kind of helpful.
#
# There are two modes and no default. --plan prints what would happen and writes
# nothing at all; --apply does it. Plan mode cannot write by accident, because
# the one function in this script that writes is only ever called on the apply
# path.
#
# Every path derives from $HOME or from --config, and nothing is hardcoded to a
# real location. That is what makes it testable: tests/test-host-install.sh runs
# it under `env -i` with a PATH of fake executables and a temporary HOME.

set -u

PROG="install-herdr-block.sh"
TOTAL=1

# --- the managed block -----------------------------------------------------
#
# These four strings are the contract. The markers are matched on whole lines,
# exactly, so a line that merely mentions one of them is ordinary content.

BLOCK_START='# >>> spechub terminal-workspace >>>'
BLOCK_END='# <<< spechub terminal-workspace <<<'
BLOCK_TABLE='[worktrees]'
DEFAULT_WORKTREE_DIR='~/.herdr/worktrees'
# Where the kernel release string lives on Linux. An option overrides it, which
# is what lets a test hand the Windows Subsystem for Linux check its own file.
DEFAULT_OSRELEASE_FILE="/proc/sys/kernel/osrelease"

usage() {
  cat <<'USAGE'
install-herdr-block.sh - point herdr's worktrees at one directory.

Usage:
  install-herdr-block.sh --plan [options]    Print what would happen. Writes nothing.
  install-herdr-block.sh --apply [options]   Do it. Running it twice is a no-op.
  install-herdr-block.sh --help              Print this help and exit.

Options:
  --worktree-dir DIR   Directory herdr puts worktrees in.
                       Default: ~/.herdr/worktrees, written literally, with the
                       tilde left for herdr to expand.
  --config PATH        Config file to edit.
                       Default: ~/.config/herdr/config.toml
  --osrelease-file PATH
                       Kernel release file the Windows Subsystem for Linux
                       check reads. Default: /proc/sys/kernel/osrelease

Exactly one of --plan and --apply is required; neither is the default, because
this script edits a file you may have written by hand.

Only the fenced block between the markers

  # >>> spechub terminal-workspace >>>
  # <<< spechub terminal-workspace <<<

is ever written. Everything else in the file is preserved exactly, in order.

Exit codes: 0 all good, 1 the write failed, 3 this machine is not Linux,
4 the file is not safe to edit, 64 the command line was wrong.
USAGE
}

# --- small helpers ---------------------------------------------------------

err() { printf '%s: %s\n' "$PROG" "$1" >&2; }

fail() { err "$1"; exit 1; }

die_usage() {
  err "$1"
  err "run with --help for usage."
  exit 64
}

# The file cannot be edited without corrupting it. Say why, in full, and stop
# without having written anything.
refuse() {
  err "$1"
  exit 4
}

# --- argument parsing ------------------------------------------------------
#
# Parsed in full first, so --help and a bad command line cost nothing: no
# platform detection and no file so much as opened.

MODE=""
WORKTREE_DIR="$DEFAULT_WORKTREE_DIR"
CONFIG=""
OSRELEASE_FILE="$DEFAULT_OSRELEASE_FILE"

need_value() { # $1=option name, $2=arguments left including the option itself
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
    --worktree-dir) need_value "$1" "$#"; WORKTREE_DIR="$2"; shift ;;
    --config)       need_value "$1" "$#"; CONFIG="$2"; shift ;;
    --osrelease-file) need_value "$1" "$#"; OSRELEASE_FILE="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$MODE" ] || die_usage "one of --plan and --apply is required."

[ -n "$WORKTREE_DIR" ] || die_usage "--worktree-dir needs a directory."

# The directory goes into a basic TOML string. A double quote would end that
# string early and a backslash starts an escape, so neither can be let through:
# the result would be a config file herdr cannot parse.
case "$WORKTREE_DIR" in
  *'"'*|*'\'*) die_usage "--worktree-dir may not hold a double quote or a backslash, and this one does: $WORKTREE_DIR" ;;
esac

[ -n "${HOME:-}" ] || fail "HOME is not set, so there is no default config path."
[ -n "$CONFIG" ] || CONFIG="$HOME/.config/herdr/config.toml"

# --- platform gate ---------------------------------------------------------
#
# herdr is a Linux terminal workspace. Elsewhere there is no config file worth
# writing, so the script stops before touching anything.

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
# herdr is not supported there. Two markers give it away and either one on its
# own is enough.

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

# --- the block -------------------------------------------------------------

DIR_LINE="directory = \"$WORKTREE_DIR\""

render_block() {
  printf '%s\n' "$BLOCK_START"
  printf '%s\n' "$BLOCK_TABLE"
  printf '%s\n' "$DIR_LINE"
  printf '%s\n' "$BLOCK_END"
}

BLOCK_WANTED="$(render_block)"

# True when $1 is a line that opens the [worktrees] table, allowing for the
# surrounding whitespace TOML permits.
is_worktrees_table() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  [ "$s" = "$BLOCK_TABLE" ]
}

# Line numbers of every whole line equal to $1 in $2, space separated.
marker_lines() {
  grep -nxF -- "$1" "$2" 2>/dev/null | cut -d: -f1 | tr '\n' ' '
}

count_words() {
  printf '%s' "$1" | wc -w
}

# --- read the file and decide ----------------------------------------------
#
# ACTION is one of: create, append, replace, none. Working it out is entirely
# read-only, and both modes reach it the same way.

BLOCK_FOUND=""       # the block exactly as the file holds it now
UNMANAGED_LINES=""   # line numbers of [worktrees] tables outside the block
UNTERMINATED=0       # a start marker the file never closes

# One pass, tracking whether we are inside the block, because a [worktrees] line
# inside the block is ours and a [worktrees] line outside it is somebody else's.
scan_config() {
  local n=0 inside=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if [ "$inside" -eq 0 ] && [ "$line" = "$BLOCK_START" ]; then
      inside=1
      BLOCK_FOUND="$line"
      continue
    fi
    if [ "$inside" -eq 1 ]; then
      BLOCK_FOUND="$BLOCK_FOUND
$line"
      [ "$line" = "$BLOCK_END" ] && inside=0
      continue
    fi
    if is_worktrees_table "$line"; then
      UNMANAGED_LINES="${UNMANAGED_LINES:+$UNMANAGED_LINES }$n"
    fi
  done < "$1"
  UNTERMINATED="$inside"
}

ACTION="create"
SKIP_REASON=""

if [ -e "$CONFIG" ] && [ ! -f "$CONFIG" ]; then
  refuse "$CONFIG exists but is not a regular file, so it will not be edited."
fi

if [ -f "$CONFIG" ]; then
  START_LINES="$(marker_lines "$BLOCK_START" "$CONFIG")"
  END_LINES="$(marker_lines "$BLOCK_END" "$CONFIG")"
  N_START="$(count_words "$START_LINES")"
  N_END="$(count_words "$END_LINES")"

  if [ "$N_START" -gt 1 ] || [ "$N_END" -gt 1 ]; then
    err "$CONFIG holds more than one spechub terminal-workspace block."
    err "start markers on line(s): ${START_LINES:-none}"
    err "end markers on line(s): ${END_LINES:-none}"
    refuse "leave exactly one block in place and run this again. Nothing has been changed."
  fi
  if [ "$N_START" -ne "$N_END" ]; then
    err "$CONFIG has a spechub terminal-workspace fence that does not pair up:"
    err "start markers on line(s): ${START_LINES:-none}"
    err "end markers on line(s): ${END_LINES:-none}"
    refuse "repair the fence by hand and run this again. Nothing has been changed."
  fi

  scan_config "$CONFIG"

  if [ "$UNTERMINATED" -eq 1 ]; then
    refuse "$CONFIG opens a spechub terminal-workspace block on line ${START_LINES:-?}and never closes it. Repair it by hand and run this again. Nothing has been changed."
  fi
  if [ -n "$UNMANAGED_LINES" ]; then
    err "$CONFIG already defines a $BLOCK_TABLE table on line(s): $UNMANAGED_LINES"
    err "That table is outside the managed block, so writing the block would define $BLOCK_TABLE twice and herdr would no longer be able to read the file."
    refuse "move that table inside the block, or delete it, and run this again. Nothing has been changed."
  fi

  if [ "$N_START" -eq 1 ]; then
    if [ "$BLOCK_FOUND" = "$BLOCK_WANTED" ]; then
      ACTION="none"
      SKIP_REASON="the block is already exactly right"
    else
      ACTION="replace"
    fi
  else
    ACTION="append"
  fi
fi

case "$ACTION" in
  create)  DETAIL="the file does not exist yet, so it is created holding just the block" ;;
  append)  DETAIL="the file exists without the block, so the block is added at the end" ;;
  replace) DETAIL="the file holds an out-of-date block, so those lines are replaced in place" ;;
  *)       DETAIL="" ;;
esac

# --- the write -------------------------------------------------------------

# The whole new file, on stdout. Lines outside the block are reproduced exactly
# and in order; only the block's four lines come from us.
render_new_config() {
  local line inside=0 had_content=0
  case "$ACTION" in
    create)
      render_block
      ;;
    append)
      while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\n' "$line"
        had_content=1
      done < "$CONFIG"
      [ "$had_content" -eq 1 ] && printf '\n'
      render_block
      ;;
    replace)
      while IFS= read -r line || [ -n "$line" ]; do
        if [ "$inside" -eq 0 ] && [ "$line" = "$BLOCK_START" ]; then
          inside=1
          render_block
          continue
        fi
        if [ "$inside" -eq 1 ]; then
          [ "$line" = "$BLOCK_END" ] && inside=0
          continue
        fi
        printf '%s\n' "$line"
      done < "$CONFIG"
      ;;
  esac
}

# The one function in this script that writes anything. It stages the new file
# beside the old one and moves it into place, so a config file is either the old
# one or the new one and never a half-written mixture.
write_config() {
  local dir tmp mode=""

  dir="$(dirname "$CONFIG")"
  mkdir -p "$dir" || { err "could not create $dir"; return 1; }

  tmp="$(mktemp "$dir/.herdr-config.XXXXXX")" || {
    err "could not create a temporary file in $dir"; return 1; }

  if ! render_new_config > "$tmp"; then
    rm -f "$tmp"; err "could not write the new config to $tmp"; return 1
  fi

  [ -f "$CONFIG" ] && mode="$(stat -c '%a' "$CONFIG" 2>/dev/null || true)"

  if ! mv -f "$tmp" "$CONFIG"; then
    rm -f "$tmp"; err "could not move the new config into $CONFIG"; return 1
  fi

  # mktemp makes the staged file private; give the config back the permissions
  # it had, or the ordinary ones if it is new.
  chmod "${mode:-644}" "$CONFIG" || { err "could not restore the mode of $CONFIG"; return 1; }
}

# --- reporting -------------------------------------------------------------

step_line() { # $1=number $2=description $3=needed $4=reason
  local status
  if [ "$3" -eq 1 ]; then
    if [ "$MODE" = "plan" ]; then status="[todo]"; else status="[done]"; fi
  else
    if [ "$MODE" = "plan" ]; then status="[skip: $4]"; else status="[skipped: $4]"; fi
  fi
  printf '[%s/%s] %s %s\n' "$1" "$TOTAL" "$2" "$status"
}

# --- run -------------------------------------------------------------------

if [ "$MODE" = "plan" ]; then
  printf '%s: plan only. Nothing on this machine is changed.\n\n' "$PROG"
else
  printf '%s: applying.\n\n' "$PROG"
fi

NEEDED=1
[ "$ACTION" = "none" ] && NEEDED=0

# The work comes first, so that a failure never gets to print [done].
if [ "$NEEDED" -eq 1 ] && [ "$MODE" = "apply" ]; then
  write_config || fail "could not write the worktrees block into $CONFIG"
fi

step_line 1 "worktrees block in $CONFIG" "$NEEDED" "$SKIP_REASON"

if [ "$NEEDED" -eq 1 ]; then
  printf '      %s:\n' "$DETAIL"
  render_block | sed 's/^/      /'
fi

printf '\n'
printf 'Nothing here needs root: the only file touched is %s.\n' "$CONFIG"
