# herdr follow-up

Read this file when the user declared herdr installed in Step 2.

- `plugin_root` comes from Step 1 in `SKILL.md`
- Step 5 in `SKILL.md` lists the exit codes both installers share

### When you declared herdr installed

**Write the managed block.** herdr keeps its config at
`~/.config/herdr/config.toml`. SpecHub needs one setting in that file: the
directory herdr creates worktrees under. Offer to write it.

The installer is `install-herdr-block.sh`, beside this file, and Step 1 in
`SKILL.md` resolves the same `plugin_root`.

Plan it first:

```bash
bash "$plugin_root/skills/host/install-herdr-block.sh" --plan
```

Two options change the defaults. `--config PATH` points at a config file
elsewhere, and `--worktree-dir PATH` changes the directory. The defaults are
`~/.config/herdr/config.toml` and `~/.herdr/worktrees`.

Show the printed step list verbatim, then ask with AskUserQuestion. Declining is
a real answer, and nothing runs. On approval, run the same command with
`--apply`.

This is the block it writes, and it writes nothing else:

```
# >>> spechub terminal-workspace >>>
[worktrees]
directory = "~/.herdr/worktrees"
# <<< spechub terminal-workspace <<<
```

It creates the file when the file is absent. It appends the block when the block
is absent. It replaces the block in place when the block is there and differs.

It refuses and changes nothing whenever the config file is not in a state it can
safely edit. Editing one of these would corrupt the file, or throw away
somebody's config:

- a path that exists and is not a regular file
- a file that already holds more than one block with those markers
- a start marker count and an end marker count that differ
- a start marker that the file never closes
- a `[worktrees]` table defined outside any managed block
- a block between the markers that defines a table besides `[worktrees]`

It exits 4 and says which case it hit. Tell the user to fix the config by hand,
then run the plan again.

**What this skill ships, and what is personal taste.** This skill ships the
managed block and nothing else. The block tells herdr to put worktrees under
`~/.herdr/worktrees`. The worktree skills read that path, so it is the one
setting they depend on.

The rest of a herdr setup is personal taste. This skill installs none of it: the
keymap, the popup key bindings, the `spechub.herdr-numbers` plugin, and the
`spechub-*` helper binaries in `~/.local/bin`.

Copy your own if you want them. Nothing in SpecHub needs any of them.

**The terminal-workspace skill writes the same block, wider.**
`assets/terminal-workspace/setup.sh apply` fences `[keys]`, one
`[[keys.command]]` per binding, and `[worktrees]` between these same two
markers. It takes the directory from `herdr.worktrees_directory` in
`~/.config/spechub/terminal-workspace.yaml`. A machine that has run it needs
nothing from this installer.

The installer therefore leaves that block alone. It reports the step as skipped
when the directory already agrees. It refuses with exit 4 when it does not.

Change the directory in `terminal-workspace.yaml` and run `setup.sh apply`
again, never this script.
