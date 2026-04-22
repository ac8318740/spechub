# Contributing to SpecHub

## Plugin layout

```
.claude-plugin/plugin.json   – plugin manifest (version, name, description)
agents/                      – subagent definitions
hooks/                       – SessionStart hook (CLI symlink + orchestrator injection)
skills/                      – slash-command skills
cli/                         – Node.js CLI (TypeScript source + built dist/)
TROUBLESHOOTING.md           – downstream install diagnostics for Claude Code
```

## CLI build discipline

The CLI ships **pre-built**: `cli/dist/` is committed alongside `cli/src/`. Claude Code marketplace plugins are clone-and-run – there is no install step that can build for downstream users.

After any change in `cli/src/`:

```
cd cli
npm install     # only needed when package.json changed
npm run build
git add src/ dist/ package.json package-lock.json
```

Both `src/` and `dist/` belong in the same commit. A stale `dist/` ships broken or misleading behavior to every downstream user until the next release.

### Recommended pre-commit hook

Drop this into `.git/hooks/pre-commit` inside the spechub clone (not the marketplace parent), then `chmod +x .git/hooks/pre-commit`. Git ignores hook files, so this stays per-clone.

```bash
#!/usr/bin/env bash
# Auto-rebuild cli/dist when cli/src changed and stage the result.
set -euo pipefail

if git diff --cached --name-only | grep -q '^cli/src/'; then
  echo "pre-commit: cli/src changed – rebuilding dist/"
  (cd cli && npm run build)
  git add cli/dist
fi
```

This runs `tsc` only when `cli/src/` is part of the staged diff, then stages the regenerated `dist/`. If `tsc` fails, the commit aborts.

## Releasing

1. Bump `.claude-plugin/plugin.json` version. Use semver – patch for fixes, minor for features, major for breaking changes.
2. Confirm `cli/dist/` is up to date (the pre-commit hook handles this if installed).
3. Commit via `/commit` from the marketplace repo – it handles the submodule + parent ordering.
4. The Claude Code plugin cache only repulls when the version changes, so the bump is what triggers downstream upgrades.

## Writing standards

Match the marketplace repo's standards:

- En dashes (–), never em dashes.
- Short sentences. Plain words.
- Active voice.
- No filler, no marketing tone.
