#!/usr/bin/env bash
# Which worktree orchestrator should this session drive?
#
# Three facts and what they add up to, reported as six key=value lines on stdout:
#
#   declared_herdr – whether this host says it has herdr installed, as recorded
#                    in the SpecHub global config under host.orchestrators.herdr.
#                    One of true, false, unset.
#   declared_orca  – the same for host.orchestrators.orca.
#   detected       – which orchestrator is actually HOSTING this Claude session,
#                    read from the environment markers an orchestrator injects
#                    into the terminals it opens. One of herdr, orca, none.
#   active         – the orchestrator to drive. Always equals detected: installed
#                    is not the same as hosting, and hosting is what can be
#                    driven.
#   owner          – which orchestrator OWNS the checkout being looked at. A
#                    checkout is one git worktree directory. Its path names the
#                    owner: under $HOME/orca/workspaces/ it belongs to orca,
#                    under herdr's worktree root it belongs to herdr, anywhere
#                    else it is plain git. One of herdr, orca, none. The
#                    checkout is this session's working directory, or the path
#                    given as the first argument.
#   warning        – one plain-language sentence when something could not be read
#                    or the facts sit oddly together. Empty when there is
#                    nothing to say.
#
# The two declarations are independent booleans, one per orchestrator, so a host
# can have both installed, one, or neither. There is no single "the declared
# orchestrator" any more.
#
# Owning is not hosting. A herdr checkout opened in a plain terminal is owned by
# herdr and hosted by nobody, so owner=herdr and active=none. The owner only
# joins the reconciliation when both families of markers are present at once,
# where it settles the tie.
#
# Read-only: writes no files, runs no git command, changes no config.
# Always exits 0 – a caller that cannot read the report has nothing to fall
# back on, so every failure is reported in-band as a warning instead.

set -u

declared_herdr="unset"
declared_orca="unset"
detected="none"
warning=""

# The per-axis read problems, kept apart so the warning ladder further down can
# report herdr's before orca's without re-deriving anything.
warn_herdr=""
warn_orca=""

# --- declared -----------------------------------------------------------

# The invariant absolute path the SessionStart hook maintains. Invoked by full
# path on purpose: PATH is not reliable inside a fresh agent subshell.
# Defaulted because set -u would abort on a stripped HOME, printing nothing.
cli="${HOME:-}/.claude/spechub/bin/spechub"

# Ask the CLI for one orchestrator key. Sets axis_value (true, false or unset)
# and axis_warning (empty when there was nothing wrong). $1 is the config key,
# $2 is the orchestrator's name for the sentence.
read_axis() {
  local key="$1" name="$2"
  local out code value

  out="$("$cli" config get "$key" 2>/dev/null)"
  code=$?

  # Strip any newline first so a value can never break the one-line-per-key
  # output contract, then trim surrounding whitespace.
  value="$(printf '%s' "$out" | tr -d '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  axis_value="unset"
  axis_warning=""

  if [ "$code" -eq 0 ]; then
    case "$value" in
      true|false) axis_value="$value" ;;
      "")
        # Success plus nothing said is not the same as the unset code below, so
        # it gets its own sentence – quoting an empty value back at the reader
        # would look like a bug report rather than an explanation.
        axis_warning="The SpecHub command line tool returned an empty answer when asked for ${key}, so whether this host has ${name} is not known."
        ;;
      *)
        axis_warning="The SpecHub global config records ${key} as \"${value}\", which is neither true nor false, so whether this host has ${name} is not known."
        ;;
    esac
  elif [ "$code" -eq 2 ]; then
    # Exit 2 is the CLI's "this key is unset" code. Not declaring an
    # orchestrator is a normal state, so it is not worth a warning by itself.
    :
  else
    axis_warning="The SpecHub command line tool failed when asked for ${key}, so whether this host has ${name} could not be read."
  fi
}

# A directory carries the execute bit as permission to traverse it, so -x alone
# would let one through to be run and fail as a generic tool failure. Requiring
# a regular file keeps every "not there in a runnable form" case on one branch.
if [ -z "${HOME:-}" ]; then
  # A path quoted back from an empty HOME would start at the filesystem root
  # and read as a bug, so this case names the missing home instead.
  warning="The SpecHub command line tool could not be looked for because this session has no home directory set, so this host's declared orchestrators could not be read; restarting Claude Code from a normal shell gives it one."
