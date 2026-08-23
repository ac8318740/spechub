# Contributing to SpecHub

## Plugin layout

```
.claude-plugin/plugin.json   – plugin manifest (version, name, description)
agents/                      – subagent definitions
hooks/                       – SessionStart hook (CLI symlink + orchestrator injection)
skills/                      – slash-command skills
output-styles/               – output styles (ac-writing-style)
cli/                         – Node.js CLI (TypeScript source + built dist/)
assets/                      – files a skill installs on a user's machine, and the model never reads them
docs/                        – long-form docs a skill links to instead of inlining
TROUBLESHOOTING.md           – downstream install diagnostics for Claude Code
```

## Assets and helper scripts

`assets/` holds things a skill installs rather than reads. Today that is
`assets/terminal-workspace/setup.sh`, which installs the optional terminal
workspace.

Two rules for it:

- **Every helper script carries the `spechub-*` prefix and lives in a heredoc
  inside `setup.sh`**, not as separate files. One script to install means one
  file to keep idempotent. Editing a helper means editing the heredoc.
  `uninstall` removes them by that prefix, so a helper named anything else leaks.
- **Every edit to a user's config sits between the managed markers**
  (`# >>> spechub terminal-workspace >>>` / `# <<< ... <<<`). Re-applying replaces
  only those regions, so hand-written config around them survives. Never write
  outside the markers, and never assume the file is absent.

### Merging into a user's TOML config

One duplicate key costs the user their whole file. TOML forbids a duplicate,
herdr rejects a config that has one, and yazi throws its config away and falls
back to presets. So the managed block **claims** each key it writes, meaning it
deletes the user's own copy of that key first. Where it cannot prove a key is
free it **concedes** the key, meaning it writes nothing there and says so.

The herdr keymap is the first case. The block claims every key it sets. Before
the merge it removes a same-name assignment in the user's own `[keys]`, and any
`[[keys.command]]` bound to a key the block binds. The same applies to
`[worktrees]`, which the block re-declares in full.

Merging into an existing `[keys]` produces **two** managed regions rather than
one. Bare keys must sit inside `[keys]`. `[[keys.command]]` and `[worktrees]`
are top-level tables, so they cannot. What must hold is that re-applying never
accumulates regions.

`yazi.toml` is the same case, and stricter. A yazi config that falls back to
presets loses every setting the user has. The managed block writes into four
namespaces – `mgr`, `opener.markdown`, `plugin.prepend_previewers` and
`open.prepend_rules` – and every one of them is a claimed-key case.

An array-of-tables entry adds to the config only where the name is free, or
where it already holds an array of tables. Under a `[plugin]` that leaves
`prepend_previewers` unset, `[[plugin.prepend_previewers]]` is fine. It is a
duplicate under a `[plugin]` that holds it as an inline array, which is the
form yazi's own documentation teaches.

`setup.sh` asks `tomllib` which namespaces the user has claimed. It puts the
question in the exact form the block would write it. It appends that header to
the config outside the markers, then sees whether the whole thing still parses.
Whatever the parser rejects is a namespace the user already claimed, so
`setup.sh` leaves it alone.

A dict lookup would not do. TOML also refuses to reopen an inline table or to
overwrite a scalar. Neither `opener = { text = [...] }` nor `opener = "nope"`
has an `opener.markdown` key to find. A lookup therefore calls both free, and
the write then kills the file. A config that already fails to parse concedes
all four namespaces. Such a file teaches `setup.sh` nothing, and repairing a
user's config is not its job.

`tomllib` needs Python 3.11. Without it, the fallback names the top-level table
anywhere the text could open one. That means bare, `"quoted"` or `'literal'`,
as a header or as a key of its own.

That mostly concedes namespaces which would have been safe to write. Each of
those concessions costs one setting, where guessing the other way costs the
file. The fallback errs the other way in one place. Text cannot see that a
config never parsed, so the fallback writes all four into a file the parsed
path would have conceded whole.

`setup.sh` leaves whatever it concedes to the user and names it in a `say`
line. A config that parses with a setting missing beats one yazi throws out.

### Testing a setup.sh change

After changing `setup.sh`, test it against a fake home rather than your own:

```bash
export FAKE=$(mktemp -d)
mkdir -p "$FAKE/.config/spechub"
cp assets/terminal-workspace/config.example.yaml "$FAKE/.config/spechub/tw.yaml"
HOME=$FAKE SPECHUB_TW_CONFIG=$FAKE/.config/spechub/tw.yaml SPECHUB_TW_BIN=$FAKE/bin \
  bash assets/terminal-workspace/setup.sh apply
```

