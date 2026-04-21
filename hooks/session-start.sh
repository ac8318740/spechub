#!/usr/bin/env bash
# SpecHub SessionStart hook.
# 1. Auto-links the bundled CLI to ~/.local/bin/spechub so users can run
#    `spechub` directly without hardcoding a version-pinned cache path.
# 2. When a project is initialized (spechub/project.yaml exists), injects the
#    plugin's orchestrator CLAUDE.md into the session as additionalContext so
#    installs stay version-agnostic. Otherwise prints a one-line reminder.

set -u

cli_source="${CLAUDE_PLUGIN_ROOT:-}/cli/bin/spechub.js"
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$cli_source" ]; then
  bin_dir="${HOME}/.local/bin"
  link="${bin_dir}/spechub"
  action=""

  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    mkdir -p "$bin_dir" 2>/dev/null
    if ln -s "$cli_source" "$link" 2>/dev/null; then
      action="linked"
    fi
  elif [ -L "$link" ]; then
    current=$(readlink "$link")
    if [ "$current" != "$cli_source" ]; then
      if ln -sfn "$cli_source" "$link" 2>/dev/null; then
        action="updated"
      fi
    fi
  fi

  if [ -n "$action" ]; then
    echo "spechub: $action CLI at $link" >&2
    case ":${PATH}:" in
      *":${bin_dir}:"*) ;;
      *) echo "spechub: add $bin_dir to your PATH to use the 'spechub' command" >&2 ;;
    esac
  fi
fi

if [ ! -f spechub/project.yaml ]; then
  echo 'spechub: no project config found. Run /spechub:init to set up.' >&2
  exit 0
fi

claude_md="${CLAUDE_PLUGIN_ROOT:-}/CLAUDE.md"

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || [ ! -r "$claude_md" ]; then
  echo "spechub: could not read orchestrator CLAUDE.md (CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT:-unset})" >&2
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
