---
name: teardown-worktree
description: "Retire finished git worktrees – move this session back to the main checkout, move the orchestrator's pane back to the main repo workspace, remove the checkouts, and delete the merged local and remote branches. Scans the whole repo, not just the current worktree. Use whenever the user says \"tear down the worktree\", \"clean up worktrees\", \"remove this worktree\", \"delete the worktree and branch\", \"clean up stale worktrees\", or otherwise wants finished worktrees and their branches gone."
argument-hint: "[worktree name, or nothing to scan the whole repo]"
---

# Teardown worktree

Retire finished worktrees.

Move this session out first. Remove the worktrees next. Delete the branches they were on last.

Removing a worktree this session is standing in, or one that still holds a running agent, destroys live work. The order below exists to prevent that, as far as either orchestrator can tell. Follow it.

## When to use

Trigger on "tear down the worktree", "clean up worktrees", "remove this worktree", "delete the worktree and branch", "clean up stale worktrees". Also fair game straight after a merge, when the user says the work has shipped.

## Scope

One repo per run: the repo that owns the cwd. Resolve its main checkout from anywhere inside it:

```bash
dirname "$(git rev-parse --git-common-dir)"
```

Submodules are separate repos with their own worktrees and their own remote.

If the repo has submodules carrying worktrees, say so. Offer a second run against each. Never scan them silently.

## 1. Build the plan

Remove nothing before the full plan is on screen and the user has approved it. One approval covers the whole run.

List every worktree of the repo:

```bash
git worktree list --porcelain
```

Skip the main checkout. First settle who hosts this session and who owns each checkout, then classify each remaining worktree on the four checks that follow.

### Which orchestrator hosts this session, and which one owns each checkout

Settle both before the four checks. A worktree orchestrator is a tool that opens panes and holds worktrees for you – herdr and Orca are the two this skill knows.

Two different facts drive this skill:

- The **host** is the orchestrator running this session's terminal. It decides how this session moves itself out in step 2.
- The **owner** is the orchestrator holding a checkout on disk. It decides which command step 3 runs against that checkout.

The rule in one line: the session's host creates a worktree, and the checkout's owner removes it.

Host and owner are often the same, and they do not have to be. A herdr pane can open a checkout Orca created. A checkout herdr created can outlive the pane that made it.

So read the owner per worktree, and never assume the host owns anything.

Neither tool sees the other's sessions. `herdr worktree list` never reports an Orca agent, and Orca's listing never reports a herdr pane. That is why the live-agent check below asks both tools about every candidate, whoever owns it.

A script shipped with the sibling `new-worktree` skill answers both questions. Run it rather than working it out by hand:

```bash
SPECHUB_ROOT=$(cd -- "$(dirname -- "$(readlink -f "$HOME/.claude/spechub/bin/spechub")")/../.." && pwd)
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh"          # the host
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh" <path>   # one checkout's owner
```

Read `detector.md` before you run the detector for the first time in a session. It explains the path, the six output lines, and the case where the script does not run.

Run the script once with no argument to read `active`. Then run it once per worktree in the plan, passing that worktree's path, and read `owner` from each run.

Repeat a non-empty `warning` to the user verbatim, before anything else happens. Then let `active` decide how this session moves itself out in step 2. Let each checkout's `owner` decide how step 3 removes it.

The script sometimes does not run at all. Then follow `detector.md`, and treat every worktree as plain git.

### Owner

Read `owner` for each worktree, passing that worktree's path to the detector. The owner decides how step 3 removes the checkout:

- `herdr` – herdr holds this checkout. Step 3 removes it through herdr.
- `orca` – Orca holds this checkout. Step 3 removes it through Orca.
- `none` – plain git holds this checkout. Step 3 removes it with git.

Plain git is not a fallback for an Orca-owned checkout. It deletes the directory while Orca still holds a row for it in its sidebar, leaving that row pointing at nothing. That is the same failure the `Never` rule at the end of this file names for herdr.

Orca's own listing does not settle ownership either. `orca worktree list` also reports herdr and plain git checkouts when the user turns external visibility on. Trust the detector's `owner`.

### Uncommitted work

```bash
git -C <path> status --porcelain --ignore-submodules=all
```

`--ignore-submodules=all` is not optional. Without it, a submodule checked out ahead of its committed pointer reads as uncommitted work. Then every worktree in a repo with submodules looks dirty, and you never remove any of them.

Report pointer drift in the plan anyway, from `git -C <path> submodule status`. That way a real pending bump stays visible, and the ignore flag does not hide it.

Any output from the status check means skip.

Do not remove it. Do not force it. List it at the end with what it holds.

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

Merged by either test counts as merged. Merged by neither means skip. Report it.

### Live agent

The worktree this session is standing in is never a candidate, whatever else is true. Step 2 still moves the session out before step 3 removes anything.

Beyond that, ask both orchestrators about every candidate, whoever owns it. Neither tool sees the other's sessions, and either one can hold a live agent in a checkout the other owns. One tool's silence is not an answer, so a check you skip is a session you may destroy.

Skip a tool only when this host does not have it. Read that from the detector's `declared_herdr` and `declared_orca`. A tool the host lacks holds no sessions.

Say in the plan which checks ran and which did not, once per worktree, so nobody reads a missing check as a passed check.

Ask herdr the way `herdr.md` step 1 says, and Orca the way `orca.md` step 1 says, whoever owns the checkout.

#### When the host has neither tool

Nothing holds agent state, so nothing can confirm liveness. Classification then rests on the uncommitted-work and merged checks alone.

### Show it

Print one table with six columns: worktree, branch, whether the local branch goes, whether the remote branch goes, blocking panes, and the reason. Then ask once.

