# Working on SpecHub

This is the SpecHub plugin's own repository. If you are here, you are
**developing the plugin**, not using it.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It covers the plugin layout, the
CLI build discipline, the release process, and the writing standards.

## What is where

| Path | What it is |
|---|---|
| `orchestrator/AGENTS.md` | What SpecHub tells an agent **using** the plugin – shipped to users, not guidance for you |
| `skills/`, `agents/` | Skills and subagent definitions the plugin ships |
| `cli/` | The `spechub` CLI. `dist/` is committed – see CONTRIBUTING |
| `hooks/` | SessionStart wiring: CLI symlinks and orchestrator injection |
| `docs/`, `assets/` | Documentation and installable helper scripts |

`orchestrator/AGENTS.md` deliberately does not live at the repo root. It tells
an agent it is a coordinator that must never read a codebase directly. That is
the opposite of what you need while working on this repo. Claude Code and Codex
both auto-load a root-level `AGENTS.md`. Keeping that file out of the root
stops both of them from applying it to the wrong job.
