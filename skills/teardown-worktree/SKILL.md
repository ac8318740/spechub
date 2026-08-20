---
name: teardown-worktree
description: "Retire finished git worktrees – move this session back to the main checkout, move the herdr pane back to the main repo workspace, remove the checkouts, and delete the merged local and remote branches. Scans the whole repo, not just the current worktree. Use whenever the user says \"tear down the worktree\", \"clean up worktrees\", \"remove this worktree\", \"delete the worktree and branch\", \"clean up stale worktrees\", or otherwise wants finished worktrees and their branches gone."
argument-hint: "[worktree name, or nothing to scan the whole repo]"
---

# Teardown Worktree

Retire finished worktrees. Move this session out first, then remove the checkouts, then delete the branches they were on.

Removing a worktree this session is standing in, or one whose herdr workspace holds a running agent, destroys live work. The order below exists to prevent that. Follow it.

## When to use

Trigger on "tear down the worktree", "clean up worktrees", "remove this worktree", "delete the worktree and branch", "clean up stale worktrees". Also fair game straight after a merge, when the user says the work has shipped.

## Scope

One repo per run: the repo that owns the cwd. Resolve its main checkout from anywhere inside it:

```bash
dirname "$(git rev-parse --git-common-dir)"
```

Submodules are separate repos with their own worktrees and their own remote. If the repo has submodules carrying worktrees, say so and offer a second run against each. Never scan them silently.

## 1. Build the plan

Remove nothing before the full plan is on screen and the user has approved it. One approval covers the whole run.

List every worktree of the repo:

```bash
git worktree list --porcelain
```

Skip the main checkout. Classify each remaining worktree on three checks.

### Uncommitted work

```bash
git -C <path> status --porcelain --ignore-submodules=all
```

`--ignore-submodules=all` is not optional. Without it, a submodule checked out ahead of its committed pointer reads as uncommitted work, so every worktree in a repo with submodules looks dirty and nothing is ever cleaned up.

Report pointer drift in the plan anyway, from `git -C <path> submodule status`, so a real pending bump stays visible instead of being silently ignored.

Any output from the status check means skip. Do not remove it, do not force it. List it at the end with what it holds.

### Merged

A branch counts as merged if it reached any integration branch the repo actually has. Check `origin/dev` first, then `origin/main`, using whichever exist:

```bash
git fetch origin --prune --quiet
git merge-base --is-ancestor <branch> origin/dev
git merge-base --is-ancestor <branch> origin/main
```

A squash merge leaves the branch tip unreachable from either, so the ancestor check alone will call shipped work unmerged. Fall back to the pull request:

```bash
gh pr list --head <branch> --state merged --json number,mergedAt
```

Merged by either test counts as merged. Merged by neither means skip and report.

### Live agent

Under herdr, check the workspace holding each worktree:

```bash
herdr worktree list
herdr workspace list
```

Treat `working`, `blocked`, `idle` and `done` as a live agent and skip. Only `unknown` makes a worktree a candidate.

`idle` does not mean empty. In herdr it means an agent is present and waiting for input, which is exactly the state a session someone left open sits in. Reading `idle` as nobody home is the quickest way to destroy a running session.

`unknown` is not proof of an empty pane either, so confirm what is actually running before removing anything:

```bash
herdr pane process-info --pane <pane-id>
```

Skip the worktree when `foreground_processes` holds an agent. Skip it too when a foreground program is running with a `cwd` inside the worktree, an editor or `gh dash` for example. That is not an agent, but deleting the directory under it still breaks it. Close it deliberately or leave the worktree alone.

### Show it

Print one table: worktree, branch, whether the local branch goes, whether the remote branch goes, and the reason. Then ask once.

## 2. Move this session out

Do this before removing anything, and only after approval.

`EnterWorktree` cannot do this. It rejects the main checkout outright, "is the main working tree, not a linked worktree", so no tool call walks the session cwd back. `ExitWorktree` only unwinds a worktree this session entered with `EnterWorktree`, and is a no-op for a session that launched inside one.

The removal itself is what moves the session. Run it from the main checkout against an absolute path and the harness resets the session cwd to the main checkout on its own. Confirm with `pwd` afterwards.

- Entered with `EnterWorktree`: call `ExitWorktree` with `action: "keep"` first. Keep, not remove: step 3 owns the removal, and `remove` refuses on a worktree entered by path.
- Launched inside the worktree: no call needed. Take the pane with you below, remove the checkout in step 3, then confirm the new cwd.

Under herdr, move the pane out first, or step 3 deletes the checkout under a pane still sitting in that workspace.

Find the main repo's workspace in `herdr workspace list`: `worktree.repo_root` is the main checkout and `worktree.is_linked_worktree` is `false`. More than one workspace can match, since any pane opened at the repo root qualifies. Prefer the one whose label is the repo name, and ask when it stays ambiguous. Then:

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <main-workspace-id> --focus
```

If no such workspace exists, because it was closed earlier, create one first:

```bash
herdr workspace create --cwd <main-root> --label <repo-name> --no-focus
```

The pane's own shell keeps the deleted directory as its cwd, which `herdr pane process-info` reports as `(deleted)`. That is cosmetic, and only visible once the agent exits and hands the prompt back.

## 3. Remove the checkouts

Which command to use depends on whether herdr still holds a workspace for the worktree. Read `open_workspace_id` from `herdr worktree list`.

With a workspace, let herdr do it, so the sidebar row goes with the checkout:

```bash
herdr worktree remove --workspace <workspace-id> --force
```

Without one, plain git:

```bash
git -C <main-root> worktree remove --force <path>
git -C <main-root> worktree prune
```

`--force` is required, not a shortcut. Plain `git worktree remove` refuses on any worktree containing submodules with "working trees containing submodules cannot be moved or removed", which is every worktree in a repo that has them. Forcing is safe only because step 1 already proved the tree clean. It is never a way past uncommitted changes.

The worktree this session just left usually has no workspace any more. Moving the last pane out closes the workspace but leaves the checkout on disk, so that one takes the plain git path.

## 4. Delete the branches

Only for worktrees removed in step 3, and only for branches step 1 proved merged.

```bash
git -C <main-root> branch -d <branch>
git -C <main-root> push origin --delete <branch>
```

Use `branch -d`, never `-D`. If `-d` refuses, the merge test was wrong. Stop and report rather than forcing.

Skip the remote delete when the branch was never pushed, or when merging the pull request already deleted it. The `git fetch origin --prune` from step 1 keeps a branch GitHub already removed from looking like work to do.

## 5. Report

State what went and what stayed:

- Worktrees removed, with their branches
- Worktrees skipped, each with its reason: uncommitted work, unmerged branch, or a live agent
- Anything left for the user to decide

## Never

- Remove a worktree this session is standing in. Move out first.
- Remove a worktree whose herdr workspace reports a `working`, `blocked`, `idle` or `done` agent. `idle` means present and waiting, not absent.
- Decide on `agent_status` alone. Confirm with `herdr pane process-info` before removing.
- Reach for `EnterWorktree` to get back to the main checkout. It rejects the main working tree.
- Force past uncommitted changes. Skip and report instead.
- Reach for `git branch -D` when `-d` refuses.
- Call a branch unmerged on the ancestor check alone. Check the pull request before deciding.
- Delete a remote branch with no merged pull request and no ancestor in an integration branch.
- Remove a checkout with plain git while herdr still holds a workspace for it. That leaves a sidebar row pointing at nothing.
- Scan a submodule's worktrees without saying so.