elif [ ! -f "$cli" ] || [ ! -x "$cli" ]; then
  # Missing, not a file, or non-executable are the same problem to the user,
  # and the same fix: the SessionStart hook re-creates the symlink on the next
  # start.
  #
  # The path is built from HOME, which the caller controls, so a line break in
  # it would split the warning across two lines and break the one-line-per-key
  # output contract. Strip line breaks for the sentence only; the real $cli is
  # what gets tested and run above.
  cli_shown="$(printf '%s' "$cli" | tr -d '\n\r')"
  warning="The SpecHub command line tool could not be run at ${cli_shown}, so this host's declared orchestrators could not be read; restarting Claude Code re-creates it."
else
  read_axis "host.orchestrators.herdr" "herdr"
  declared_herdr="$axis_value"
  warn_herdr="$axis_warning"

  read_axis "host.orchestrators.orca" "orca"
  declared_orca="$axis_value"
  warn_orca="$axis_warning"
fi

# --- owner ---------------------------------------------------------------

# The checkout to examine: the path given as the first argument, or this
# session's working directory when no argument is given.
examined="${1:-.}"

owner="none"

# The physical location of directory $1: symlinks followed and .. segments
# settled. Prints nothing when the path cannot be reached. cd and pwd are shell
# builtins running in a subshell, so this reads the filesystem and changes
# neither it nor this script's own directory.
physical_path() {
  ( cd -P -- "$1" 2>/dev/null && pwd -P ) 2>/dev/null
}

# Whether path $1 sits strictly underneath root $2. Strictly, because the root
# is where checkouts live, not a checkout itself. The pattern is quoted, so the
# match is literal, and the slash stops a sibling whose name merely starts with
# the root's name – .herdr/worktrees-old, say – from counting.
is_under() {
  local path="$1" root="$2"
  [ -n "$root" ] || return 1
  case "$path" in
    "$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# herdr keeps its worktrees under one root. The root is $HOME/.herdr/worktrees
# unless the user moved it, which they do by setting directory in the
# [worktrees] section of $HOME/.config/herdr/config.toml. A leading ~/ there
# means the home directory.
herdr_root_configured() {
  local cfg="$1" value
  [ -f "$cfg" ] && [ -r "$cfg" ] || return 0

  # One pass, first match wins: track which section each line sits in, and read
  # directory only while inside [worktrees]. A quoted value gives up everything
  # between its quotes, so a trailing comment is dropped with it.
  value="$(awk '
    /^[[:space:]]*\[/ {
      s = $0
      sub(/^[[:space:]]*/, "", s)
      sub(/[[:space:]]*$/, "", s)
      section = s
      next
    }
    section == "[worktrees]" {
      s = $0
      sub(/^[[:space:]]*/, "", s)
      if (s ~ /^directory[[:space:]]*=/) {
        sub(/^directory[[:space:]]*=[[:space:]]*/, "", s)
        sub(/[[:space:]]*$/, "", s)
        if (s ~ /^"/) { sub(/^"/, "", s); sub(/".*$/, "", s) }
        print s
        exit
      }
    }
  ' "$cfg" 2>/dev/null | tr -d '\n')"

  printf '%s' "$value"
}

# No home directory means neither root has a location, so nothing can be owned.
if [ -n "${HOME:-}" ]; then
  orca_root="${HOME}/orca/workspaces"

  herdr_root="$(herdr_root_configured "${HOME}/.config/herdr/config.toml")"
  case "$herdr_root" in
    "") herdr_root="${HOME}/.herdr/worktrees" ;;
    "~") herdr_root="$HOME" ;;
    # shellcheck disable=SC2088  # matching a literal "~/" prefix read from config.toml, then expanding it
    "~/"*) herdr_root="${HOME}/${herdr_root#\~/}" ;;
  esac

  # Both sides are compared physically, so a symlink on either one cannot make a
  # checkout look like it lives somewhere it does not. A root that does not
  # exist keeps its written form: nothing can sit under it either way.
  examined_phys="$(physical_path "$examined")"
  orca_root_phys="$(physical_path "$orca_root")"
  [ -n "$orca_root_phys" ] || orca_root_phys="$orca_root"
  herdr_root_phys="$(physical_path "$herdr_root")"
  [ -n "$herdr_root_phys" ] || herdr_root_phys="$herdr_root"

  if [ -n "$examined_phys" ]; then
    if is_under "$examined_phys" "$orca_root_phys" \
       && is_under "$examined_phys" "$herdr_root_phys"; then
      # One root configured inside the other. The deeper root is the more
      # specific answer, so it wins.
      if [ "${#orca_root_phys}" -ge "${#herdr_root_phys}" ]; then
        owner="orca"
      else
        owner="herdr"
      fi
    elif is_under "$examined_phys" "$orca_root_phys"; then
      owner="orca"
    elif is_under "$examined_phys" "$herdr_root_phys"; then
      owner="herdr"
    fi
  fi
