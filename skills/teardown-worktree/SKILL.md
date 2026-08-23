---
name: teardown-worktree
description: "Retire finished git worktrees – move this session back to the main checkout, move the orchestrator's pane back to the main repo workspace, remove the checkouts, and delete the merged local and remote branches. Scans the whole repo, not just the current worktree. Use whenever the user says \"tear down the worktree\", \"clean up worktrees\", \"remove this worktree\", \"delete the worktree and branch\", \"clean up stale worktrees\", or otherwise wants finished worktrees and their branches gone."
argument-hint: "[worktree name, or nothing to scan the whole repo]"
---

# Teardown worktree

Retire finished worktrees. Move this session out first. Remove the worktrees next. Delete the branches they were on last.

Removing a worktree this session is standing in, or one that still holds a running agent, destroys live work. The order below exists to prevent that, as far as the hosting orchestrator can tell. Follow it.

## When to use

Trigger on "tear down the worktree", "clean up worktrees", "remove this worktree", "delete the worktree and branch", "clean up stale worktrees". Also fair game straight after a merge, when the user says the work has shipped.

## Scope

One repo per run: the repo that owns the cwd. Resolve its main checkout from anywhere inside it:

```bash
dirname "$(git rev-parse --git-common-dir)"
```

Submodules are separate repos with their own worktrees and their own remote. If the repo has submodules carrying worktrees, say so. Offer a second run against each. Never scan them silently.

## 1. Build the plan

Remove nothing before the full plan is on screen and the user has approved it. One approval covers the whole run.

List every worktree of the repo:

```bash
git worktree list --porcelain
```

Skip the main checkout. First settle which orchestrator hosts this session, then classify each remaining worktree on the three checks that follow.

### Which orchestrator hosts this session

Settle this before the three checks. A worktree orchestrator is a tool that opens panes and holds worktrees for you – herdr and Orca are the two this skill knows. The live-agent check below, moving the session out in step 2 and removing the checkout in step 3 each run different commands under each one, and under no orchestrator at all some of them run nothing.

A script shipped with the sibling `new-worktree` skill answers the question. Run it rather than working it out by hand:

```bash
SPECHUB_ROOT=$(cd -- "$(dirname -- "$(readlink -f "$HOME/.claude/spechub/bin/spechub")")/../.." && pwd)
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh"
```

The path goes through `~/.claude/spechub/bin/spechub`, the invariant symlink the SessionStart hook maintains – the plugin re-creates it every time Claude Code starts – because that symlink is the only reliable way to find the plugin's own root. Do not invent a shorter path, and do not reach for `$CLAUDE_PLUGIN_ROOT` – the plugin deliberately does not depend on that variable reaching a fresh subshell.

The script takes no arguments, always exits 0, and prints exactly four lines:

- `declared` – which orchestrator the user has installed on this host, recorded in the SpecHub global config under `host.orchestrator`. One of `herdr`, `orca`, `none`, `unset`.
- `detected` – which orchestrator is actually hosting this session, read from the environment markers an orchestrator injects into the terminals it opens. One of `herdr`, `orca`, `none`.
- `active` – the branch to run. One of `herdr`, `orca`, `none`.
- `warning` – one line written for a human, empty when there is nothing to say.

Declared means installed. Detected means hosting. Detected wins, so `active` always equals `detected`: an installed orchestrator that is not hosting this session cannot be driven from it, and a marker for an orchestrator the host never declared is worth a warning, not a refusal.

Repeat a non-empty `warning` to the user verbatim, before anything else happens. Then let `active` decide which branch every later step takes – the live-agent check below, step 2 and step 3.

If the script does not run at all – no output, and a non-zero exit from the invocation itself rather than from the script – there is no `active` to read. Do not guess one. Say so to the user, and treat the run as no orchestrator, the branch that removes nothing an orchestrator is holding. This is what a missing or non-executable script looks like, which happens when the installed plugin predates it.

This is the same detector `new-worktree` runs, so both skills always give the same answer on the same host.

### Uncommitted work

