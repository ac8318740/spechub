# Contributing to SpecHub

## Plugin layout

```
.claude-plugin/plugin.json   – plugin manifest (version, name, description)
agents/                      – subagent definitions
hooks/                       – SessionStart hook (CLI symlink + orchestrator injection)
skills/                      – slash-command skills
output-styles/               – output styles (ac-writing-style)
cli/                         – Node.js CLI (TypeScript source + built dist/)
TROUBLESHOOTING.md           – downstream install diagnostics for Claude Code
```

## CLI build discipline

The CLI ships **pre-built and bundled**. `cli/dist/index.js` is a single self-contained file, with esbuild inlining every runtime dependency (commander, chalk, fast-glob, yaml, zod) into it. Claude Code clones and runs a marketplace plugin directly, with no `npm install` step downstream. The bundle must work with no `node_modules/` next to it.

After any change in `cli/src/`:

```
cd cli
npm install     # only needed when package.json changed
npm run build   # rebuilds dist/index.js via esbuild (see build.mjs)
npm run typecheck  # tsc --noEmit, catches type errors the bundler skips
npm run lint    # eslint, type-aware rules over src/ (see eslint.config.js)
git add src/ dist/ package.json package-lock.json
```

Both `src/` and `dist/` belong in the same commit. A stale `dist/` ships broken or misleading behavior to every downstream user until the next release.

To verify the bundle survives a fresh install, park `node_modules/` first. Then exercise the bin wrapper:

```
mv node_modules /tmp/nm-park && node bin/spechub.js --help; mv /tmp/nm-park node_modules
```

If the bundle is healthy, this prints the full subcommand list. If it throws `Dynamic require of "node:..."`, the esbuild banner in `build.mjs` regressed.

### Recommended pre-commit hook

Drop this into `.git/hooks/pre-commit` inside the spechub clone (not the marketplace parent). Then run `chmod +x .git/hooks/pre-commit`. Git ignores hook files, so this stays per-clone.

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

This runs `npm run build` (esbuild) only when `cli/src/` is part of the staged diff. It then stages the regenerated `dist/`. If the build fails, the commit aborts.

## Testing

The repo has two test layers. Run `cd cli && npm test` for the CLI tests. Run `bash tests/run-all.sh` for the hook suites.

## Releasing

CI enforces the version bump. The `version-gate` check runs on every pull
request to `main` and fails when the change touches a shipped path without
raising the version in `.claude-plugin/plugin.json`.

A **shipped path** is a file that an installed copy of the plugin loads or
runs, so a change to it must roll out to every machine. The Claude Code plugin
cache only re-pulls a plugin when its version changes, so a merge to `main`
that leaves the version alone is invisible to every installed copy. That is
what the gate exists to prevent.

### Inert paths

Everything is a shipped path except the list below. These files never reach an
installed copy, so changing them needs no bump:

```
README.md
CONTRIBUTING.md
CONTEXT.md
LICENSE
THIRD_PARTY_NOTICES
docs/adr/**
docs/migrate-0.8.md
tests/**
.github/**
.claude/**
spechub/**
```

This list is duplicated as the `INERT_PATHS` array at the top of
`scripts/version-gate.sh`. Change one and change the other. A new top-level
path is shipped by default, because the gate works from a deny-list.

### Picking the level

The gate checks that the version went up. It does not pick the level – you do.
Use semver: patch for a fix, minor for a feature, major for a breaking change.

### The no-bump label

Add the `no-bump` label to the pull request to pass the gate without a bump.
This is for a change that touches a shipped path but genuinely should not roll
out – reformatting a file with no behavioural effect, or a fix that has to wait
for a later release. It is the exception, not a way past a red check. A version
that goes *down* fails even with the label, because an installed copy never
downgrades.

### Before you open the pull request

1. Bump `.claude-plugin/plugin.json`.
2. Confirm `cli/dist/` is up to date (the pre-commit hook handles this if installed).
3. Commit via `/commit` from the marketplace repo – it handles the submodule and parent ordering.

### After the merge

The `tag-release` workflow watches `main` for changes to
`.claude-plugin/plugin.json` and creates an annotated tag `vX.Y.Z` for the new
version. There is nothing to tag by hand.

## Writing standards

Prose follows the `writing` skill in `skills/writing/`. It covers every durable
artifact this repository ships, the skill files and these docs included.