fi

# --- detected -----------------------------------------------------------

# An orchestrator marks the terminals it opens. An exported-but-empty variable
# is a leftover, not a marker, so both families test for non-empty. The markers
# are read straight from the environment, never via the CLI, so this still works
# when the CLI is unreadable.
herdr_marks="no"
orca_marks="no"
[ -n "${HERDR_ENV:-}" ] && herdr_marks="yes"
[ -n "${HERDR_PANE_ID:-}" ] && herdr_marks="yes"
[ -n "${ORCA_PANE_KEY:-}" ] && orca_marks="yes"

ambiguous="no"

if [ "$herdr_marks" = "yes" ] && [ "$orca_marks" = "yes" ]; then
  # Both families of markers at once: one orchestrator was probably launched
  # from inside the other.
  #
  # The checkout's owner settles this outright. Working inside a herdr checkout
  # under herdr markers is herdr's session whatever else is exported, so there is
  # nothing ambiguous left to warn about.
  #
  # Failing that, the declarations break the tie only when exactly one of the
  # two is declared true, because that is the only reading with a single obvious
  # answer. Anything else falls back to herdr and says so.
  if [ "$owner" = "herdr" ] || [ "$owner" = "orca" ]; then
    detected="$owner"
  elif [ "$declared_herdr" = "true" ] && [ "$declared_orca" != "true" ]; then
    detected="herdr"
  elif [ "$declared_orca" = "true" ] && [ "$declared_herdr" != "true" ]; then
    detected="orca"
  else
    detected="herdr"
    ambiguous="yes"
  fi
elif [ "$herdr_marks" = "yes" ]; then
  detected="herdr"
elif [ "$orca_marks" = "yes" ]; then
  detected="orca"
else
  detected="none"
fi

active="$detected"

# --- warning ------------------------------------------------------------

# At most one warning is ever printed, so this is a first-match ladder.

# A CLI that cannot be run outranks everything, because it is the only case with
# an action the user can take right now.
if [ -z "$warning" ]; then
  # A read problem on one axis next. herdr is checked before orca so the order
  # is stable rather than whichever happened to fail.
  if [ -n "$warn_herdr" ]; then
    warning="$warn_herdr"
  elif [ -n "$warn_orca" ]; then
    warning="$warn_orca"
  fi
fi

if [ -z "$warning" ] && [ "$ambiguous" = "yes" ]; then
  warning="This session carries environment markers from both herdr and orca, so ${detected} was picked as the one hosting it."
fi

if [ -z "$warning" ] && [ "$detected" != "none" ]; then
  # Something is hosting this session that the host does not claim to have.
  # Nothing is broken, but the config is behind reality and can be corrected.
  # The mirror case is not worth a warning: an orchestrator declared true that
  # is not hosting is just installed, and installed is not hosting.
  #
  # A declaration of false and a missing declaration are different situations,
  # so they get different sentences. False means the user already answered in
  # /spechub:host and said it is not installed, so telling them to declare it
  # would send them back to a question they answered; what they need to hear is
  # that their answer disagrees with what is hosting them. Unset means nothing
  # has been answered yet.
  if [ "$detected" = "herdr" ] && [ "$declared_herdr" != "true" ]; then
    if [ "$declared_herdr" = "false" ]; then
      warning="herdr is hosting this session even though this host declares herdr is not installed; the declaration looks wrong, so run /spechub:host to correct it."
    else
      warning="herdr is hosting this session but nothing has been declared for herdr on this host; run /spechub:host to declare it."
    fi
  elif [ "$detected" = "orca" ] && [ "$declared_orca" != "true" ]; then
    if [ "$declared_orca" = "false" ]; then
      warning="orca is hosting this session even though this host declares orca is not installed; the declaration looks wrong, so run /spechub:host to correct it."
    else
      warning="orca is hosting this session but nothing has been declared for orca on this host; run /spechub:host to declare it."
    fi
  fi
fi

printf 'declared_herdr=%s\n' "$declared_herdr"
printf 'declared_orca=%s\n' "$declared_orca"
printf 'detected=%s\n' "$detected"
printf 'active=%s\n' "$active"
printf 'owner=%s\n' "$owner"
printf 'warning=%s\n' "$warning"

exit 0
