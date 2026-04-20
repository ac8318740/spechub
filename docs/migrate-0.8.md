# Migrating to SpecHub 0.8.0

If you initialized SpecHub before version 0.8.0, your project `CLAUDE.md` contains a line like:

```
@import /home/<user>/.claude/plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md
```

You can delete it. As of 0.8.0, the orchestrator instructions load automatically via a SessionStart hook that always resolves to the currently installed plugin version.

## Why remove it

- **Silent staleness.** The path pins your project to a single plugin version. Upgrades leave the `@import` pointing at old orchestrator rules.
- **Time-bomb breakage.** Claude Code cleans up orphaned plugin versions from its cache after 7 days. Once the pinned version is gone, the `@import` path 404s.
- **Duplication.** Leaving the line in place while running 0.8.0+ loads the same content twice – harmless but wasteful.

## What to do

1. Open your project's `CLAUDE.md`.
2. Remove any line matching `@import .../plugins/cache/ac8318740-plugins/spechub/<version>/CLAUDE.md`.
3. Save the file. No other changes needed.

Next time you start a session in that project, SpecHub's orchestrator instructions load via the hook – nothing else is required.
