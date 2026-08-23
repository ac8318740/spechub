#!/usr/bin/env bash
# SpecHub host detection.
#
# Reports what dev-setup tooling exists on this machine, as one JSON object on
# stdout. Nothing else is printed, and the exit code is 0 whenever detection
# ran - a bare machine with none of the tooling installed is a perfectly valid
# answer, not a failure. Missing tooling is a finding, never an error.
#
# The script is strictly read-only. It never writes a file, never changes a
# setting and never installs anything. Callers - a skill deciding how to set up
# browser verification, say - use the facts here to choose, and any change is
# made by the caller afterwards, with the user watching.
#
# Every tool is looked up on PATH with `command -v` and every home path derives
# from $HOME. Nothing is hardcoded to an absolute location. That is what makes
# this testable: tests/test-host-detect.sh runs the script under `env -i` with a
# PATH of fake executables and a temporary HOME, so the output is entirely
# determined by what the test wired up. Reaching past PATH or $HOME to a real
# location would defeat that, so don't.
#
# Output is built by hand rather than with jq, because jq is one of the things a
# bare machine may not have, and needing a JSON tool to report that you have no
# tools would be a poor joke.

set -u

usage() {
  cat <<'USAGE'
detect-host.sh - report this machine's dev-setup tooling as JSON.

Usage:
  detect-host.sh          Detect and print one JSON object to stdout.
  detect-host.sh --help   Print this help and exit.

The script is read-only: it inspects PATH, environment variables, $HOME and the
current git repository, and changes nothing. It exits 0 whenever detection ran,
including on a machine where nothing is installed - absent tooling is reported
in the JSON, not as an error.

Reported sections: orchestrator, browser, preview, element_picker,
orca_topology, claude_settings, project.
USAGE
}

case "${1-}" in
  "") ;;
  --help|-h) usage; exit 0 ;;
  *) echo "detect-host.sh: unknown argument: $1" >&2
     echo "detect-host.sh: run with --help for usage." >&2
     exit 64 ;;
esac

# --- helpers ---------------------------------------------------------------

