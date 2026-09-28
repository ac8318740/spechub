# Teardown worktree: herdr

The herdr branches of the teardown. Each section names the `SKILL.md` step it belongs to.

## Step 1 – herdr's answer

A herdr workspace holds tabs, and each tab holds panes. One status for the whole workspace therefore says nothing about the other tabs in it. So enumerate the panes before every removable verdict.

Start with the cheap hint:

```bash
herdr worktree list
herdr workspace list
```

Treat `working`, `blocked`, `idle` and `done` as a live agent. Skip the worktree, and run no further check on it.

`idle` does not mean empty. In herdr it means an agent is present and waiting for input, which is exactly the state a session someone left open sits in. Reading `idle` as nobody home is the quickest way to destroy a running session.

`unknown` never makes a worktree removable on its own. It summarises a whole workspace, and a second tab running an agent hides behind that one word.

So list every pane of the workspace holding the worktree:

```bash
herdr pane list --workspace <workspace-id>
```

The listing covers every tab, not only the focused one. Each entry carries `pane_id`, `tab_id`, `agent`, `agent_status`, `cwd` and `foreground_cwd`.

Exclude this session's own pane by identifier, never by status. The own pane is the one whose `pane_id` equals `$HERDR_PANE_ID`. Every other pane still counts, whatever the workspace `agent_status` said.

The `w26` teardown skipped this step. It read its own workspace's `done` as its own verdict, removed the workspace, and killed a live session in the second tab.

Excluding by `pane_id` keeps every other pane inside the check. The step 3 rules then stop the removal.

Then read what actually runs in each remaining pane:

```bash
herdr pane process-info --pane <pane-id>
```

Any one of these three makes the worktree a skip:

- The pane's `agent_status` is `working`, `blocked`, `idle` or `done`.
- `foreground_processes` holds an agent, `claude` or `codex` for example.
- A foreground process has a `cwd` inside the worktree's checkout path.

The third case is not an agent. An editor or `gh dash` counts here. Deleting the directory under it still breaks it.

Close it deliberately, or leave the worktree alone.

One `cwd` never blocks: a path carrying the `(deleted)` marker. That shell sits in a directory somebody already removed, as step 2 describes. It holds nothing.

Cross-check the pane count against the tabs, every time:

```bash
herdr tab list --workspace <workspace-id>
```

Sum `pane_count` across the tabs. A sum above the number of rows `pane list` returned means the enumeration missed something. Skip the worktree and report it.

Name every blocking pane in the plan, so the user can close it deliberately.

## Step 2 – Host: herdr

When `active` is `herdr`, move the pane out first, or step 3 deletes the worktree under a pane still sitting in that workspace.

The move needs this pane's own identifier, and `active` being `herdr` does not guarantee it. The detector reports `herdr` when either of herdr's two environment markers holds a value, and only one of them names the pane. So if `$HERDR_PANE_ID` is empty, herdr's markers are incomplete – say so and stop, rather than issuing a pane move against a blank target.

Find the main repo's workspace in `herdr workspace list`: `worktree.repo_root` is the main checkout and `worktree.is_linked_worktree` is `false`. More than one workspace can match, since any pane opened at the repo root qualifies. Prefer the one whose label is the repo name, and ask when it stays ambiguous.

Then:

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <main-workspace-id> --focus
```

If no such workspace exists because it closed earlier, create one first:

```bash
herdr workspace create --cwd <main-root> --label <repo-name> --no-focus
```

The pane's own shell keeps the deleted directory as its cwd, which `herdr pane process-info` reports as `(deleted)`. That is cosmetic, and only visible once the agent exits and hands the prompt back.

## Step 3 – Owner: herdr

Which command to use depends on whether herdr still holds a workspace for the worktree. Read `open_workspace_id` from `herdr worktree list`.

With a workspace, enumerate its panes first:

```bash
herdr pane list --workspace <workspace-id>
```

Exclude the pane whose `pane_id` equals `$HERDR_PANE_ID`. Refuse the removal while any other pane remains. Name those pane ids to the user and move to the next worktree.

With the workspace clear, let herdr do it, so the sidebar row goes with the worktree:

```bash
herdr worktree remove --workspace <workspace-id> --force
```

Without a workspace, plain git:

```bash
git -C <main-root> worktree remove --force <path>
git -C <main-root> worktree prune
```

The worktree this session just left may still have a workspace. Moving the last pane out closes the workspace, and a pane in a second tab keeps it open.

So read `open_workspace_id` from `herdr worktree list` again after step 2. A workspace id still set means the pane enumeration above runs on that workspace too, before you remove anything.
