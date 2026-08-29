#!/bin/sh
# Per-turn reminder for the ac-writing-style output style.
#
# Built-in styles (Concise, Proactive) carry a `turnReminder` field that the CLI
# re-injects every turn. A file-based output style cannot set one: the
# frontmatter schema accepts only name, description, keep-coding-instructions
# and force-for-plugin. This hook supplies the equivalent.
#
# The reminder text is EXTRACTED from output-styles/ac-writing-style.md on every
# turn, never stored. A hand-typed copy drifts from the style the moment either
# one changes, and that is exactly what happened to the first version of this
# hook. Two parts come out of the file:
#
#   1. "## Who you are", top-level lines only, which is the persona
#   2. "## Before you send", in full, which is the checklist
#
# Output is JSON only, with suppressOutput true, so nothing reaches the user's
# transcript. The hook stays silent unless the active output style is this one.

set -u

# Drain stdin so the CLI never sees a broken pipe.
{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :

silent() { printf '{}\n'; exit 0; }

# --------------------------------------------------------------------------
# Gate: only speak when ac-writing-style is the active output style.
# --------------------------------------------------------------------------

read_style() {
  [ -f "$1" ] || return 1
  sed -n 's/.*"outputStyle"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1
}

# Project settings win over user settings, the same order the CLI resolves them.
style=$(read_style ".claude/settings.local.json" || true)
[ -n "${style:-}" ] || style=$(read_style ".claude/settings.json" || true)
[ -n "${style:-}" ] || style=$(read_style "${HOME}/.claude/settings.json" || true)

case "${style:-}" in
  *ac-writing-style|*ac-agentic-coding-writing) ;;
  *) silent ;;
esac

# --------------------------------------------------------------------------
# Locate the output style the reminder derives from.
# --------------------------------------------------------------------------

root="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$root" ] || root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
style_file="${root}/output-styles/ac-writing-style.md"

[ -r "$style_file" ] || silent

# --------------------------------------------------------------------------
# Extract, escape, and emit.
# --------------------------------------------------------------------------

awk '
  function esc(s) {
    gsub(/\\/, "\\\\", s)
    gsub(/"/, "\\\"", s)
    gsub(/\t/, "\\t", s)
    return s
  }
  function emit(s) { out = out esc(s) "\\n" }

  # "## Who you are" holds the persona. Keep its top-level lines: the italic
  # opener, the bold rules, and the unindented bullets. Drop the sub-bullets,
  # because the reminder names each rule and the file itself argues for it.
  /^## Who you are$/            { persona = 1; next }
  /^## Shape: Minto pyramid$/   { persona = 0 }
  persona && /^[*-]/            { emit($0); next }
  persona && /^\*\*/            { emit($0); next }

  # "## Before you send" is the checklist, and it runs to the end of the file.
  /^## Before you send$/        { checklist = 1; emit(""); emit($0); next }
  checklist                     { emit($0); next }

  END {
    if (out == "") exit 1
    printf "{\"suppressOutput\": true, \"hookSpecificOutput\": {\"hookEventName\": \"UserPromptSubmit\", \"additionalContext\": \"ac-writing-style reminder\\n\\n%s\"}}\n", out
  }
' "$style_file" || silent
