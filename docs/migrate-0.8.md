# Migrating to SpecHub 0.8.0

*Delete one `@import` line from your project `CLAUDE.md`, and nothing else.*

A project initialized before version 0.8.0 holds a line like this in its `CLAUDE.md`:

```
@import /home/<user>/.claude/plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md
```

As of 0.8.0 a SessionStart hook loads the orchestrator instructions, and it always resolves to the currently installed plugin version.

## 1. Why remove it

*Three reasons, and any one of them is enough.*

- **Silent staleness** – the path pins your project to a single plugin version
    - An upgrade leaves the `@import` pointing at old orchestrator rules
- **Time-bomb breakage** – Claude Code cleans an orphaned plugin version out of its cache after 7 days, and the pinned path then 404s
- **Duplication** – leaving the line in place under 0.8.0 or later loads the same content twice

## 2. What to do

1. Open your project's `CLAUDE.md`.
2. Remove any line matching `@import .../plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md`.
3. Save the file.

The hook loads SpecHub's orchestrator instructions next time you start a session in that project. Nothing else changes.
