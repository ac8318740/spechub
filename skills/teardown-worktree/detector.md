# Teardown worktree: the detector

What `detect-orchestrator.sh` prints, and what to do when it does not run.

## Why the path goes through the CLI symlink

The path goes through `~/.claude/spechub/bin/spechub`, the invariant symlink the SessionStart hook maintains. The plugin re-creates that symlink every time Claude Code starts. It is the only reliable way to find the plugin's own root.

Do not invent a shorter path, and do not reach for `$CLAUDE_PLUGIN_ROOT` – the plugin deliberately does not depend on that variable reaching a fresh subshell.

## The six lines

The script always exits 0 and prints exactly six lines:

- `declared_herdr` – whether the user has herdr installed on this host, recorded in the SpecHub global config under `host.orchestrators.herdr`. One of `true`, `false`, `unset`.
- `declared_orca` – the same yes-or-no answer for Orca, recorded under `host.orchestrators.orca`. One of `true`, `false`, `unset`. The two are independent: a host can have both installed, one, or neither, so one answer says nothing about the other.
- `detected` – which orchestrator is actually hosting this session, read from the environment markers an orchestrator injects into the terminals it opens. One of `herdr`, `orca`, `none`.
- `active` – the branch to run for this session. One of `herdr`, `orca`, `none`.
- `owner` – which orchestrator owns the checkout the script examined. One of `herdr`, `orca`, `none`.

    The path settles it: a checkout under `~/orca/workspaces/` belongs to Orca, and a checkout under herdr's worktree root belongs to herdr. herdr's config names that root. Anything else is plain git.

- `warning` – one line written for a human, empty when there is nothing to say.

Declared means installed. Detected means hosting.

Detected wins, so `active` always equals `detected`. This session cannot drive an installed orchestrator that does not host it.

A marker for an orchestrator the host never declared earns a warning, not a refusal.

## When the script does not run

The script sometimes does not run at all: no output, and a non-zero exit from the invocation itself. Then there is no `active` and no `owner` to read.

Do not guess either one. Say so to the user. Then treat every worktree as plain git, the branch that touches nothing an orchestrator holds.

A missing or non-executable script looks like this, and a plugin older than the script is the usual cause.

This is the same detector `new-worktree` runs, so both skills always give the same answer on the same host.