Then check that the generated config parses. Run `apply` twice, and confirm the
managed block count does not grow. Run `uninstall`, and confirm it leaves nothing
behind.

Run the guard suite too. It is offline, so it needs no herdr:

```bash
bash tests/test-terminal-workspace.sh
```

It checks setup.sh against `docs/terminal-workspace.md` in both directions. Every
`spechub-*` and every bound command the docs mention must be something setup.sh
installs. The docs must also cover every default keybinding. It also merges the
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
`.claude-plugin/plugin.json`, then runs esbuild. That is why both the pre-commit
hook and the `git add` recipe above stage `cli/package.json` alongside `dist/`.

That sync is tidiness, not correctness. `spechub --version` reads
`.claude-plugin/plugin.json` directly at runtime (`cli/src/lib/version.ts`), so
the reported version is right whether or not anything rebuilt. It has to work
that way: the rebuild only fires when `cli/src/` changes, so bumping the plugin
alone would leave any baked-in copy behind. That is exactly how the CLI came to
report `0.1.0` while the plugin was at 0.14.2.

## Testing

The repo has two test layers. Run `cd cli && npm test` for the CLI tests. Run `bash tests/run-all.sh` for the hook suites.

## Codex agent definitions

`agents/*.md` is the source. `scripts/gen-codex-agents.mjs` generates
`agents/codex/*.toml` from it. Commit the generated files. Never hand-edit the
TOML.

```sh
node scripts/gen-codex-agents.mjs
```

Codex cannot ship agent definitions inside a plugin, so the SessionStart hook
installs them into `~/.codex/agents/` and re-reconciles on every session. It
only overwrites files carrying the generated marker. It therefore leaves alone
an agent of yours that happens to share a name. It also does nothing at all on a
machine with no `~/.codex`.

The generator emits only the three keys Codex applies: `name`, `description`
and `developer_instructions`. It deliberately omits others:

- `model` – ours says `opus`, a Claude alias that means nothing to Codex.
  Omitting it makes a subagent inherit the parent's model, which is what we
  want anyway.
- `sandbox_mode` and `mcp_servers` – Codex parses then ignores both, because a
  child agent may never escalate past its parent. Emitting them would imply a
  guarantee that does not hold.

One unrecognised key discards the whole file. Codex parses agent files with
`deny_unknown_fields`, and it logs the rejection somewhere nobody reads. CI
parses every generated file and fails on any key outside the allowed three.

Keep the markdown harness-neutral. Naming Claude Code's tools directly ("use
Grep/Glob") produces instructions that are wrong under Codex, so prefer "search
the codebase". Fixing it in the markdown keeps the generator free of a
translation layer.

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

### Why the CLI is not on npm

The CLI ships **only** as part of the plugin, and that is deliberate.

Installing it is not a step. The plugin ships `cli/dist/index.js` in the
repository, so it arrives already built when Claude Code copies the plugin into
its cache. The SessionStart hook then symlinks it into place. There is no npm
install, no `node_modules` in the cache, and no network call. The only
requirement is Node 20 on PATH.

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

Using SpecHub from another agent harness does not need npm either. On any
machine with the plugin, the hook creates `~/.local/bin/spechub`, which has no
Claude Code dependency. It works as a typed command whenever `~/.local/bin` is
on PATH, and the hook warns when it is not. What another harness lacks is the
orchestrator instructions, not the binary.

Revisit this only if a machine needs the CLI with **no plugin installed at all**.
That means CI, or a device that runs an agent but not Claude Code. We keep the
package publishable for that day: `npm pack --dry-run` from `cli/` shows the
file list, and `prepublishOnly` runs the build. Note the bare `spechub` name on
npm belongs to an unrelated project, so the package would be `spechub-cli` with
`spechub` as its binary.

#### Who owns `spechub` on PATH

The SessionStart hook defers. If it finds a `spechub` on PATH that is not its
own symlink, it leaves it alone and says where the winner came from. Two
managers pointing one command name at different copies make a silent race, which
PATH order decides. The hook should not be one of the racers.

Agents are outside this entirely. Skills and agents call
`~/.claude/spechub/bin/spechub` by absolute path, which is always the plugin's
own CLI regardless of PATH.

## Writing standards

Prose follows the `writing` skill in `skills/writing/`. It covers every durable
artifact this repository ships, the skill files and these docs included.