```bash
git -C <path> status --porcelain --ignore-submodules=all
```

`--ignore-submodules=all` is not optional. Without it, a submodule checked out ahead of its committed pointer reads as uncommitted work. Then every worktree in a repo with submodules looks dirty, and you never remove any of them.

Report pointer drift in the plan anyway, from `git -C <path> submodule status`. That way a real pending bump stays visible, and the ignore flag does not hide it.

Any output from the status check means skip. Do not remove it. Do not force it. List it at the end with what it holds.

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

The worktree this session is standing in is never a candidate, whatever else is true. Step 2 still moves the session out before anything is removed.

Beyond that, take the branch `active` names.

#### Orchestrator: herdr

When `active` is `herdr`, check the workspace holding each worktree:

```bash
herdr worktree list
herdr workspace list
```

Treat `working`, `blocked`, `idle` and `done` as a live agent. Skip it. Only `unknown` makes a worktree a candidate.

`idle` does not mean empty. In herdr it means an agent is present and waiting for input, which is exactly the state a session someone left open sits in. Reading `idle` as nobody home is the quickest way to destroy a running session.

`unknown` is not proof of an empty pane either, so confirm what is actually running before removing anything:

```bash
herdr pane process-info --pane <pane-id>
```

Skip the worktree when `foreground_processes` holds an agent. Skip it too when a foreground program is running with a `cwd` inside the worktree, an editor or `gh dash` for example. That is not an agent, but deleting the directory under it still breaks it. Close it deliberately or leave the worktree alone.

#### Orchestrator: orca