The blocking panes column names each pane that blocks the removal, pane id first and process name after – `w26:p2 claude` for example. Leave the cell empty when nothing blocks. The user then knows which pane to close.

## 2. Move this session out

Do this before removing anything, and only after approval.

`EnterWorktree` cannot do this. It rejects the main checkout outright, "is the main working tree, not a linked worktree".

So no tool call walks the session cwd back. `ExitWorktree` only unwinds a worktree this session entered with `EnterWorktree`. It is a no-op for a session that launched inside one.

The removal itself is what moves the session. Run it from the main checkout against an absolute path.

The harness then resets the session cwd to the main checkout on its own. Confirm with `pwd` afterwards.

- Entered with `EnterWorktree`: call `ExitWorktree` with `action: "keep"` first. Keep, not remove: step 3 owns the removal, and `remove` refuses on a worktree entered by path.
- Launched inside the worktree: no call needed.

    Take the pane with you below. Remove the worktree in step 3. Confirm the new cwd after.

That much is the same everywhere. What follows depends on the branch `active` names. This step is the one place `active` still decides anything: how this session moves itself.

When `active` is `herdr`, follow `herdr.md` step 2 before you remove anything.

When `active` is `orca`, follow `orca.md` step 2. It leaves this session's own checkout in place.

### Host: none

There is no pane and no workspace, so the cwd move described above is the whole step. No other tool needs to know where this session went.

## 3. Remove the worktrees

Every removal through herdr or plain git passes `--force`. Orca is the exception, and `orca.md` step 3 says why. `--force` is necessary here, not a shortcut.

Plain `git worktree remove` refuses on any worktree containing submodules with "working trees containing submodules cannot be moved or removed". That refusal hits every worktree in a repo that has them.

Forcing is safe only because step 1 already proved the tree clean. It is never a way past uncommitted changes.

The hard rule: never run `worktree remove --force` on a workspace that still holds a pane other than this session's own. Forcing waives herdr's own check, so the pane enumeration is the only guard left.

Enumerate the panes again immediately before the call. Refuse the removal while any other pane remains.

Take the branch each checkout's `owner` names, not the branch `active` names. Decide per worktree: one checkout in the plan can belong to herdr while the next is plain git.

Before each removal, confirm the live-agent checks from step 1 still hold. Both tools, every time, because neither sees the other's sessions. A pane can open between the plan and the removal, so re-read the panes rather than trusting the plan.

For a checkout whose `owner` is `herdr`, follow `herdr.md` step 3.

For a checkout whose `owner` is `orca`, follow `orca.md` step 3. It never passes `--force`, and never removes an unmerged branch.

### Owner: none

Plain git, always – there is no workspace to weigh up:

```bash
git -C <main-root> worktree remove --force <path>
git -C <main-root> worktree prune
```

## 4. Delete the branches

Only for worktrees removed in step 3, and only for branches step 1 proved merged.

```bash
git -C <main-root> branch -d <branch>
git -C <main-root> push origin --delete <branch>
```

Skip the local delete for an Orca-owned checkout. `orca worktree rm` already deleted that branch in step 3, so run the remote delete alone.

Use `branch -d`, never `-D`. If `-d` refuses, the merge test was wrong. Stop and report rather than forcing.

Skip the remote delete when nobody ever pushed the branch, or when merging the pull request already deleted it. The `git fetch origin --prune` from step 1 keeps a branch GitHub already removed from looking like work to do.

## 5. Report

State what went and what stayed:

- Worktrees removed, with their branches
- Worktrees skipped, each with its reason: uncommitted work, an unmerged branch, a live agent or terminal, or the checkout this Orca terminal stands in
- Which live-agent checks ran against each worktree, and which did not, so nobody reads a missing check as a passed check
- Anything left for the user to decide

## Never

- Remove a worktree this session is standing in. Move out first.
- Remove a worktree whose herdr workspace reports a `working`, `blocked`, `idle` or `done` agent. `idle` means present and waiting, not absent.
- Decide on the workspace `agent_status` alone. List the panes and read `herdr pane process-info` for each one before removing.
- Read the workspace `agent_status` as this session's own verdict. Exclude your own pane by `$HERDR_PANE_ID` instead.
- Remove a workspace that still holds a pane other than your own.
- Reach for `EnterWorktree` to get back to the main checkout. It rejects the main working tree.
- Force past uncommitted changes. Skip and report instead.
- Reach for `git branch -D` when `-d` refuses.
- Call a branch unmerged on the ancestor check alone. Check the pull request before deciding.
- Delete a remote branch with no merged pull request and no ancestor in an integration branch.
- Remove a worktree with plain git while herdr still holds a workspace for it. That leaves a sidebar row pointing at nothing.
- Scan a submodule's worktrees without saying so.
- Hard-code an orchestrator, or branch on an environment variable directly. Run the detector, then use `active` and `owner`.
- Remove a checkout with the branch `active` names. The owner removes, whoever hosts this session.
- Read one orchestrator's listing as the whole answer. Ask both before every removal.
- Swallow the detector's `warning`. Say it to the user before doing anything else.
- Run a tool the host does not have installed. A missing tool holds no sessions.
- Remove an Orca-owned checkout with plain git. Use `orca worktree rm` and leave Orca's sidebar in step.
- Pass `--force` to `orca worktree rm`. It waives the only safety checks left at that point.
- Call `orca worktree rm` on an unmerged branch. It deletes the branch with the checkout, and nothing asks first.
- Remove the checkout an Orca terminal is standing in. Orca cannot move that terminal out.
- Stop an Orca terminal during a teardown. Name it and let the user decide.
