---
name: new-worktree
description: "Create a git worktree branched off origin/dev (or origin/main) – through herdr when running inside a herdr pane, otherwise plain git under .claude/worktrees – then change cwd into it and continue the task there. Use whenever the user says \"create a worktree\", \"new worktree\", \"spin up a worktree\", \"make a worktree off dev\", \"branch off dev and cd into it\", or otherwise wants isolated work in a fresh worktree before doing something."
argument-hint: "[slug or branch name] [then <task>]"
---

# New Worktree

Set up an isolated git worktree, move into it, then carry on with whatever the user attached to the request ("create a worktree, then <do X>"). The worktree setup is the skill; the follow-on task runs normally once cwd is inside it.

## When to use

Trigger on "create a worktree", "new worktree", "spin up a worktree", "make me a worktree off dev", "branch off dev and cd there". The request usually has a tail ("...then plan X", "...then fix Y", "...then give me a dev-server command") which you complete after setup.

## Before creating anything

- Confirm a worktree is actually warranted. If the cwd is already in a worktree, or there are uncommitted changes that belong to this task, ask before branching. Do not silently start a second one.
- Resolve the MAIN repo root, never a nested worktree path. From anywhere in the repo:
  - `dirname "$(git rev-parse --git-common-dir)"` gives the main checkout root.
  - Never create a worktree inside another worktree. Nested worktree paths have caused real breakage.

## Pick the inputs

- **Slug**: short kebab-case name for the directory, derived from the task (e.g. `roadmap-gantt`, `feedback-inbox`). If the user named it, use that.
- **Branch**: `<type>/<slug>` where type is `feat`, `fix`, `chore`, or `docs` to match the work. A bare slug is acceptable if the user gives one. Confirm with the user only if the type is genuinely ambiguous.
- **Base**: default `origin/dev`. Local `dev` is often behind, so always fetch and branch off the remote ref. Use `origin/main` only for a hotfix or a dev to main promotion, or when the user says so. If unsure which, check the repo's CLAUDE.md / recent PRs before asking.

## Create it

Always fetch first, then branch off the remote ref.

### Inside herdr

If `$HERDR_ENV` is set, the session is running in a [herdr](https://herdr.dev) pane. Use herdr's own command – it creates the branch, the checkout, and a herdr workspace in one step, so the worktree appears in the sidebar instead of being invisible:

```bash
cd <main-root> \
  && git fetch origin --quiet \
  && herdr worktree create \
       --cwd "$(pwd)" \
       --branch <branch> \
       --base origin/dev \
       --label <slug> \
       --no-focus
```

`--cwd` must be the MAIN repo root. herdr records it as the workspace's `repo_root`, and the sidebar groups worktree workspaces as indented children under that repo. Pass a nested worktree path and the new workspace groups under the wrong parent.

Do not pass `--path`. herdr places the checkout under its configured root (`worktrees.directory`, default `~/.herdr/worktrees`, giving `<root>/<repo>/<branch-slug>`). Letting the config decide keeps worktrees agent-neutral: the same layout whether Claude, Codex, or another CLI agent works in them.

The command prints JSON. Read the real path from `result.worktree.path` rather than assuming it, then `git -C <that-path> log -1 --oneline` to confirm the base commit. Never hardcode the location: a relative `worktrees.directory` resolves against the herdr session's base directory, not the repo you passed to `--cwd`, so the path is only knowable from the output.

Use `--no-focus` so the user is not yanked out of the pane they are working in. Tell them it is in the sidebar under its parent repo.

If the checkout already exists but herdr is not showing it, attach it instead of recreating:

```bash
herdr worktree open --path <path-to-existing-checkout>
```

### Outside herdr

Plain git:

```bash
cd <main-root> \
  && git fetch origin --quiet \
  && git worktree add .claude/worktrees/<slug> -b <branch> origin/dev \
  && git -C .claude/worktrees/<slug> log -1 --oneline
```

### Then move into it

Change cwd into the worktree before any edits:

- Prefer the `EnterWorktree` tool if available (it moves the session cwd cleanly).
- Otherwise target the path the create step reported (herdr) or `<main-root>/.claude/worktrees/<slug>` (plain git) for all subsequent work, and confirm with `pwd` + `git branch --show-current`.

Creating the herdr workspace does not move this session. The new pane is a shell for the user; this session still has to move its own cwd.

Confirm out loud which worktree, branch, and base commit you are now on.

## Then do the attached task

Continue with whatever followed the worktree request:

- "...then enter plan mode" -> enter plan mode now, from inside the worktree.
- "...then give me a command to start the dev server" -> hand back a copy-paste one-liner; do not start it yourself unless asked. Use the project's own dev script and do not hand-set env vars. Confirm the right launch command from the repo's CLAUDE.md, package scripts, or `scripts/` rather than guessing.
- Otherwise just proceed with the task in the new worktree.

## Cleanup (later, not now)

When the work is merged, the worktree gets torn down. Do this only after confirming the branch is merged/stale, and move your cwd out of the worktree first.

Inside herdr, remove the workspace too, or the sidebar keeps a row pointing at a deleted checkout. Find the id with `herdr worktree list`, then:

```bash
herdr worktree remove --workspace <workspace-id>
```

That removes the checkout after confirmation, so use it instead of `git worktree remove` when herdr owns the workspace.

Outside herdr:

```bash
cd <main-root> \
  && git worktree remove .claude/worktrees/<slug> \
  && git branch -d <branch> \
  && git worktree prune
```

Use `--force` on remove only when the only uncommitted content is transient. Delete the remote branch (`git push origin --delete <branch>`) only if it was pushed and the user wants it gone. The `ship` skill can do this teardown as its final step.

## Never

- Create a worktree nested inside another worktree.
- Branch off local `dev`/`main` without fetching first.
- Pass a nested worktree path as `--cwd` to `herdr worktree create`.
- Assume where a herdr worktree landed instead of reading the path from its output.
- Start a long-running dev server unless the user asked; hand back the command instead.
- Delete a worktree or branch without first confirming it is merged and moving cwd out of it.
- Leave a herdr workspace pointing at a checkout you removed with plain git.
