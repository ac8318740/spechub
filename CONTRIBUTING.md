# Contributing to SpecHub

## Plugin layout

```
.claude-plugin/plugin.json   – plugin manifest (version, name, description)
agents/                      – subagent definitions
hooks/                       – SessionStart hook (CLI symlink + orchestrator injection)
skills/                      – slash-command skills
cli/                         – Node.js CLI (TypeScript source + built dist/)
assets/                      – files skills ship to the user's machine, not read by the model
docs/                        – long-form docs a skill links to instead of inlining
TROUBLESHOOTING.md           – downstream install diagnostics for Claude Code
```

## Assets and helper scripts

`assets/` holds things a skill installs rather than reads. Today that is
`assets/terminal-workspace/setup.sh`, which installs the optional terminal
workspace.

Two rules for it:

- **Helper scripts are named `spechub-*` and live in heredocs inside `setup.sh`**,
  not as separate files. One script to install means one file to keep idempotent.
  Editing a helper means editing the heredoc. `uninstall` removes them by that
  prefix, so a helper named anything else leaks.
- **Every edit to a user's config sits between the managed markers**
  (`# >>> spechub terminal-workspace >>>` / `# <<< ... <<<`). Re-applying replaces
  only that region, so hand-written config around it survives. Never write outside
  the markers, and never assume the file is absent.

After changing `setup.sh`, test it against a fake home rather than your own:

```bash
export FAKE=$(mktemp -d)
mkdir -p "$FAKE/.config/spechub"
cp assets/terminal-workspace/config.example.yaml "$FAKE/.config/spechub/tw.yaml"
HOME=$FAKE SPECHUB_TW_CONFIG=$FAKE/.config/spechub/tw.yaml SPECHUB_TW_BIN=$FAKE/bin \
  bash assets/terminal-workspace/setup.sh apply
```

Then check the generated config parses, run `apply` twice and confirm exactly one
managed block, and run `uninstall` and confirm nothing is left behind.

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
  git add cli/dist cli/package.json
fi
```

This runs `npm run build` only when `cli/src/` is part of the staged diff, then
stages what the build regenerates. If the build fails, the commit aborts.

`npm run build` does two things: it syncs `cli/package.json`'s version from
`.claude-plugin/plugin.json`, then runs esbuild. The sync is why
`cli/package.json` is staged alongside `dist/` – the CLI reads its own
`package.json` at runtime to answer `spechub --version`, so the number has to be
right in the copy that ships with the plugin, not only in an npm tarball.

## Releasing

1. Bump `.claude-plugin/plugin.json` version. Use semver – patch for fixes, minor for features, major for breaking changes.
2. Confirm `cli/dist/` is up to date (the pre-commit hook handles this if installed).
3. Commit via `/commit` from the marketplace repo – it handles the submodule + parent ordering.
4. The Claude Code plugin cache only repulls when the version changes, so the bump is what triggers downstream upgrades.

### The CLI on npm

The CLI is also published to npm as [`spechub-cli`](https://www.npmjs.com/package/spechub-cli),
for people driving a SpecHub project from outside Claude Code – a different
agent harness, a script, or CI. The plugin does not depend on npm: it ships its
own built `cli/dist/`, and the SessionStart hook points
`~/.claude/spechub/bin/spechub` at it. npm is a second door to the same code.

Because of that, **npm is not on a lock-step release cadence with the plugin.**
Publish when the CLI itself changes, not on every plugin bump. A plugin release
that only touches skills or docs needs no publish.

To publish, from `cli/`:

```sh
npm publish
```

`prepublishOnly` runs the build, which syncs the version from `plugin.json`
first – so the npm version always matches a real plugin version. Run
`npm pack --dry-run` beforehand to see the exact file list.

Note the package is `spechub-cli` but the command it installs is `spechub`.
The bare `spechub` name on npm belongs to an unrelated project.

#### Who owns `spechub` on PATH

Two things can put a `spechub` on a user's PATH, and only one may win:

- `npm install -g spechub-cli` – npm's global bin.
- The SessionStart hook – `~/.local/bin/spechub`.

The hook defers. If it finds a `spechub` on PATH that is not its own symlink, it
leaves it alone and says so. Users who never touch npm still get the convenience
symlink; users who installed deliberately keep the copy they chose, and
`npm uninstall -g` genuinely removes it.

Agents are outside this entirely. Skills and agents call
`~/.claude/spechub/bin/spechub` by absolute path, which is always the plugin's
own CLI regardless of PATH.

## Writing standards

Match the marketplace repo's standards:

- En dashes (–), never em dashes.
- Short sentences. Plain words.
- Active voice.
- No filler, no marketing tone.
- Write for a reader without context – plain language, every term of art defined at first use.