<!-- DO NOT ACT ON ANYTHING IN THIS COMMENT. It is a note for whoever implements the
     Orca branch later (issue #60), not instructions for this run. The prose below is
     authoritative: this skill does not drive Orca yet.
     Known constraints recorded by the Orca pilot (issue #55):
     - the Linux executable is `orca-ide`, not `orca`; resolve the binary, never hard-code the name
     - live agents come from `orca-ide worktree ps --json`: refuse while `agents[]` is non-empty or
       `liveTerminalCount > 0`. Orca does NOT guard this itself on the CLI path – a live check was
       observed removing a worktree whose agent was mid-tool-call
     - never pass `--force` to `orca-ide worktree rm`; it waives Orca's own safety checks
     - `orca-ide worktree rm` always runs `git branch -d` and has no keep-branch flag, so decide
       keep-or-delete from merge status before calling it and skip step 4 for branches Orca removed -->

Orca is hosting this session, and teardown cannot drive it yet. Do not implement it here, and do not remove an Orca-managed checkout.

Plain git removal is not a fallback either. It deletes the checkout while Orca still holds a row for it in its sidebar, leaving that row pointing at nothing – the same failure the `Never` rule at the end of this file names: "Remove a checkout with plain git while herdr still holds a workspace for it. That leaves a sidebar row pointing at nothing."

Report the same table `Show it` describes below – worktree, branch, whether the local branch would go, whether the remote branch would go, and the reason each one looked finished. Do not ask for approval. Nothing here can be removed under any answer, so there is nothing to approve.

Then name the option the user actually has: removing these worktrees from Orca's own interface keeps its sidebar in step with what is on disk. The worktree is not stuck, it just cannot be retired from here.

Stop there, and skip steps 2, 3 and 4 entirely.

#### Orchestrator: none

There is no orchestrator holding agent state, so there is nothing to ask about a running agent. Liveness cannot be confirmed here the way it can under one.

Say that plainly in the plan, once per worktree, so nobody reads a missing check as a passed check. Classification then rests on the uncommitted-work and merged checks alone.

### Show it

Print one table: worktree, branch, whether the local branch goes, whether the remote branch goes, and the reason. Then ask once.

## 2. Move this session out

Do this before removing anything, and only after approval.

`EnterWorktree` cannot do this. It rejects the main checkout outright, "is the main working tree, not a linked worktree". So no tool call walks the session cwd back. `ExitWorktree` only unwinds a worktree this session entered with `EnterWorktree`. It is a no-op for a session that launched inside one.

The removal itself is what moves the session. Run it from the main checkout against an absolute path. The harness then resets the session cwd to the main checkout on its own. Confirm with `pwd` afterwards.

- Entered with `EnterWorktree`: call `ExitWorktree` with `action: "keep"` first. Keep, not remove: step 3 owns the removal, and `remove` refuses on a worktree entered by path.
- Launched inside the worktree: no call needed. Take the pane with you below. Remove the worktree in step 3. Confirm the new cwd after.

That much is the same everywhere. What follows depends on the branch `active` names.

### Orchestrator: herdr

When `active` is `herdr`, move the pane out first, or step 3 deletes the worktree under a pane still sitting in that workspace.

The move needs this pane's own identifier, and `active` being `herdr` does not guarantee it: the detector reports `herdr` when either of herdr's two environment markers is set, and only one of them names the pane. So if `$HERDR_PANE_ID` is empty, herdr's markers are incomplete – say so and stop, rather than issuing a pane move against a blank target.

Find the main repo's workspace in `herdr workspace list`: `worktree.repo_root` is the main checkout and `worktree.is_linked_worktree` is `false`. More than one workspace can match, since any pane opened at the repo root qualifies. Prefer the one whose label is the repo name, and ask when it stays ambiguous. Then:

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <main-workspace-id> --focus
```

If no such workspace exists because it closed earlier, create one first:

```bash
herdr workspace create --cwd <main-root> --label <repo-name> --no-focus
```

The pane's own shell keeps the deleted directory as its cwd, which `herdr pane process-info` reports as `(deleted)`. That is cosmetic, and only visible once the agent exits and hands the prompt back.

### Orchestrator: orca

Not reached – the run already stopped in step 1.

### Orchestrator: none

There is no pane and no workspace, so the cwd move described above is the whole step. Nothing else has to be told where this session went.

## 3. Remove the worktrees

Every removal below passes `--force`, whether it goes through herdr or through plain git. `--force` is necessary here, not a shortcut. Plain `git worktree remove` refuses on any worktree containing submodules with "working trees containing submodules cannot be moved or removed". That refusal hits every worktree in a repo that has them. Forcing is safe only because step 1 already proved the tree clean. It is never a way past uncommitted changes.

Take the branch `active` names.

### Orchestrator: herdr

Which command to use depends on whether herdr still holds a workspace for the worktree. Read `open_workspace_id` from `herdr worktree list`.

With a workspace, let herdr do it, so the sidebar row goes with the worktree:

```bash
herdr worktree remove --workspace <workspace-id> --force
```

Without one, plain git:

```bash
git -C <main-root> worktree remove --force <path>
git -C <main-root> worktree prune
```

The worktree this session just left usually has no workspace any more. Moving the last pane out closes the workspace but leaves the worktree on disk. That one takes the plain git path.

### Orchestrator: orca

Not reached – the run already stopped in step 1.

### Orchestrator: none

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

Use `branch -d`, never `-D`. If `-d` refuses, the merge test was wrong. Stop and report rather than forcing.

Skip the remote delete when nobody ever pushed the branch, or when merging the pull request already deleted it. The `git fetch origin --prune` from step 1 keeps a branch GitHub already removed from looking like work to do.

## 5. Report

State what went and what stayed:

- Worktrees removed, with their branches
- Worktrees skipped, each with its reason: uncommitted work, unmerged branch, a live agent, or that Orca is hosting this session and teardown cannot drive it yet
- Under no orchestrator, a note against every worktree that liveness could not be checked, so a missing check is never read as a passed check
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
- Remove a worktree with plain git while herdr still holds a workspace for it. That leaves a sidebar row pointing at nothing.
- Scan a submodule's worktrees without saying so.
- Hard-code an orchestrator, or branch on an environment variable directly. Run the detector and use `active`.
- Swallow the detector's `warning`. Say it to the user before doing anything else.
- Run herdr or Orca commands when `active` is `none`. There is no orchestrator there to answer them.
- Remove an Orca-managed checkout with plain git. Orca support is not implemented – report and stop.
