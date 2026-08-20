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

Skip any worktree whose workspace reports an `agent_status` of `working` or `blocked`. Another session is using it.

### Show it

Print one table: worktree, branch, whether the local branch goes, whether the remote branch goes, and the reason. Then ask once.

## 2. Move this session out

Do this before removing anything, and only after approval.

Change the session cwd back to the main checkout:

- Use `ExitWorktree` with `action: "keep"` if this session entered the worktree with `EnterWorktree`. Keep, not remove: step 3 owns the removal, and `remove` refuses on a worktree that was entered by path.
- Otherwise target the main checkout for all further work and confirm with `pwd`.

Under herdr, move the pane back too, or the session sits in a sidebar row for a checkout that is about to disappear.

Find the main repo's workspace in `herdr workspace list`: the one whose `worktree.repo_root` is the main checkout and whose `worktree.is_linked_worktree` is `false`. Then:

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <main-workspace-id> --focus
```

If no such workspace exists, because it was closed earlier, create one first:

```bash
herdr workspace create --cwd <main-root> --label <repo-name> --no-focus
```

## 3. Remove the checkouts

Which command to use depends on whether herdr still holds a workspace for the worktree. Read `open_workspace_id` from `herdr worktree list`.

With a workspace, let herdr do it, so the sidebar row goes with the checkout:

```bash
herdr worktree remove --workspace <workspace-id> --force
```

Without one, plain git:

```bash
git -C <main-root> worktree remove <path>
git -C <main-root> worktree prune
```

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
- Remove a worktree whose herdr workspace reports a `working` or `blocked` agent.
- Force past uncommitted changes. Skip and report instead.
- Reach for `git branch -D` when `-d` refuses.
- Call a branch unmerged on the ancestor check alone. Check the pull request before deciding.
- Delete a remote branch with no merged pull request and no ancestor in an integration branch.
- Remove a checkout with plain git while herdr still holds a workspace for it. That leaves a sidebar row pointing at nothing.
- Scan a submodule's worktrees without saying so.
