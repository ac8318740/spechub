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
  only those regions, so hand-written config around them survives. Never write
  outside the markers, and never assume the file is absent.

  The exceptions are forced by TOML. A key the block sets is **claimed**: an
  assignment of the same name in the user's own `[keys]`, and any
  `[[keys.command]]` bound to a key the block binds, is removed before the merge,
  because TOML forbids a duplicate key and herdr would reject the whole file.
  The same applies to `[worktrees]`, which the block re-declares in full. Merging
  into an existing `[keys]` also produces **two** managed regions rather than one:
  bare keys must sit inside `[keys]`, while `[[keys.command]]` and `[worktrees]`
  are top-level tables and cannot. What must hold is that re-applying never
  accumulates them.

  `yazi.toml` is the same case, and stricter. yazi rejects the whole config on
  one TOML error and falls back to presets, so a single duplicate costs the user
  every setting they have. The managed block writes into four namespaces –
  `mgr`, `opener.markdown`, `plugin.prepend_previewers` and `open.prepend_rules`
  – and every one of them is a claimed-key case. An array-of-tables entry is
  additive only where the name is free or already an array of tables:
  `[[plugin.prepend_previewers]]` is fine under a `[plugin]` that leaves
  `prepend_previewers` unset, and a duplicate under one holding it as an inline
  array, which is the form yazi's own documentation teaches.

  Which namespaces the user has claimed is decided by putting the question to
  `tomllib` in the exact form the block would write it: append that header to
  the config outside the markers and see whether the whole thing still parses.
  Whatever the parser refuses is theirs. A dict lookup would not do – TOML also
  refuses to reopen an inline table or to overwrite a scalar, and neither
  `opener = { text = [...] }` nor `opener = "nope"` has an `opener.markdown`
  key to find, so a lookup calls both free and the write kills the file. A
  config that does not parse to begin with concedes all four, since nothing can
  be known about it and repairing it is not ours to do.

  `tomllib` needs Python 3.11, so its absence falls back to naming the
  top-level table anywhere the text could open one – bare, `"quoted"` or
  `'literal'`, as a header or as a key of its own. That mostly concedes
  namespaces which would have been safe to write, and each of those costs one
  setting where guessing the other way costs the file. It errs the other way in
  one place: text cannot see that a config never parsed, so the fallback writes
  all four into a file the parsed path would have conceded whole. Whatever is
  conceded is left to the user and named in a `say` line, because a config that
  parses with a setting missing beats one yazi throws out.

After changing `setup.sh`, test it against a fake home rather than your own:

```bash
export FAKE=$(mktemp -d)
mkdir -p "$FAKE/.config/spechub"
cp assets/terminal-workspace/config.example.yaml "$FAKE/.config/spechub/tw.yaml"
HOME=$FAKE SPECHUB_TW_CONFIG=$FAKE/.config/spechub/tw.yaml SPECHUB_TW_BIN=$FAKE/bin \
  bash assets/terminal-workspace/setup.sh apply
```

Then check the generated config parses, run `apply` twice and confirm the managed
block count does not grow, and run `uninstall` and confirm nothing is left behind.

Run the guard suite too. It is offline, so it needs no herdr:

```bash
bash tests/test-terminal-workspace.sh
```

It checks setup.sh against `docs/terminal-workspace.md` in both directions: every
`spechub-*` and every bound command the docs mention must be something setup.sh
installs, and every default keybinding must be documented. It also merges the
generated keymap onto a hand-written config and asserts the result is valid TOML.
CI runs it on every push and pull request. Rename a helper or change a default
key and this suite fails until the docs follow.

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
  git add cli/dist cli/package.json
