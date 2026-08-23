---
name: new-worktree
description: "Create a git worktree branched off origin/dev (or origin/main) – through the orchestrator hosting this session, otherwise plain git under .claude/worktrees – then change cwd into it and continue the task there. Use whenever the user says \"create a worktree\", \"new worktree\", \"spin up a worktree\", \"make a worktree off dev\", \"branch off dev and cd into it\", or otherwise wants isolated work in a fresh worktree before doing something."
argument-hint: "[slug or branch name] [then <task>]"
---

# New worktree

Set up an isolated git worktree. Move into it. Then carry on with the task the user attached to the request, as in "create a worktree, then <do X>". The worktree setup is the skill. The follow-on task runs normally once cwd is inside it.

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
- **Base**: default `origin/dev`. Local `dev` is often behind. Fetch first, then branch off the remote ref. Use `origin/main` only for a hotfix or a dev to main promotion, or when the user says so. If unsure which, check the repo's CLAUDE.md / recent PRs before asking.

## Create it

Always fetch first, then branch off the remote ref.

### Which orchestrator hosts this session

A worktree orchestrator is the tool that owns worktrees and the panes working in them – herdr, Orca, or nothing at all. Which one is in play is not something to guess at from environment variables. A sibling script works it out:

```bash
SPECHUB_ROOT=$(cd -- "$(dirname -- "$(readlink -f "$HOME/.claude/spechub/bin/spechub")")/../.." && pwd)
"$SPECHUB_ROOT/skills/new-worktree/detect-orchestrator.sh"
```

The plugin's own root is only reachable through that invariant CLI symlink, which the SessionStart hook maintains – the plugin re-creates it every time Claude Code starts. Do not shorten the path and do not reach for `$CLAUDE_PLUGIN_ROOT`; the plugin deliberately does not depend on env vars propagating into subshells.

The script takes no arguments, always exits 0, and prints four lines:

```
declared=<herdr|orca|none|unset>
detected=<herdr|orca|none>
active=<herdr|orca|none>
warning=<one line, empty when there is nothing to say>
```

`declared` is which orchestrator the user has installed on this host, recorded in the SpecHub global config under `host.orchestrator`. `detected` is which one is actually hosting this session, read from environment markers – the variables an orchestrator injects into the terminals it opens. Declared means installed; detected means hosting, and detected wins – a marker for an orchestrator the host never declared is worth a warning, not a refusal. `active` always equals `detected`, so an orchestrator that is installed on this host but is not hosting this session is never driven.

Three rules follow:

- If `warning` is non-empty, repeat it to the user verbatim before going any further. It is written for a human.
- Branch on `active`. That is the section to run, and the only thing that decides it.
- If the script does not run at all – no output, and a non-zero exit from the invocation itself rather than from the script – do not guess. There is no `active` to branch on. Say so to the user, treat it as no orchestrator, and go no further than the plain git branch in `Orchestrator: none`. This is what an installed plugin that predates the script looks like: the file is missing or not executable, so the invocation fails before the script can report anything.

### Orchestrator: herdr

