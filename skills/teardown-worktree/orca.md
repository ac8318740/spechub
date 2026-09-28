# Teardown worktree: Orca

The Orca branches of the teardown. Each section names the `SKILL.md` step it belongs to.

## Step 1 – Orca's answer

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

## Step 2 – Host: orca

Orca has no command that moves a running terminal into another worktree. The `herdr pane move` step in `herdr.md` has no Orca equivalent, so the cwd move is all this session can do.

That is not enough for the checkout this session stands in. The Orca terminal keeps its shell inside that directory, and Orca keeps a row bound to it. Removing it breaks both.

So leave that one checkout in place. Name it to the user, and say why it stayed. Suggest they run the teardown again from a different Orca terminal.

Every other worktree in the plan goes as normal. This session stands outside them, so nothing has to move.

## Step 3 – Owner: orca

Orca holds this checkout, so Orca removes it. Resolve the executable the same way step 1 did:

```bash
ORCA_BIN="$(command -v orca-ide || command -v orca)"
"$ORCA_BIN" worktree rm --worktree path:<path> --json
```

Never pass `--force`. It waives Orca's own safety checks, and those checks are the only ones left at this point.

Orca refuses two cases by itself. It refuses a dirty tree, and it refuses a path outside `~/orca/workspaces`.

Read either refusal rather than overriding it. Step 1 proved the tree clean, so a dirty-tree refusal means somebody changed the tree since.

`orca worktree rm` deletes the local branch itself, and it has no keep-branch flag. So decide keep-or-delete before you call it, using the merge result from step 1.

Never call it on an unmerged branch: the branch goes with the checkout, and nothing asks first. Leave the checkout in place instead and report it.

Step 4 then skips `git branch -d` for this checkout. Orca already deleted that branch. The remote branch is still step 4's job.
