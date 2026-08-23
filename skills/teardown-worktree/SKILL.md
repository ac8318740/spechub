---
name: teardown-worktree
description: "Retire finished git worktrees – move this session back to the main checkout, move the orchestrator's pane back to the main repo workspace, remove the checkouts, and delete the merged local and remote branches. Scans the whole repo, not just the current worktree. Use whenever the user says \"tear down the worktree\", \"clean up worktrees\", \"remove this worktree\", \"delete the worktree and branch\", \"clean up stale worktrees\", or otherwise wants finished worktrees and their branches gone."
argument-hint: "[worktree name, or nothing to scan the whole repo]"
---

# Teardown worktree

Retire finished worktrees. Move this session out first. Remove the worktrees next. Delete the branches they were on last.

Removing a worktree this session is standing in, or one that still holds a running agent, destroys live work. The order below exists to prevent that, as far as either orchestrator can tell. Follow it.

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

Skip the main checkout. First settle who hosts this session and who owns each checkout, then classify each remaining worktree on the four checks that follow.

### Which orchestrator hosts this session, and which one owns each checkout

Settle both before the four checks. A worktree orchestrator is a tool that opens panes and holds worktrees for you – herdr and Orca are the two this skill knows.

Two different facts drive this skill:

- The **host** is the orchestrator running this session's terminal. It decides how this session moves itself out in step 2.
- The **owner** is the orchestrator holding a checkout on disk. It decides which command step 3 runs against that checkout.

The rule in one line: the session's host creates a worktree, and the checkout's owner removes it.

Host and owner are often the same, and they do not have to be. A herdr pane can open a checkout Orca created. A checkout herdr created can outlive the pane that made it. So read the owner per worktree, and never assume the host owns anything.

Neither tool sees the other's sessions. `herdr worktree list` never reports an Orca agent, and Orca's listing never reports a herdr pane. That is why the live-agent check below asks both tools about every candidate, whoever owns it.

A script shipped with the sibling `new-worktree` skill answers both questions. Run it rather than working it out by hand:

```bash
SPECHUB_ROOT=$(cd -- "$(dirname -- "$(readlink -f "$HOME/.claude/spechub/bin/spechub")")/../.." && pwd)
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh"          # the host
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh" <path>   # one checkout's owner
```

The path goes through `~/.claude/spechub/bin/spechub`, the invariant symlink the SessionStart hook maintains. The plugin re-creates that symlink every time Claude Code starts. It is the only reliable way to find the plugin's own root. Do not invent a shorter path, and do not reach for `$CLAUDE_PLUGIN_ROOT` – the plugin deliberately does not depend on that variable reaching a fresh subshell.

Run the script once with no argument to read `active`. Then run it once per worktree in the plan, passing that worktree's path, and read `owner` from each run.

The script always exits 0 and prints exactly six lines:

- `declared_herdr` – whether the user has herdr installed on this host, recorded in the SpecHub global config under `host.orchestrators.herdr`. One of `true`, `false`, `unset`.
- `declared_orca` – the same yes-or-no answer for Orca, recorded under `host.orchestrators.orca`. One of `true`, `false`, `unset`. The two are independent: a host can have both installed, one, or neither, so one answer says nothing about the other.
- `detected` – which orchestrator is actually hosting this session, read from the environment markers an orchestrator injects into the terminals it opens. One of `herdr`, `orca`, `none`.
- `active` – the branch to run for this session. One of `herdr`, `orca`, `none`.
- `owner` – which orchestrator owns the checkout the script examined. One of `herdr`, `orca`, `none`. The path settles it: a checkout under `~/orca/workspaces/` belongs to Orca, and a checkout under herdr's worktree root belongs to herdr. herdr's config names that root. Anything else is plain git.
- `warning` – one line written for a human, empty when there is nothing to say.

Declared means installed. Detected means hosting. Detected wins, so `active` always equals `detected`. This session cannot drive an installed orchestrator that does not host it. A marker for an orchestrator the host never declared earns a warning, not a refusal.

Repeat a non-empty `warning` to the user verbatim, before anything else happens. Then let `active` decide how this session moves itself out in step 2. Let each checkout's `owner` decide how step 3 removes it.

The script sometimes does not run at all: no output, and a non-zero exit from the invocation itself. Then there is no `active` and no `owner` to read. Do not guess either one. Say so to the user. Then treat every worktree as plain git, the branch that touches nothing an orchestrator holds. A missing or non-executable script looks like this, and a plugin older than the script is the usual cause.

This is the same detector `new-worktree` runs, so both skills always give the same answer on the same host.

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

The worktree this session is standing in is never a candidate, whatever else is true. Step 2 still moves the session out before step 3 removes anything.

Beyond that, ask both orchestrators about every candidate, whoever owns it. Neither tool sees the other's sessions, and either one can hold a live agent in a checkout the other owns. One tool's silence is not an answer, so a check you skip is a session you may destroy.

Skip a tool only when this host does not have it. Read that from the detector's `declared_herdr` and `declared_orca`. A tool the host lacks holds no sessions.

Say in the plan which checks ran and which did not, once per worktree, so nobody reads a missing check as a passed check.

#### herdr's answer

Check the workspace holding each worktree:

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

#### Orca's answer

Resolve Orca's executable before you call it. The Linux binary is `orca-ide`, and some installs put it on PATH as plain `orca`. Never hard-code either name.

This listing reads state and changes nothing. Step 3 runs the removal separately, and only against a checkout Orca owns.

```bash
ORCA_BIN="$(command -v orca-ide || command -v orca)"
"$ORCA_BIN" worktree ps --json
```

