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

The CLI ships **pre-built and bundled**: `cli/dist/index.js` is a single self-contained file with every runtime dependency (commander, chalk, fast-glob, yaml, zod) inlined by esbuild. Claude Code marketplace plugins are clone-and-run – there is no `npm install` step downstream, so the bundle must work with no `node_modules/` next to it.

After any change in `cli/src/`:

```
cd cli
npm install     # only needed when package.json changed
npm run build   # rebuilds dist/index.js via esbuild (see build.mjs)
npm run typecheck  # tsc --noEmit, catches type errors the bundler skips
git add src/ dist/ package.json package-lock.json
```

Both `src/` and `dist/` belong in the same commit. A stale `dist/` ships broken or misleading behavior to every downstream user until the next release.

To verify the bundle survives a fresh install, park `node_modules/` and exercise the bin wrapper:

```
mv node_modules /tmp/nm-park && node bin/spechub.js --help; mv /tmp/nm-park node_modules
```

If the bundle is healthy, this prints the full subcommand list. If it throws `Dynamic require of "node:..."`, the esbuild banner in `build.mjs` regressed.

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

This runs `npm run build` (esbuild) only when `cli/src/` is part of the staged diff, then stages the regenerated `dist/`. If the build fails, the commit aborts.

## Releasing

1. Bump `.claude-plugin/plugin.json` version. Use semver – patch for fixes, minor for features, major for breaking changes.
2. Confirm `cli/dist/` is up to date (the pre-commit hook handles this if installed).
3. Commit via `/commit` from the marketplace repo – it handles the submodule + parent ordering.
4. The Claude Code plugin cache only repulls when the version changes, so the bump is what triggers downstream upgrades.

## Writing standards

Prose follows the `writing` skill in `skills/writing/`. It covers every durable
artifact this repository ships, the skill files and these docs included.
