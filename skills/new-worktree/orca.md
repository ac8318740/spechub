# New worktree: Orca

The `Orchestrator: orca` branch of `SKILL.md`, for when `active` is `orca`.

When `active` is `orca`, the session runs in an Orca terminal. Create the worktree through Orca, then change this session's working directory into the checkout Orca reports.

There is no pane move here. Orca has no command that moves a running terminal into another worktree, so step 3 is a plain cwd change. That is the one place this branch differs from herdr.

Run every step below. Stopping after step 3 leaves an idle Orca shell in the checkout, and `teardown-worktree` then refuses to remove it.

There is no marker check either. Orca injects `ORCA_PANE_KEY` and `ORCA_WORKTREE_ID` into the terminals it opens, and the detector already reads them. The commands below target the repo by path, so they need neither marker.

Resolve Orca's executable before you call it. The Linux binary is `orca-ide`, and some installs put it on PATH as plain `orca`. Never hard-code either name:

```bash
ORCA_BIN="$(command -v orca-ide || command -v orca)"
```

Every Orca command takes `--json` and answers with one object: `{id, ok, result, error, _meta}`. Read `.ok` before you read anything else.

## 1. Create the worktree

`<base>` per the base rule in `SKILL.md`.

```bash
cd <main-root> \
  && git fetch origin --quiet \
  && "$ORCA_BIN" worktree create \
       --repo path:"$(pwd)" \
       --name <slug> \
       --base-branch <base> \
       --no-parent \
       --json
```

`--repo` must name the MAIN repo root, the same rule herdr's `--cwd` follows. Pass `--no-parent` so Orca records the checkout as independent work. Without it, Orca makes the new worktree a child of whatever this terminal sits in.

Read three values from the JSON rather than assuming any of them:

- `.result.worktree.path` – the checkout, for `git -C <path> log -1 --oneline` to confirm the base commit
- `.result.worktree.branch` – the branch Orca made, as a full ref such as `refs/heads/<github-user>/<name>`
- `.result.worktree.baseRef` – the ref Orca branched from

Never compute the path or the branch.

Orca places the checkout under `~/orca/workspaces/<repo>/<name>`, and it names the branch `<github-user>/<name>`. So the `<type>/<slug>` branch rule in `SKILL.md` does not survive here. Pass the slug as `--name`, then report the branch Orca actually returned.

Strip the `refs/heads/` prefix before you report that branch. `git branch --show-current` in the checkout prints the same short name, so the two agree.

## 2. When Orca refuses

`repo_not_found` in `.error` means Orca does not know this repo. Register it once, then retry the create:

```bash
"$ORCA_BIN" repo add --path <main-root> --json
```

On any other failure, show the user the exact command and Orca's `error`, then stop. Never fall through to plain git.

Orca cannot see a checkout made behind its back, cannot track it, and cannot later remove it. That leaves the user holding a worktree their orchestrator will never account for.

## 3. Move this session in

Change cwd into the path Orca returned, the way `Orchestrator: none` does. `Then move into it` in `SKILL.md` covers it.

Offer the fresh-session variant too. It opens a new Orca terminal in the checkout, running its own agent. Stop the spare shell first, or the new terminal joins it:

```bash
"$ORCA_BIN" terminal stop --worktree path:<path> --json
"$ORCA_BIN" terminal create --worktree path:<path> --title <slug> --command "claude" --json
```

Take that route only when the user asks for it.

This session then stays where it is. Otherwise two agents share one checkout. That ordering also settles step 4, so skip it.

## 4. Stop the spare shell

`orca worktree create` always spawns a shell terminal in the new checkout. Stop it once this session has moved in:

```bash
"$ORCA_BIN" terminal stop --worktree path:<path> --json
```

The result counts what it stopped, as `{"stopped": N}`. `terminal stop` stops every terminal Orca holds for that worktree, not the spare one alone. So run it before you open anything in the checkout that you want to keep.

Leaving that shell running costs the user a worktree later. `teardown-worktree` refuses to remove a checkout whose `liveTerminalCount` is above zero. The idle shell alone holds that count at one. So the worktree never becomes a teardown candidate.

## If the checkout already exists

Attach to it instead of creating a second one:

```bash
"$ORCA_BIN" worktree list --repo path:<main-root> --json
```

Match `.result.worktrees[].branch`, which holds a full ref such as `refs/heads/<github-user>/roadmap-gantt`, or match `.displayName`. Then take that entry's `.path` and carry on from step 3.

Match only a path under `~/orca/workspaces/`. Orca's listing also reports herdr and plain git checkouts when the user turns external visibility on, and those are not Orca's to hand out.

`"$ORCA_BIN" worktree current --json` answers the other question: which Orca worktree holds the current directory.