Match each entry to a candidate on `.result.worktrees[].path`. Then read `agents`, `liveTerminalCount`, `hasAttachedPty` and `status` from that entry.

Skip the worktree while `agents[]` holds anything, or while `liveTerminalCount` is above zero. Orca does not guard this itself on the command-line path. Someone watched a live check remove a worktree whose agent was mid-tool-call.

An empty `agents` with a live terminal count is the common case, not a live agent. `orca worktree create` spawns a shell in every checkout it makes. That one shell holds the count at one.

Skip it anyway. Then name the terminals, so the user can decide:

```bash
"$ORCA_BIN" terminal list --worktree path:<path> --json
```

Tell them what clears an idle shell: `"$ORCA_BIN" terminal stop --worktree path:<path> --json`. A later run then removes the worktree.

This skill never stops a terminal. Only the user knows what a shell was holding, so the call is theirs.

#### When the host has neither tool

Nothing holds agent state, so nothing can confirm liveness. Classification then rests on the uncommitted-work and merged checks alone.

### Show it

Print one table: worktree, branch, whether the local branch goes, whether the remote branch goes, and the reason. Then ask once.

## 2. Move this session out

Do this before removing anything, and only after approval.

`EnterWorktree` cannot do this. It rejects the main checkout outright, "is the main working tree, not a linked worktree". So no tool call walks the session cwd back. `ExitWorktree` only unwinds a worktree this session entered with `EnterWorktree`. It is a no-op for a session that launched inside one.

The removal itself is what moves the session. Run it from the main checkout against an absolute path. The harness then resets the session cwd to the main checkout on its own. Confirm with `pwd` afterwards.

- Entered with `EnterWorktree`: call `ExitWorktree` with `action: "keep"` first. Keep, not remove: step 3 owns the removal, and `remove` refuses on a worktree entered by path.
- Launched inside the worktree: no call needed. Take the pane with you below. Remove the worktree in step 3. Confirm the new cwd after.

That much is the same everywhere. What follows depends on the branch `active` names. This step is the one place `active` still decides anything: how this session moves itself.

### Host: herdr

When `active` is `herdr`, move the pane out first, or step 3 deletes the worktree under a pane still sitting in that workspace.

The move needs this pane's own identifier, and `active` being `herdr` does not guarantee it. The detector reports `herdr` when either of herdr's two environment markers holds a value, and only one of them names the pane. So if `$HERDR_PANE_ID` is empty, herdr's markers are incomplete – say so and stop, rather than issuing a pane move against a blank target.

Find the main repo's workspace in `herdr workspace list`: `worktree.repo_root` is the main checkout and `worktree.is_linked_worktree` is `false`. More than one workspace can match, since any pane opened at the repo root qualifies. Prefer the one whose label is the repo name, and ask when it stays ambiguous. Then:

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <main-workspace-id> --focus
```

If no such workspace exists because it closed earlier, create one first:

```bash
herdr workspace create --cwd <main-root> --label <repo-name> --no-focus
```

The pane's own shell keeps the deleted directory as its cwd, which `herdr pane process-info` reports as `(deleted)`. That is cosmetic, and only visible once the agent exits and hands the prompt back.

### Host: orca

Orca has no command that moves a running terminal into another worktree. The `herdr pane move` step above has no Orca equivalent, so the cwd move is all this session can do.

That is not enough for the checkout this session stands in. The Orca terminal keeps its shell inside that directory, and Orca keeps a row bound to it. Removing it breaks both.

So leave that one checkout in place. Name it to the user, and say why it stayed. Suggest they run the teardown again from a different Orca terminal.

Every other worktree in the plan goes as normal. This session stands outside them, so nothing has to move.

### Host: none

There is no pane and no workspace, so the cwd move described above is the whole step. No other tool needs to know where this session went.

## 3. Remove the worktrees

Every removal through herdr or plain git passes `--force`. Orca is the exception, and its own branch below says why. `--force` is necessary here, not a shortcut. Plain `git worktree remove` refuses on any worktree containing submodules with "working trees containing submodules cannot be moved or removed". That refusal hits every worktree in a repo that has them. Forcing is safe only because step 1 already proved the tree clean. It is never a way past uncommitted changes.

Take the branch each checkout's `owner` names, not the branch `active` names. Decide per worktree: one checkout in the plan can belong to herdr while the next is plain git.

Before each removal, confirm the live-agent checks from step 1 still hold. Both tools, every time, because neither sees the other's sessions.

### Owner: herdr

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

### Owner: orca

Orca holds this checkout, so Orca removes it. Resolve the executable the same way step 1 did:

```bash
ORCA_BIN="$(command -v orca-ide || command -v orca)"
"$ORCA_BIN" worktree rm --worktree path:<path> --json
```

Never pass `--force`. It waives Orca's own safety checks, and those checks are the only ones left at this point.

Orca refuses two cases by itself. It refuses a dirty tree, and it refuses a path outside `~/orca/workspaces`. Read either refusal rather than overriding it. Step 1 proved the tree clean, so a dirty-tree refusal means somebody changed the tree since.

`orca worktree rm` deletes the local branch itself, and it has no keep-branch flag. So decide keep-or-delete before you call it, using the merge result from step 1. Never call it on an unmerged branch: the branch goes with the checkout, and nothing asks first. Leave the checkout in place instead and report it.

Step 4 then skips `git branch -d` for this checkout. Orca already deleted that branch. The remote branch is still step 4's job.

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
- Decide on `agent_status` alone. Confirm with `herdr pane process-info` before removing.
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
