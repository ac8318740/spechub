# New worktree: herdr

The `Orchestrator: herdr` branch of `SKILL.md`, for when `active` is `herdr`.

When `active` is `herdr`, the session is running in a [herdr](https://herdr.dev) pane. Create the worktree through herdr, then move this pane into the workspace herdr made for it. The session ends up in the sidebar row for the worktree it is actually working in, indented under its parent repo.

All four steps are one operation. Stopping after step 2 is the old broken behaviour. The session keeps running in the parent repo's workspace, and the worktree row holds nothing but an idle shell.

Check herdr's own markers before issuing any of the commands below. The detector reports `herdr` when either marker holds a value, but these steps need both: if `$HERDR_WORKSPACE_ID` or `$HERDR_PANE_ID` is empty, herdr's markers are incomplete. Say so and stop there, rather than issuing herdr commands against a blank target – `herdr workspace get ""` does not fail usefully, it just acts on nothing.

## 1. Keep the source workspace alive

Moving the last pane out of a workspace closes that workspace. If this session is the only pane in a repo-root workspace, the repo row vanishes and the new worktree has no parent to nest under.

Read the source workspace first:

```bash
herdr workspace get "$HERDR_WORKSPACE_ID"
```

If `pane_count` is 1 and `worktree.is_linked_worktree` is `false`, leave a shell behind before moving:

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <main-root> --no-focus
```

Skip this when the workspace has other tabs, or when it is already a linked worktree. A spent worktree workspace should close when the session leaves it.

## 2. Create the worktree

`<base>` per the base rule in `SKILL.md`.

```bash
cd <main-root> \
  && git fetch origin --quiet \
  && herdr worktree create \
       --cwd "$(pwd)" \
       --branch <branch> \
       --base <base> \
       --label <slug> \
       --no-focus
```

`--cwd` must be the MAIN repo root. herdr records it as the workspace's `repo_root`, and the sidebar groups worktree workspaces as indented children under that repo. Pass a nested worktree path and the new workspace groups under the wrong parent.

Do not pass `--path`. herdr places the checkout under its configured root (`worktrees.directory`, default `~/.herdr/worktrees`, giving `<root>/<repo>/<branch-slug>`). Letting the config decide keeps worktrees agent-neutral – the same layout whether Claude, Codex, or another CLI agent works in them.

Use `--no-focus` here, so herdr does not drop the user into the spare shell. Focus comes in step 3, with this pane.

Read three values from the JSON rather than assuming any of them:

- `.result.worktree.path` – the checkout, for `git -C <path> log -1 --oneline` to confirm the base commit
- `.result.workspace.workspace_id` – where this pane is going
- `.result.root_pane.pane_id` – the spare shell to close in step 4

Never hardcode the path. A relative `worktrees.directory` resolves against the herdr session's base directory, not the repo you pass to `--cwd`. Only the output tells you where the checkout landed.

## 3. Move this pane in

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <workspace-id> --focus
```

Use `--focus` so the user's view follows the session they were watching, instead of staying on whatever remains behind.

The pane gets a new workspace-qualified ID. Read it from `.result.move_result.pane.pane_id`. `$HERDR_PANE_ID` still resolves for this process, so it keeps working as a target here. Do not hand the old ID to anything else.

## 4. Close the spare shell

herdr's create step always spawns a shell in the new workspace. Close it once the move has landed:

```bash
herdr pane close <root-pane-id>
```

Order matters. Close it first and the workspace has no panes left. herdr then closes the workspace, so the move in step 3 has nothing to target.

## If the checkout already exists

Attach it instead of recreating, then carry on from step 3:

```bash
herdr worktree open --path <path-to-existing-checkout>
```
