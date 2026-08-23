#!/usr/bin/env bash
# Which worktree orchestrator should this session drive?
#
# Two independent facts, reported as four key=value lines on stdout:
#
#   declared – which orchestrator is INSTALLED on this host, as recorded in the
#              SpecHub global config under host.orchestrator. One of herdr,
#              orca, none, unset.
#   detected – which orchestrator is actually HOSTING this Claude session, read
#              from the environment markers an orchestrator injects into the
#              terminals it opens. One of herdr, orca, none.
#   active   – the orchestrator to drive. Always equals detected: installed is
#              not the same as hosting, and hosting is what can be driven.
#   warning  – one plain-language sentence when the two disagree or something
#              could not be read. Empty when there is nothing to say.
#
# Read-only: writes no files, runs no git command, changes no config.
# Always exits 0 – a caller that cannot read the report has nothing to fall
# back on, so every failure is reported in-band as a warning instead.

set -u

declared="unset"
detected="none"
warning=""

# --- declared -----------------------------------------------------------

# The invariant absolute path the SessionStart hook maintains. Invoked by full
# path on purpose: PATH is not reliable inside a fresh agent subshell.
# Defaulted because set -u would abort on a stripped HOME, printing nothing.
cli="${HOME:-}/.claude/spechub/bin/spechub"

# A directory carries the execute bit as permission to traverse it, so -x alone
# would let one through to be run and fail as a generic tool failure. Requiring
# a regular file keeps every "not there in a runnable form" case on one branch.
if [ -z "${HOME:-}" ]; then
  # A path quoted back from an empty HOME would start at the filesystem root
  # and read as a bug, so this case names the missing home instead.
  warning="The SpecHub command line tool could not be looked for because this session has no home directory set, so this host's declared orchestrator could not be read; restarting Claude Code from a normal shell gives it one."
elif [ ! -f "$cli" ] || [ ! -x "$cli" ]; then
  # Missing, not a file, or non-executable are the same problem to the user,
  # and the same fix: the SessionStart hook re-creates the symlink on the next
  # start.
  warning="The SpecHub command line tool could not be run at ${cli}, so this host's declared orchestrator could not be read; restarting Claude Code re-creates it."
else
  cli_out="$("$cli" config get host.orchestrator 2>/dev/null)"
  cli_code=$?

  # Strip any newline first so a value can never break the one-line-per-key
  # output contract, then trim surrounding whitespace.
  cli_value="$(printf '%s' "$cli_out" | tr -d '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  if [ "$cli_code" -eq 0 ]; then
    case "$cli_value" in
      herdr|orca|none) declared="$cli_value" ;;
      "")
        # Success plus nothing said is not the same as the unset code below, so
        # it gets its own sentence – quoting an empty value back at the reader
        # would look like a bug report rather than an explanation.
        warning="The SpecHub command line tool returned an empty answer when asked for host.orchestrator, so no orchestrator is treated as declared."
        ;;
      *)
        warning="The SpecHub global config records host.orchestrator as \"${cli_value}\", which is not an orchestrator this skill knows how to drive, so no orchestrator is treated as declared."
        ;;
    esac
  elif [ "$cli_code" -eq 2 ]; then
    # Exit 2 is the CLI's "this key is unset" code. Not having declared an
    # orchestrator is a normal state, so it is not worth a warning by itself.
    :
  else
    warning="The SpecHub command line tool failed when asked for host.orchestrator, so this host's declared orchestrator could not be read."
  fi
fi

# --- detected -----------------------------------------------------------

# An orchestrator marks the terminals it opens. An exported-but-empty variable
# is a leftover, not a marker, so both families test for non-empty.
herdr_marks="no"
orca_marks="no"
[ -n "${HERDR_ENV:-}" ] && herdr_marks="yes"
[ -n "${HERDR_PANE_ID:-}" ] && herdr_marks="yes"
[ -n "${ORCA_PANE_KEY:-}" ] && orca_marks="yes"

if [ "$herdr_marks" = "yes" ] && [ "$orca_marks" = "yes" ]; then
  # Both families of markers at once: one orchestrator was probably launched
  # from inside the other. Believe the installed one when it is one of the
  # two, since that is the one the user set up deliberately.
  case "$declared" in
    orca) detected="orca" ;;
    *) detected="herdr" ;;
  esac
  ambiguous="yes"
elif [ "$herdr_marks" = "yes" ]; then
  detected="herdr"
  ambiguous="no"
elif [ "$orca_marks" = "yes" ]; then
  detected="orca"
  ambiguous="no"
else
  detected="none"
  ambiguous="no"
fi

active="$detected"

# --- warning ------------------------------------------------------------

# At most one warning is ever printed, so this is a first-match ladder. A
# failure to read the declared orchestrator is reported ahead of everything
# else, because it is the only case with an action the user can take now.
if [ -z "$warning" ] && [ "$ambiguous" = "yes" ]; then
  warning="This session carries environment markers from both herdr and orca, so ${detected} was picked as the one hosting it."
fi

if [ -z "$warning" ]; then
  case "${declared}:${detected}" in
    herdr:none|orca:none)
      warning="${declared} is declared as this host's orchestrator but is not hosting this session, so plain git worktrees will be used instead."
      ;;
    herdr:orca|orca:herdr)
      warning="${declared} is declared as this host's orchestrator but ${detected} is hosting this session, so ${detected} will be used."
      ;;
    unset:herdr|unset:orca)
      warning="No host.orchestrator is declared for this host but ${detected} is hosting this session; run /spechub:host to declare it."
      ;;
    none:herdr|none:orca)
      warning="This host declares no orchestrator but ${detected} is hosting this session, so ${detected} will be used anyway."
      ;;
  esac
fi

printf 'declared=%s\n' "$declared"
printf 'detected=%s\n' "$detected"
printf 'active=%s\n' "$active"
printf 'warning=%s\n' "$warning"

exit 0