# A JSON string literal for $1, or the bare literal null when $1 is empty. Paths
# come from the filesystem, so a backslash or a quote in one is unlikely - but a
# single unescaped quote would make the whole object unparseable, and the caller
# would see a tool crash instead of a finding.
json_str() {
  local s="$1"
  if [ -z "$s" ]; then printf 'null'; return; fi
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# Absolute path of $1 if it is on PATH, empty string otherwise. The `|| true`
# matters: a missing tool is the normal case here, not a reason to stop.
which_path() {
  command -v "$1" 2>/dev/null || true
}

# Some of the tools below talk to a background daemon over a local socket, and a
# wedged daemon makes them wait for ever rather than fail. This script is run
# from a skill with a user watching, so a hang there is worse than a missing
# finding: bound every such call to three seconds, the same bound the curl probe
# already uses.
#
# `timeout` is itself just a command on PATH, and it is not on every machine, so
# resolve it once and treat its absence as normal. When it is missing the call
# still runs, just unbounded - a slightly worse outcome than a bounded call, and
# a much better one than not detecting at all.
timeout_bin="$(which_path timeout)"

# Run "$@" with the three-second bound when `timeout` is available, and plainly
# when it is not. The exit status and output are the command's own either way;
# a call that is cut short simply produces no output, which every caller here
# already reads as "no evidence".
run_bounded() {
  if [ -n "$timeout_bin" ]; then
    "$timeout_bin" 3 "$@"
  else
    "$@"
  fi
}

# --- orchestrator ----------------------------------------------------------

herdr_bin="$(which_path herdr)"

# Orca ships its executable as `orca-ide`; older installs put it on PATH as
# plain `orca`. Prefer the current name and fall back.
orca_bin="$(which_path orca-ide)"
[ -n "$orca_bin" ] || orca_bin="$(which_path orca)"

# Which orchestrator is hosting the session we are running inside, judged by the
# variable each one exports into its panes. Orca wins when both are set: a herdr
# pane can host an orca session, but not the other way round.
if [ -n "${ORCA_PANE_KEY:-}" ]; then
  hosting="orca"
elif [ -n "${HERDR_ENV:-}" ]; then
  hosting="herdr"
else
  hosting="none"
fi

# Whatever is already hosting us is the right answer - switching orchestrators
# mid-session helps nobody. Otherwise recommend what is installed, herdr first.
if [ "$hosting" != "none" ]; then
  orchestrator_rec="$hosting"
elif [ -n "$herdr_bin" ]; then
  orchestrator_rec="herdr"
elif [ -n "$orca_bin" ]; then
  orchestrator_rec="orca"
else
  orchestrator_rec="none"
fi

# --- browser ---------------------------------------------------------------

agent_browser_bin="$(which_path agent-browser)"

# The Playwriter bridge forwards a real browser's DevTools port to localhost
# 19988. If something answers there, remote verification is available. The
# timeout is short and deliberate: a host that has gone away should cost us
# three seconds, not hang a skill the user is waiting on.
bridge_answers="false"
if [ -n "$(which_path curl)" ]; then
  if curl -fsS --max-time 3 "http://localhost:19988/json/version" >/dev/null 2>&1; then
    bridge_answers="true"
  fi
fi

# Chromium-family browsers, in preference order. Any one of them can drive
# headless verification, so we report all we find and let the caller pick.
chromium_json=""
chromium_found="false"
for browser in chromium chromium-browser google-chrome google-chrome-stable \
               brave-browser microsoft-edge; do
  p="$(which_path "$browser")"
  [ -n "$p" ] || continue
  [ -z "$chromium_json" ] || chromium_json="${chromium_json},"
  chromium_json="${chromium_json}$(json_str "$p")"
  chromium_found="true"
done

# A graphical session of either flavour. Without one, a browser can still run
# headless, but nobody can watch it.
if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
  display="true"
else
  display="false"
fi

browser_remote="$bridge_answers"
browser_headless="$chromium_found"
if [ "$chromium_found" = "true" ] && [ "$display" = "true" ]; then
  browser_local="true"
else
  browser_local="false"
fi

# --- preview (tailscale) ---------------------------------------------------

tailscale_bin="$(which_path tailscale)"

# An installed tailscale that nobody has logged in is no use for sharing a
# preview URL, so the two facts are reported separately.
tailscale_logged_in="false"
if [ -n "$tailscale_bin" ]; then
  # Bounded: `tailscale status` asks the local tailscaled daemon over a socket
  # and never returns on its own if that daemon is wedged.
  if run_bounded "$tailscale_bin" status --json 2>/dev/null \
     | grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
    tailscale_logged_in="true"
  fi
fi

if [ -n "$tailscale_bin" ] && [ "$tailscale_logged_in" = "true" ]; then
  preview_rec="true"
else
  preview_rec="false"
fi

# --- orca topology ---------------------------------------------------------

# Orca can serve a UI from this machine to a browser elsewhere. A running
# user-level `orca` unit with no local display is the shape of a remote setup:
# the machine serves, somebody else looks. Anything else is local.
serve_unit_active="false"
if [ -n "$(which_path systemctl)" ]; then
  # The unit name `orca` is an assumption, not a fact: whatever provisions the
  # server chooses that name, and nothing pins it yet, so a unit installed under
  # a different name reads here as "no server". Bounded too, because
  # `systemctl --user` waits on the user message bus and blocks when that bus is
  # not available - on a machine with no user session, say.
  if [ "$(run_bounded systemctl --user is-active orca 2>/dev/null)" = "active" ]; then
    serve_unit_active="true"
  fi
fi

if [ -z "$orca_bin" ]; then
  orca_topology_rec=""          # emitted as null: no Orca, so no topology
elif [ "$serve_unit_active" = "true" ] && [ "$display" = "false" ]; then
  orca_topology_rec="remote"
else
  orca_topology_rec="local"
fi

# --- element picker --------------------------------------------------------

stagewise_bin="$(which_path stagewise)"

# Stagewise is the dedicated tool, so it wins outright. Orca's built-in design
# mode is the fallback, but only when Orca is driving a local browser - in a
# remote topology the picker has no window to pick in.
if [ -n "$stagewise_bin" ]; then
  picker_rec="stagewise"
elif [ -n "$orca_bin" ] && [ "$orca_topology_rec" = "local" ]; then
  picker_rec="orca-design-mode"
else
  picker_rec="none"
fi

# --- claude settings -------------------------------------------------------

# Whether Orca has already wired hooks into the user's Claude settings, and
# whether a backup of that file exists. A caller about to edit settings.json
# wants to know both before it touches anything.
settings_file="${HOME}/.claude/settings.json"
orca_hooks_present="false"
# Deliberately loose: any mention of "orca" anywhere in the file counts, so an
# unrelated path or permission entry containing that word sets this too. It is
# evidence that Orca may have touched the file, not proof that it did, and
# callers must word it that way.
if [ -f "$settings_file" ] && grep -qi orca "$settings_file" 2>/dev/null; then
  orca_hooks_present="true"
fi

backup_exists="false"
[ -f "${settings_file}.bak" ] && backup_exists="true"

# --- project ---------------------------------------------------------------

project_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# A top-level `frontend:` key in the project config is what turns on frontend
# verification, so we look for it at column zero only - `frontend:` nested under
# some other key means something else entirely.
has_frontend="false"
if [ -n "$project_root" ] && [ -f "${project_root}/spechub/project.yaml" ]; then
  if grep -q '^frontend:' "${project_root}/spechub/project.yaml" 2>/dev/null; then
    has_frontend="true"
  fi
fi

# --- output ----------------------------------------------------------------

cat <<JSON
{
  "orchestrator": {
    "herdr_binary": $(json_str "$herdr_bin"),
    "orca_binary": $(json_str "$orca_bin"),
    "hosting_this_session": $(json_str "$hosting"),
    "recommended": $(json_str "$orchestrator_rec")
  },
  "browser": {
    "agent_browser_binary": $(json_str "$agent_browser_bin"),
    "bridge_port_answers": ${bridge_answers},
    "chromium_binaries": [${chromium_json}],
    "display": ${display},
    "recommended": {
      "remote": ${browser_remote},
      "headless": ${browser_headless},
      "local": ${browser_local}
    }
  },
  "preview": {
    "tailscale_binary": $(json_str "$tailscale_bin"),
    "tailscale_logged_in": ${tailscale_logged_in},
    "recommended": ${preview_rec}
  },
  "element_picker": {
    "stagewise_binary": $(json_str "$stagewise_bin"),
    "recommended": $(json_str "$picker_rec")
  },
  "orca_topology": {
    "serve_unit_active": ${serve_unit_active},
    "recommended": $(json_str "$orca_topology_rec")
  },
  "claude_settings": {
    "orca_hooks_present": ${orca_hooks_present},
    "backup_exists": ${backup_exists}
  },
  "project": {
    "root": $(json_str "$project_root"),
    "has_frontend": ${has_frontend}
  }
}
JSON