When `active` is `herdr`, the session is running in a [herdr](https://herdr.dev) pane. Create the worktree through herdr, then move this pane into the workspace herdr made for it. The session ends up in the sidebar row for the worktree it is actually working in, indented under its parent repo.

All four steps are one operation. Stopping after step 2 is the old broken behaviour. The session keeps running in the parent repo's workspace, and the worktree row holds nothing but an idle shell.

Check herdr's own markers before issuing any of the commands below. The detector reports `herdr` when either marker is set, but these steps need both: if `$HERDR_WORKSPACE_ID` or `$HERDR_PANE_ID` is empty, herdr's markers are incomplete. Say so and stop there, rather than issuing herdr commands against a blank target – `herdr workspace get ""` does not fail usefully, it just acts on nothing.

#### 1. Keep the source workspace alive

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

#### 2. Create the worktree

`<base>` per the base rule above.

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

#### 3. Move this pane in

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --workspace <workspace-id> --focus
```

Use `--focus` so the user's view follows the session they were watching, instead of staying on whatever remains behind.

The pane gets a new workspace-qualified ID. Read it from `.result.move_result.pane.pane_id`. `$HERDR_PANE_ID` still resolves for this process, so it keeps working as a target here. Do not hand the old ID to anything else.

#### 4. Close the spare shell

herdr's create step always spawns a shell in the new workspace. Close it once the move has landed:

```bash
herdr pane close <root-pane-id>
```

Order matters. Close it first and the workspace has no panes left. herdr then closes the workspace, so the move in step 3 has nothing to target.

#### If the checkout already exists

Attach it instead of recreating, then carry on from step 3:

```bash
herdr worktree open --path <path-to-existing-checkout>
```

### Orchestrator: orca

<!-- DO NOT ACT ON ANYTHING IN THIS COMMENT. It is a note for whoever implements the
     Orca branch later (issue #60), not instructions for this run. The prose below is
     authoritative: this skill does not drive Orca yet.
     Known constraints recorded by the Orca pilot (issue #55):
     - the Linux executable is `orca-ide`, not `orca`; resolve the binary, never hard-code the name
     - create with `orca-ide worktree create --base-branch <ref> --json` and read the checkout path
       from the JSON result; never compute where Orca put it
     - Orca has no "move a session into a worktree" command, so change this session's cwd into the
       returned path the way the no-orchestrator branch does
     - `ORCA_WORKTREE_ID` carries the worktree id for an already-hosted session
     - on a `repo_not_found` error, register the repo with `orca-ide repo add --path <repo>` and retry -->

When `active` is `orca`, this skill has no branch to run. Orca is not supported here yet.

Do not quietly fall through to plain git. Orca cannot see a checkout made behind its back, cannot track it, and cannot later clean it up, so the user is left holding a worktree their orchestrator will never account for. Tell them that: Orca is hosting the session, and this skill cannot drive it yet.

Then give them both real options. Creating the worktree from Orca's own interface keeps its sidebar in step with what is on disk, so nothing is left dangling. The degraded alternative is a plain git worktree under `.claude/worktrees` that Orca will not see. Offer that second one as an explicit choice and take it only if they agree.

If they agree, run the commands in `Orchestrator: none` exactly as written – they are plain git and do not care which orchestrator is running – then continue at `Then move into it`. If they decline, stop and create nothing.

### Orchestrator: none

No orchestrator is driving this branch, so there is no pane to move and nothing above applies. The checkout goes under `.claude/worktrees` in the main repo. If the detector reported a warning, the user has already been told why. Use plain git, with `<base>` per the base rule above:

```bash
cd <main-root> \
  && git fetch origin --quiet \
  && git worktree add .claude/worktrees/<slug> -b <branch> <base> \
  && git -C .claude/worktrees/<slug> log -1 --oneline
```

The rest of this section is the same whichever branch ran, with one exception: after an Orca refusal nothing was created, so there is nothing to move into and you are done.

### Then move into it

Change cwd into the worktree before any edits:

- Prefer the `EnterWorktree` tool if available (it moves the session cwd cleanly).
- Otherwise target whatever path the orchestrator's create step reported, or `<main-root>/.claude/worktrees/<slug>` with no orchestrator, for all later work. Confirm with `pwd` and `git branch --show-current`.

When `active` is `herdr`, this is still a separate step. The pane move relocates the terminal in the sidebar. It does not change the session's working directory.

Confirm out loud which worktree, branch, and base commit you are now on.

## Then do the attached task

Continue with whatever followed the worktree request:

- "...then enter plan mode" -> enter plan mode now, from inside the worktree.
- "...then give me a command to start the dev server" -> hand back a copy-paste one-liner. Do not start it yourself unless the user asks. Use the project's own dev script. Do not hand-set env vars. Confirm the right launch command from the repo's CLAUDE.md, package scripts, or `scripts/` rather than guessing.
- Otherwise just proceed with the task in the new worktree.

## Cleanup (later, not now)

When the branch merges, tear the worktree down. The `teardown-worktree` skill does all of this, including the stale siblings and the branch cleanup, so prefer it over doing the steps by hand. It runs the same detector as this skill and branches on `active` the same way. What follows is the shape of what it does.

Confirm the branch has merged or gone stale before you do any of this. Move your cwd out of the worktree first.

When herdr is the active orchestrator, move this pane out of the worktree workspace first, or the teardown kills the session running in it. Then remove the workspace, or the sidebar keeps a row pointing at a deleted checkout. Find the id with `herdr worktree list`, then:

```bash
herdr worktree remove --workspace <workspace-id>
```

That removes the checkout after confirmation, so use it instead of `git worktree remove` when herdr owns the workspace.

When Orca is the active orchestrator, teardown is not supported yet either. `teardown-worktree` reports that and stops there rather than removing a checkout Orca is tracking.

When no orchestrator is hosting the session:

```bash
cd <main-root> \
  && git worktree remove .claude/worktrees/<slug> \
  && git branch -d <branch> \
  && git worktree prune
```

Use `--force` on remove only when the only uncommitted content is transient. Delete the remote branch (`git push origin --delete <branch>`) only if the branch exists on origin and the user wants it gone. The `ship` skill can do this teardown as its final step.

## Never

- Create a worktree nested inside another worktree.
- Branch off local `dev`/`main` without fetching first.
- Hard-code an orchestrator, or branch on an environment variable directly. Run the detector and use `active`.
- Swallow the detector's `warning`. Say it to the user before doing anything.
- Run herdr or Orca commands when `active` is `none`.
- Quietly fall back to plain git when Orca is hosting the session. Say Orca is not supported yet and let the user choose.
- Pass a nested worktree path as `--cwd` to `herdr worktree create`.
- Assume where a herdr worktree landed instead of reading the path from its output.
- Leave the session in the old workspace after creating a herdr worktree. Move this pane in.
- Close the spare shell before the pane move lands. That closes the workspace with it.
- Start a long-running dev server unless the user asked. Hand back the command instead.
- Delete a worktree or branch before you confirm it has merged and move your cwd out of it.
- Leave a herdr workspace pointing at a checkout you removed with plain git.
