# Two orchestrators coexist on one host, and a checkout's path names its owner

An orchestrator is a tool that hosts agent terminal panes and git worktrees. Both herdr and Orca are orchestrators, and one host – a single developer machine – may run both at once. The host config declares each one as installed or not, at `host.orchestrators.herdr` and `host.orchestrators.orca`. A developer with both installed should not have to pick one, and the session environment already says which tool hosts a session.

A session lives in the host that launched it and never moves. To continue work from the other host, open a new Claude session in the same checkout – one git worktree directory – from that host. SpecHub's `/spechub:handoff` stays what it is, a handoff of a full context window.

A checkout's path root names its owner. Orca owns `~/orca/workspaces/<repo>/`. Everything under herdr's worktree root, `~/.herdr/worktrees/<repo>/` by default, is herdr's. Any other path belongs to plain git. The session's host creates a checkout, and the owner removes it. The worktree skills check `orca worktree ps --json` and `herdr worktree list` before every removal, because neither tool sees the other's sessions.

Orca lists herdr checkouts, and the paired phone lists them, once the repo's "show in worktree list" switch is on in the desktop app. No CLI sets it, so `/spechub:host` tells the user to.

## Considered options

- One declared orchestrator per host, the earlier `host.orchestrator` enum. Rejected: it forces a choice the developer does not want to make.
- A feature that moves a running session to the other host. Rejected: neither tool offers one, and a new session in the same checkout reaches the same place.
- Either tool removes any checkout. Rejected on pilot evidence from 2026-08-23: Orca's `rm` refuses a path outside its own root, and herdr's `remove` deletes any directory and keeps the branch.

## Consequences

The `teardown-worktree` skill picks the removal command from the checkout's path root, not from the session's host. It deletes the branch itself for a herdr checkout. The `new-worktree` skill never passes a path that crosses roots. A config that still sets the old `host.orchestrator` key fails `config check`, and `/spechub:host` re-declares both booleans.