fi
```

This runs `npm run build` (esbuild) only when `cli/src/` is part of the staged
diff. It then stages what the build regenerates. If the build fails, the commit
aborts.

The hook is optional and easy to forget to install. CI is what actually enforces
it: `.github/workflows/ci.yml` rebuilds and fails the run if `cli/dist` or
`cli/package.json` differs from what the build produces. Treat the hook as a
convenience that saves you a red run, not as the guarantee.

`npm run build` syncs `cli/package.json`'s version from
`.claude-plugin/plugin.json`, then runs esbuild, which is why `cli/package.json`
is staged alongside `dist/`.

That sync is tidiness, not correctness. `spechub --version` reads
`.claude-plugin/plugin.json` directly at runtime (`cli/src/lib/version.ts`), so
the reported version is right whether or not anything rebuilt. It has to work
that way: the rebuild only fires when `cli/src/` changes, so bumping the plugin
alone would leave any baked-in copy behind. That is exactly how the CLI came to
report `0.1.0` while the plugin was at 0.14.2.

## Testing

The repo has two test layers. Run `cd cli && npm test` for the CLI tests. Run `bash tests/run-all.sh` for the hook suites.

## Codex agent definitions

`agents/*.md` is the source. `agents/codex/*.toml` is generated from it by
`scripts/gen-codex-agents.mjs` and committed. Never hand-edit the TOML.

```sh
node scripts/gen-codex-agents.mjs
```

Codex cannot ship agent definitions inside a plugin, so the SessionStart hook
installs them into `~/.codex/agents/` and re-reconciles on every session. It
only overwrites files carrying the generated marker, so an agent of yours that
happens to share a name is left alone, and it does nothing at all on a machine
with no `~/.codex`.

The generator emits only the three keys Codex applies: `name`, `description`
and `developer_instructions`. It deliberately omits others:

- `model` – ours says `opus`, a Claude alias that means nothing to Codex.
  Omitting it makes a subagent inherit the parent's model, which is what we
  want anyway.
- `sandbox_mode` and `mcp_servers` – Codex parses then ignores both, because a
  child agent may never escalate past its parent. Emitting them would imply a
  guarantee that does not hold.

This matters more than it looks. Codex parses agent files with
`deny_unknown_fields`: one unrecognised key and it discards the whole file,
logging somewhere nobody reads. CI parses every generated file and fails on any
key outside the allowed three.

Keep the markdown harness-neutral. Naming Claude Code's tools directly ("use
Grep/Glob") produces instructions that are wrong under Codex, so prefer "search
the codebase". Fixing it in the markdown keeps the generator free of a
translation layer.

## Releasing

1. Bump `.claude-plugin/plugin.json` version. Use semver – patch for fixes, minor for features, major for breaking changes.
2. Confirm `cli/dist/` is up to date (the pre-commit hook handles this if installed).
3. Commit via `/commit` from the marketplace repo – it handles the submodule + parent ordering.
4. The Claude Code plugin cache only repulls when the version changes. The bump is what triggers downstream upgrades.

### Why the CLI is not on npm

The CLI ships **only** as part of the plugin, and that is deliberate.

Installing it is not a step. The plugin's `cli/dist/index.js` is committed, so
it arrives already built when Claude Code copies the plugin into its cache, and
the SessionStart hook symlinks it into place. There is no npm install, no
`node_modules` in the cache, and no network call. The only requirement is Node
20 on PATH.

Publishing to npm as well would buy a second door to the same code and cost:

- **Version skew, which is currently impossible.** Skills and CLI ship in one
  tarball at one version. A globally installed CLI pins whatever version it was
  installed at, so a plugin release with a new CLI flag can break a skill.
  Preventing that needs a version check at session start – more machinery than
  the symlink it would replace.
- **A network dependency on a path that has none.** `npm install -g` fails on no
  network, a locked-down prefix, or a proxy. The bundled CLI works offline.
- **PATH propagation.** Non-interactive agent subshells do not always inherit an
  npm global bin, notably under nvm.

Using SpecHub from another agent harness does not need npm either: on any
machine with the plugin, `~/.local/bin/spechub` is already on PATH and has no
Claude Code dependency. What another harness lacks is the orchestrator
instructions, not the binary.

Revisit this only if a machine needs the CLI with **no plugin installed at all**:
CI, or a device that runs an agent but not Claude Code. The package is kept
publishable for that day: `npm pack --dry-run` from `cli/` shows the file list,
and `prepublishOnly` runs the build. Note the bare `spechub` name on npm belongs
to an unrelated project, so the package would be `spechub-cli` with `spechub` as
its binary.

#### Who owns `spechub` on PATH

The SessionStart hook defers. If it finds a `spechub` on PATH that is not its
own symlink, it leaves it alone and says where the winner came from. Two
managers pointing one command name at different copies is a silent race decided
by PATH order, and the hook should not be one of the racers.

Agents are outside this entirely. Skills and agents call
`~/.claude/spechub/bin/spechub` by absolute path, which is always the plugin's
own CLI regardless of PATH.

## Writing standards

Prose follows the `writing` skill in `skills/writing/`. It covers every durable
artifact this repository ships, the skill files and these docs included.
