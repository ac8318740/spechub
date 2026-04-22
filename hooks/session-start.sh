#!/usr/bin/env bash
# SpecHub SessionStart hook.
# 1. Auto-links the bundled CLI to ~/.local/bin/spechub so users can run
#    `spechub` directly without hardcoding a version-pinned cache path.
# 2. Diagnoses missing dist/, missing PATH entry, or stale symlinks. All
#    diagnostics name TROUBLESHOOTING.md so downstream Claude Code instances
#    can resolve issues without user hand-holding.
# 3. When a project is initialized (spechub/project.yaml exists), injects the
#    plugin's orchestrator CLAUDE.md into the session as additionalContext so
#    installs stay version-agnostic. Otherwise prints a one-line reminder.

set -u

plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
troubleshoot="${plugin_root}/TROUBLESHOOTING.md"
cli_wrapper="${plugin_root}/cli/bin/spechub.js"
cli_dist="${plugin_root}/cli/dist/index.js"

if [ -n "$plugin_root" ] && [ -f "$cli_wrapper" ]; then
  if [ ! -f "$cli_dist" ]; then
    echo "spechub: CLI is missing its built output (${cli_dist})." >&2
    echo "spechub: this should not happen for a published version – see ${troubleshoot} (section: ERR_MODULE_NOT_FOUND)." >&2
  else
    bin_dir="${HOME}/.local/bin"
    link="${bin_dir}/spechub"
    action=""

    if [ ! -e "$link" ] && [ ! -L "$link" ]; then
      mkdir -p "$bin_dir" 2>/dev/null
      if ln -s "$cli_wrapper" "$link" 2>/dev/null; then
        action="linked"
      else
        echo "spechub: failed to create symlink at ${link} – see ${troubleshoot} (section: command not found)." >&2
      fi
    elif [ -L "$link" ]; then
      current=$(readlink "$link")
      if [ "$current" != "$cli_wrapper" ]; then
        if ln -sfn "$cli_wrapper" "$link" 2>/dev/null; then
          action="updated"
        else
          echo "spechub: failed to update stale symlink at ${link} (was: ${current}) – see ${troubleshoot} (section: stale cache)." >&2
        fi
      fi
    elif [ -e "$link" ]; then
      echo "spechub: ${link} exists but is not a symlink – not overwriting. See ${troubleshoot} (section: command not found)." >&2
    fi

    if [ -n "$action" ]; then
      echo "spechub: ${action} CLI at ${link} -> ${cli_wrapper}" >&2
      case ":${PATH}:" in
        *":${bin_dir}:"*) ;;
        *)
          rc_hint="~/.profile"
          case "${SHELL:-}" in
            */zsh) rc_hint="~/.zshrc" ;;
            */bash) rc_hint="~/.bashrc (Linux) or ~/.bash_profile (macOS)" ;;
            */fish) rc_hint="~/.config/fish/config.fish" ;;
          esac
          echo "spechub: ${bin_dir} is not on PATH. Add this to ${rc_hint} and restart the shell:" >&2
          echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
          echo "spechub: see ${troubleshoot} (section: command not found) for details." >&2
          ;;
      esac
    fi
  fi
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
