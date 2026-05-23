#!/usr/bin/env bash
# SpecHub SessionStart hook.
#
# Two symlinks get refreshed on every session start:
#
#   1. ~/.claude/spechub/bin/spechub – the **agent-facing** invariant path. Every
#      skill and agent in this plugin invokes the CLI through this exact path.
#      It is referenced by absolute path (no PATH, no env-var propagation, no
#      shell-rc setup), and the hook re-resolves it to the current plugin cache
#      version on every session start. Survives version bumps; survives stale
#      caches; survives subshell PATH inheritance issues.
#
#   2. ~/.local/bin/spechub – the **human convenience** symlink. Lets users type
#      `spechub` at a terminal if ~/.local/bin is on PATH. Not load-bearing for
#      agents – if it breaks, nothing in the plugin breaks.
#
# Both symlinks point at ${CLAUDE_PLUGIN_ROOT}/cli/bin/spechub.js, which is a
# tiny node wrapper that loads ../dist/index.js.
#
# When a project is initialized (spechub/project.yaml exists), the hook also
# injects the plugin's orchestrator CLAUDE.md as additionalContext so installs
# stay version-agnostic. Otherwise prints a one-line reminder.

set -u

plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
troubleshoot="${plugin_root}/TROUBLESHOOTING.md"
cli_wrapper="${plugin_root}/cli/bin/spechub.js"
cli_dist="${plugin_root}/cli/dist/index.js"

# Symlink $link to point at $src. Reports linked / updated / unchanged.
# Args: $1 = source target, $2 = link path, $3 = human label for the log message.
# Echoes a one-line status to stderr when a change happens or a warning fires.
link_cli() {
  local src="$1"
  local link="$2"
  local label="$3"
  local dir
  dir=$(dirname "$link")

  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    mkdir -p "$dir" 2>/dev/null
    if ln -s "$src" "$link" 2>/dev/null; then
      echo "spechub: linked ${label} at ${link} -> ${src}" >&2
    else
      echo "spechub: failed to create symlink at ${link} – see ${troubleshoot} (section: command not found)." >&2
    fi
  elif [ -L "$link" ]; then
    local current
    current=$(readlink "$link")
    if [ "$current" != "$src" ]; then
      if ln -sfn "$src" "$link" 2>/dev/null; then
        echo "spechub: updated ${label} at ${link} -> ${src}" >&2
      else
        echo "spechub: failed to update stale symlink at ${link} (was: ${current}) – see ${troubleshoot} (section: stale cache)." >&2
      fi
    fi
  elif [ -e "$link" ]; then
    echo "spechub: ${link} exists but is not a symlink – not overwriting. See ${troubleshoot} (section: command not found)." >&2
  fi
}

if [ -n "$plugin_root" ] && [ -f "$cli_wrapper" ]; then
  if [ ! -f "$cli_dist" ]; then
    echo "spechub: CLI is missing its built output (${cli_dist})." >&2
    echo "spechub: this should not happen for a published version – see ${troubleshoot} (section: ERR_MODULE_NOT_FOUND)." >&2
  else
    # Agent-facing invariant path. Skills/agents invoke this directly.
    link_cli "$cli_wrapper" "${HOME}/.claude/spechub/bin/spechub" "agent CLI"

    # Human-convenience path. Only useful when ~/.local/bin is on PATH.
    human_link="${HOME}/.local/bin/spechub"
    link_cli "$cli_wrapper" "$human_link" "human CLI"

    if [ -L "$human_link" ]; then
      case ":${PATH}:" in
        *":${HOME}/.local/bin:"*) ;;
        *)
          # The human symlink exists but PATH won't pick it up. This only affects
          # humans typing `spechub` at a terminal – agents are unaffected because
          # they use the absolute ~/.claude/spechub/bin/spechub path.
          rc_hint="~/.profile"
          case "${SHELL:-}" in
            */zsh) rc_hint="~/.zshrc" ;;
            */bash) rc_hint="~/.bashrc (Linux) or ~/.bash_profile (macOS)" ;;
            */fish) rc_hint="~/.config/fish/config.fish" ;;
          esac
          echo "spechub: ~/.local/bin is not on PATH – typed \`spechub\` won't work. Add this to ${rc_hint} and restart the shell:" >&2
          echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
          echo "spechub: agents and skills are unaffected – they use ~/.claude/spechub/bin/spechub directly. See ${troubleshoot} for details." >&2
          ;;
      esac
    fi
  fi
fi

# --- Playwriter bridge: keep deployed scripts current with the plugin cache ---
# The bridge runs as OS scheduled tasks (Windows) and an on-demand helper (VM)
# that live outside the plugin, so a plugin update alone never reaches them.
# Reconcile them here, the same way the CLI symlink above is reconciled. Both
# branches no-op unless the bridge is actually present on this machine.
if [ -n "$plugin_root" ]; then
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      # Windows: copy changed bridge scripts out of the cache and restart only
      # the affected tasks. sync.ps1 self-gates on "bridge installed".
      sync_ps1="${plugin_root}/assets/playwriter-bridge/sync.ps1"
      if [ -f "$sync_ps1" ] && command -v powershell.exe >/dev/null 2>&1; then
        win_root=$(cygpath -w "$plugin_root" 2>/dev/null || printf '%s' "$plugin_root")
        win_sync=$(cygpath -w "$sync_ps1" 2>/dev/null || printf '%s' "$sync_ps1")
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$win_sync" -PluginRoot "$win_root" >&2 2>&1 || true
      fi
      ;;
    Linux|Darwin)
      # VM / macOS: vm-free-port.sh is invoked on demand, so a symlink to the
      # cache copy keeps it current with no copy and no restart - mirrors the
      # agent-facing CLI symlink. Skips silently if the helper is not shipped.
      vmfp_src="${plugin_root}/assets/playwriter-bridge/vm-free-port.sh"
      vmfp_link="${HOME}/.claude/spechub/bin/vm-free-port.sh"
      if [ -f "$vmfp_src" ]; then
        link_cli "$vmfp_src" "$vmfp_link" "vm-free-port.sh"
      fi
      ;;
  esac
fi

if [ ! -f spechub/project.yaml ]; then
  echo 'spechub: no project config found. Run /spechub:init to set up.' >&2
  exit 0
fi

claude_md="${plugin_root}/CLAUDE.md"

if [ -z "$plugin_root" ] || [ ! -r "$claude_md" ]; then
  echo "spechub: could not read orchestrator CLAUDE.md (CLAUDE_PLUGIN_ROOT=${plugin_root:-unset})" >&2
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo 'spechub: python3 not found; skipping orchestrator injection' >&2
  exit 0
fi

python3 - "$claude_md" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": content,
    }
}))
PY

exit 0
