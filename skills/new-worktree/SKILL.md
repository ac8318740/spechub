---
name: new-worktree
description: "Create a git worktree branched off origin/dev (or origin/main) – through the orchestrator hosting this session, otherwise plain git under .claude/worktrees – then change cwd into it and continue the task there. Use whenever the user says \"create a worktree\", \"new worktree\", \"spin up a worktree\", \"make a worktree off dev\", \"branch off dev and cd into it\", or otherwise wants isolated work in a fresh worktree before doing something."
argument-hint: "[slug or branch name] [then <task>]"
---

# New worktree

Set up an isolated git worktree. Move into it. Then carry on with the task the user attached to the request, as in "create a worktree, then <do X>".

The worktree setup is the skill. The follow-on task runs normally once cwd is inside it.

## When to use

Trigger on "create a worktree", "new worktree", "spin up a worktree", "make me a worktree off dev", "branch off dev and cd there". The request usually has a tail ("...then plan X", "...then fix Y", "...then give me a dev-server command") which you complete after setup.

## Before creating anything

- Confirm the task actually needs a worktree. If the cwd is already in a worktree, or uncommitted changes belong to this task, ask before branching. Do not silently start a second one.
- Resolve the MAIN repo root, never a nested worktree path. From anywhere in the repo:
    - `dirname "$(git rev-parse --git-common-dir)"` gives the main repo root.
    - Never create a worktree inside another worktree. Nested worktree paths have caused real breakage.

## Pick the inputs

- **Slug**: short kebab-case name for the directory, derived from the task (e.g. `roadmap-gantt`, `feedback-inbox`). If the user named it, use that.
- **Branch**: `<type>/<slug>` where type is `feat`, `fix`, `chore`, or `docs` to match the work. A bare slug is acceptable if the user gives one. Confirm with the user only if the type is genuinely ambiguous.
- **Base**: default `origin/dev`. Local `dev` is often behind. Fetch first, then branch off the remote ref.

    Use `origin/main` for a hotfix, a dev to main promotion, when the user says so, or when the repo has no `origin/dev`. Branch off whichever integration branch the repo actually has. If unsure which, check the repo's CLAUDE.md / recent PRs before asking.

## Create it

Always fetch first, then branch off the remote ref.

### Which orchestrator hosts this session

A worktree orchestrator is the tool that owns worktrees and the panes working in them – herdr, Orca, or nothing at all. Which one is in play is not something to guess at from environment variables. A sibling script works it out:

```bash
SPECHUB_ROOT=$(cd -- "$(dirname -- "$(readlink -f "$HOME/.claude/spechub/bin/spechub")")/../.." && pwd)
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh"
```

That invariant CLI symlink is the only way to reach the plugin's own root. The SessionStart hook maintains it, and re-creates it every time Claude Code starts. Do not shorten the path and do not reach for `$CLAUDE_PLUGIN_ROOT`; the plugin deliberately does not depend on env vars propagating into subshells.

The script always exits 0 and prints six lines:

```
declared_herdr=<true|false|unset>
declared_orca=<true|false|unset>
detected=<herdr|orca|none>
active=<herdr|orca|none>
owner=<herdr|orca|none>
warning=<one line, empty when there is nothing to say>
```

The script takes one optional argument: the checkout to examine. A checkout is one git worktree directory. The script examines the current directory when you pass nothing.

- `declared_herdr` – whether the user has herdr installed on this host, recorded in the SpecHub global config under `host.orchestrators.herdr`. `unset` means nobody has declared herdr on this host yet.
- `declared_orca` – the same yes-or-no answer for Orca, recorded under `host.orchestrators.orca`. The two are independent: a host can have both installed, one, or neither, so one answer says nothing about the other. Both `false` is how a host says it has no orchestrator at all.
- `detected` – which orchestrator is actually hosting this session, read from the environment markers an orchestrator injects into the terminals it opens.
- `active` – the branch to run.
- `owner` – which orchestrator owns the checkout the script examined. The path settles it.

    A checkout under `~/orca/workspaces/` belongs to Orca. A checkout under herdr's worktree root belongs to herdr, and herdr's config names that root. Anything else is plain git, reported as `none`.

- `warning` – one line written for a human, empty when there is nothing to say.

Declared means installed. Detected means hosting.

Detected wins, so `active` always equals `detected`. So this skill never drives an orchestrator that the host declared but that does not host this session. A marker for an orchestrator the host never declared earns a warning, not a refusal.

