---
name: terminal-workspace
description: "Install and configure the optional terminal workspace: herdr for panes that survive disconnect and worktree-backed workspaces, gh-dash for pull request triage, diffnav and delta for reading diffs. Use when the user asks to set up parallel agents in the terminal, mentions herdr, gh-dash, or diffnav, wants agents that keep running after they close the terminal, or asks to turn any of these on or off. Each component is independently toggleable and every change is reversible."
argument-hint: "[status | apply | disable <component> | uninstall]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What this skill does

Sets up an optional terminal workspace for running several coding agents at once. It is **machine-level, not per-project**: it installs binaries and writes keybindings for the user account, so it does not belong in `spechub/project.yaml`.

Nothing here is required to use SpecHub. Offer it, do not assume it.

| Component | Gives the user | Toggle |
|---|---|---|
| herdr | Panes that survive disconnect, per-agent state, worktree workspaces | `herdr.enabled` |
| delta | Syntax-highlighted diffs everywhere | `delta.enabled` |
| diffnav | Diff with a file tree, on one key | `diffnav.enabled` |
| gh-dash | Pull request triage without a browser | `gh_dash.enabled` |
| tuicr | Code review, which gh-dash hands pull requests to | `tuicr.enabled` |
| yazi | File manager, with markdown previewed live by spechub-md | `yazi.enabled` |
| spechub-md | Markdown with mermaid diagrams, as text or in a browser | `markdown.enabled` |

Background and full key tables: [docs/terminal-workspace.md](../../docs/terminal-workspace.md).

## Files

- **Config**: `~/.config/spechub/terminal-workspace.yaml`, copied from `assets/terminal-workspace/config.example.yaml`
- **Script**: `assets/terminal-workspace/setup.sh` in this plugin

## Commands

Run the script from the plugin directory. Resolve it rather than guessing the path:

```bash
SETUP="$(dirname "$(find ~/.claude/plugins -path '*spechub*/assets/terminal-workspace/setup.sh' | head -1)")/setup.sh"
```

### `status` (default)

```bash
bash "$SETUP" status
```

Reports which binaries are installed, which components are enabled, and whether the managed block is present in the herdr config. Run this first, always.

### `apply`

```bash
bash "$SETUP" apply
```

Installs any missing binary for an enabled component, writes the helper scripts, applies the herdr keymap, sets delta as the git pager, and writes the gh-dash sections and keybindings. Idempotent: run it again after editing the config and it updates in place.

Before running it the first time:

1. Copy the example config to `~/.config/spechub/terminal-workspace.yaml`
2. Walk the user through the choices below
3. Then apply, and confirm with `status`

### `disable <component>`

```bash
bash "$SETUP" disable herdr     # or delta, diffnav, gh_dash
```

Removes what that component wrote. Then set `<component>.enabled: false` in the config so the next `apply` does not restore it. Binaries are left in place.

### `uninstall`

Removes every managed block and the helper scripts, and leaves the binaries.

## Choices worth walking the user through

- **`herdr.chord_modifier`**: `alt` (default), `ctrl+alt`, or `none`. herdr's own docs recommend `ctrl+alt` because it is free across terminals, but many terminals cannot encode it over SSH. Recommend `alt` for remote work. `none` keeps herdr's prefix-only keymap
- **`herdr.worktrees_directory`**: keep it absolute. A relative value resolves against the herdr session's base directory rather than the repository being branched, so worktrees for a second repository land inside the first
- **`herdr.integration`**: which agent reports its state to herdr. Set it to the agent the user actually runs, or `none`. Without it, herdr infers state by reading the screen
- **`gh_dash.repo_paths`**: map each repo to its local clone. Without it, checkout and any keybinding using `{{.RepoPath}}` fail
- **`markdown.preview_port`**: must match a port the user forwards from their
  laptop, or `spechub-md --serve` is unreachable. Say so rather than assuming
- **`tuicr.build_from_fork`**: leave `false` unless the user wants the two unmerged
  upstream pull requests (#607 stats, #633 resize). `true` needs cargo and takes a
  few minutes to build. Tell them it is temporary and that `status` tracks both PRs
- **`gh_dash.keybindings.agent_review`**: hands the selected pull request to an agent. Leave empty if the user does not want that key. Avoid `R`, which is gh-dash's built-in refresh-all

## Safety

- Every edit sits between `# >>> spechub terminal-workspace >>>` markers. Hand-written config around them survives, and re-applying replaces only the managed region
- The gh-dash config is merged, not overwritten: existing sections, themes, and keybindings the user added are preserved
- Never edit the user's herdr or gh-dash config outside the managed markers
- After applying, `herdr config check` must print `config: ok`. If it does not, report the error and stop rather than reloading

## Verify

```bash
bash "$SETUP" status          # components installed and enabled
herdr config check            # config: ok
```

Then tell the user to open a herdr session and press `prefix+?` for the keymap, `?` inside gh-dash, and that diffnav lists its keys in its footer.
