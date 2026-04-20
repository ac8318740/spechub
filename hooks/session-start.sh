#!/usr/bin/env bash
# SpecHub SessionStart hook.
# When a project is initialized (spechub/project.yaml exists), injects the
# plugin's orchestrator CLAUDE.md into the session as additionalContext so
# installs stay version-agnostic. Otherwise prints a one-line reminder.

set -u

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