Owning is not hosting. The session's host creates a worktree, so this skill branches on `active`. The owner decides who removes a checkout later, and the `teardown-worktree` skill acts on that.

Three rules follow:

- If `warning` is non-empty, repeat it to the user verbatim before going any further. It addresses a human reader.
- Branch on `active`. That is the section to run, and the only thing that decides it.
- Sometimes the script does not run at all – no output, and a non-zero exit from the invocation rather than from the script. Do not guess. There is no `active` to branch on.

    Say so to the user, treat it as no orchestrator, and go no further than the plain git branch in `Orchestrator: none`. An installed plugin that predates the script looks like this. The file is missing or not executable, so the invocation fails before the script can report anything.

### Orchestrator: herdr

When `active` is `herdr`, read `herdr.md` and run all of it. It creates the worktree through herdr and moves this pane into it.

### Orchestrator: orca

When `active` is `orca`, read `orca.md` and run all of it. It creates the worktree through Orca and moves this session into it.

### Orchestrator: none

No orchestrator is driving this branch, so there is no pane to move and nothing above applies. The checkout goes under `.claude/worktrees` in the main repo. If the detector reported a warning, you already told the user why.

Use plain git, with `<base>` per the base rule above:

```bash
cd <main-root> \
  && git fetch origin --quiet \
  && git worktree add .claude/worktrees/<slug> -b <branch> <base> \
  && git -C .claude/worktrees/<slug> log -1 --oneline
```

The rest of this section is the same whichever branch ran. One exception: when Orca fails and you stop, Orca created nothing. There is nothing to move into, so stop here.

### Then move into it

Change cwd into the worktree before any edits:

- Prefer the `EnterWorktree` tool if available (it moves the session cwd cleanly).
- Otherwise target whatever path the orchestrator's create step reported, or `<main-root>/.claude/worktrees/<slug>` with no orchestrator, for all later work. Confirm with `pwd` and `git branch --show-current`.

When `active` is `herdr`, this is still a separate step. The pane move relocates the terminal in the sidebar. It does not change the session's working directory.

Confirm out loud which worktree, branch, and base commit you are now on.

## Then do the attached task

Continue with whatever followed the worktree request:

- "...then enter plan mode" -> enter plan mode now, from inside the worktree.
- "...then give me a command to start the dev server" -> hand back a copy-paste one-liner. Do not start it yourself unless the user asks.

    Use the project's own dev script. Do not hand-set env vars. Confirm the right launch command from the repo's CLAUDE.md, package scripts, or `scripts/` rather than guessing.

- Otherwise just proceed with the task in the new worktree.

## Cleanup (later, not now)

When the branch merges, tear the worktree down. Run the `teardown-worktree` skill. Do not do the steps by hand, and do not repeat them here.

That skill moves this session out, removes the checkout, and deletes the merged local and remote branches. It picks up stale siblings in the same run. It runs the same detector as this skill, so both agree on the same host.

Removal branches on the checkout's `owner`, not on `active`. The session's host creates a worktree, and the checkout's owner removes it. `teardown-worktree` owns that rule and the reasons behind it.

Confirm the branch has merged or gone stale before the teardown starts. The `ship` skill can run the teardown as its final step.

## Never

- Create a worktree nested inside another worktree.
- Branch off local `dev`/`main` without fetching first.
- Hard-code an orchestrator, or branch on an environment variable directly. Run the detector and use `active`.
- Swallow the detector's `warning`. Say it to the user before doing anything.
- Run herdr or Orca commands when `active` is `none`.
- Quietly fall back to plain git when an Orca command fails. Show the command and the error, then stop.
- Pass a nested worktree path as `--cwd` to `herdr worktree create`, or as `--repo` to `orca worktree create`.
- Assume where a herdr worktree landed instead of reading the path from its output.
- Assume what Orca named the branch. Orca derives it, so read it from the create output.
- Leave the session in the old workspace after creating a herdr worktree. Move this pane in.
- Close the spare shell before the pane move lands. That closes the workspace with it.
- Leave the shell Orca spawned running after you move in. Teardown then refuses to remove that checkout.
- Start a long-running dev server unless the user asked. Hand back the command instead.
- Delete a worktree or branch before you confirm it has merged and move your cwd out of it.
- Leave a herdr workspace pointing at a checkout you removed with plain git.
