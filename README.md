# SpecHub

A Claude Code plugin for spec-driven TDD development.

## Overview

SpecHub grows planning structure only as far as the fog demands. Fog is the part of the work you cannot state precisely yet – the open questions, the undecided shape. Little fog means little structure, so the same entry point serves a one-question change and a fifty-question effort. Living specifications stay in sync with your codebase automatically via commit-time spec sync.

Every rule exists because something went wrong without it. Built over months of actual product development with Claude Code.

## Workflows

No path selection. Planning structure grows only as far as the fog demands:

- **The way is clear** – `/spechub:implement` runs the TDD pipeline (test-writer → task-executor → task-checker, plus frontend-verifier when `frontend` is configured in `project.yaml`) on the request directly. A small unit of work is simply small.
- **Something is broken** – `/spechub:quick-fix` forces root-cause analysis before any edit.
- **Decisions need settling** – `/spechub:map` charts a map if none exists and works the frontier if one does. A single question is settled in conversation – SpecHub calls that interviewing technique grilling – and leaves an architecture decision record (ADR): a short note saying what was decided and why. A long effort becomes a map instead, worked across sessions.

A map is a set of small records called nodes. Each node is one question to settle or one piece of work to do. Every node has one of five statuses: `fog` – cannot be stated precisely yet; `open` – ready to settle; `claimed` – being worked; `resolved` – settled; `out-of-scope` – deliberately dropped. Every node also names its provenance parent – the node whose answer raised this one – and its blocking edges – the nodes that must resolve before this one can start. A node's mode says who settles it: `hitl` for a human, `afk` for an agent working alone.

The frontier is the answer to "what can be worked right now": the open nodes with nothing unresolved blocking them. Nodes are kept by a tracker, the swappable storage layer behind a map (GitHub issues first-class, plain files as the fallback). The packaging walk collects a map into one brief, so a fresh session can pick up an effort without re-reading everything.

For the full picture – each step and how they connect – read [docs/workflows.md](docs/workflows.md).

## Features

- **Progressive materialisation** – structure appears only when it has to persist; a map is created only when the fog will outlive the session
- **Commit-time spec sync** – Living specs auto-update on every commit
- **Four-phase TDD pipeline** – test-writer → task-executor → task-checker → frontend-verifier
- **Orchestrator pattern** – Claude coordinates specialized agents rather than doing everything itself
- **Quality gates** – Mock skepticism, test baseline enforcement, regression checking, TDD isolation audits
- **Frontend visual verification** – Browser-based UI verification via agent-browser CLI
- **Project configuration** – Per-project workflow settings via `spechub/project.yaml`

## Prerequisites

- [Claude Code](https://claude.com/claude-code) CLI
- Node.js >= 20 (for the SpecHub CLI)

## Installation

```
/plugin marketplace add ac8318740/ac8318740-plugins
/plugin install spechub@ac8318740-plugins
```

Then in your project:

```
/spechub:init
```

This detects your project type and generates `spechub/project.yaml` with workflow settings. SpecHub's orchestrator instructions are loaded automatically at session start whenever a spechub project is detected – your CLAUDE.md stays clean for project-specific content.

## CLI

SpecHub ships a Node.js CLI (`spechub init`, `spechub list`, `spechub node ...`, `spechub archive`).

A tracker has to provide four operations and nothing more: create, read, update, list. GitHub issues are the first-class tracker, because they already have the two links a map needs: sub-issues carry the provenance parent, and issue dependencies carry the blocking edges. The CLI also ships a files tracker as the fallback (`spechub node create | read | update | list`), which writes one markdown file per node under `spechub/maps/<name>/`.

Everything else is built on those four operations. `spechub node frontier` lists the nodes ready to work – open, nothing unresolved blocking them, closest to the root node first. `spechub node walk` packages the map for a handoff: it reads the nodes in provenance order and includes the root node in full, plus any node marked pinned – flagged as always worth carrying along. Claiming and resolving a node are just `update` calls, made by the skills.

The plugin's skills and agents invoke the CLI through an invariant absolute path – `~/.claude/spechub/bin/spechub` – that the SessionStart hook maintains. This means agents don't depend on your shell `PATH` and the CLI keeps working across plugin version bumps, non-interactive subshells, and fresh agent contexts.

For typing `spechub` at a terminal yourself, the hook also creates `~/.local/bin/spechub`. Add `~/.local/bin` to your `PATH` to use it; the hook prints a one-line reminder if it isn't already there. This second symlink is a convenience only – nothing in the plugin breaks if you don't set up `PATH`.

If `spechub` doesn't run after install, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). It's written so a Claude Code session can read it and apply the fix directly.

## Upgrading

Upgrading from a version before 0.8.0? See [docs/migrate-0.8.md](docs/migrate-0.8.md) for how to remove the stale `@import` line from your project CLAUDE.md.

## Skills

### Implementation

| Skill | Description |
|-------|-------------|
| `/spechub:implement` | Claim agent-workable (afk) nodes from the map frontier and run the TDD pipeline – runs directly on the request when no map exists |

For work with open decisions, chart it with `/spechub:map` first.

### Planning

| Skill | Description |
|-------|-------------|
| `/spechub:map` | Entry point for planned work – charts a map if none exists, works the frontier if one does |
| `grilling` | Interview technique – asks the whole frontier per round, each question with a recommended answer (model-invoked) |
| `record-context` | Writes durable records when a decision lands – an ADR, a glossary term, both, or neither (model-invoked) |

### Operations

| Skill | Description |
|-------|-------------|
| `/spechub:commit` | Git commit with mandatory spec sync |
| `/spechub:archive` | Close out a cleared map – check the residue landed (the durable output: spec updates, decision records, glossary entries), then dispose of the nodes |
| `/spechub:config` | View/modify workflow settings |
| `/spechub:sync` | Update specs from code changes |
| `/spechub:handoff` | Hand work to a fresh agent session, or anchor it to survive compaction |

### Setup and Supporting

| Skill | Description |
|-------|-------------|
| `/spechub:init` | Initialize SpecHub in a project |
| `/spechub:bootstrap` | Generate initial living specs from code |
| `/spechub:explore` | Thinking partner mode (read-only) |
| `/spechub:quick-fix` | Structured bug fix workflow with root cause analysis |
| `/spechub:pre-commit-review` | Deep quality review of all changes since last commit |
| `/spechub:test-conventions` | Test placement rules and naming conventions |
| `/spechub:code-review` | Linus Torvalds code philosophy for reviews |
| `/spechub:browser-verify` | agent-browser command reference, CDP troubleshooting, and selector strategy |
| `/spechub:bridge` | Set up and operate the Playwriter cross-device browser bridge |
| `/spechub:visual-docs` | Write docs that lead with a diagram and derive structure from it (Minto pyramid) |
| `/spechub:new-worktree` | Create a git worktree off the remote base branch and continue the task inside it |
| `/spechub:teardown-worktree` | Retire finished worktrees and delete their merged local and remote branches |

## Agents

| Agent | Role |
|-------|------|
| `test-writer` | TDD Phase 1 – writes failing tests from requirements only |
| `task-executor` | TDD Phase 2 – makes tests pass, cannot modify tests |
| `task-checker` | TDD Phase 3 – verifies everything (mock audit, regression, TDD isolation) |
| `frontend-verifier` | TDD Phase 4 – real browser verification via agent-browser CLI (when frontend configured) |

## Language Profiles

- **python** – pytest, ruff, mypy
- **node-typescript** – npm test, eslint, tsc
- **fullstack-python** – Python backend + Node/TS frontend

## Design Principles

- **TDD is structural, not aspirational.** Test-writer can't see the implementation plan. Executor can't touch test files. Tests stay independent of the code they verify.
- **Specs converge toward reality.** Every commit updates the living specs via spec sync. Agents fix inaccuracies on sight. Specs track what is implemented, never what's planned.
- **Progressive materialisation.** Structure appears only when it has to persist. A typo fix needs no machinery. A long effort earns a map. The same entry point serves both, and nothing declares which.
- **Planning outweighs coding.** Three parallel explorers run before any code is written. Mock audits, mutation checks, regression suites, integration wiring.
- **Strict defaults, easy to relax.** Use `/spechub:config` to adjust TDD strictness, orchestrator mode, or how grilling presents questions.

## License

[MIT](LICENSE)

## Credits

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** – SpecHub's CLI is forked from OpenSpec, which was the core spec engine that the workflow was originally built on. The spec-driven development concepts – proposals, designs, tasks, living specs, change management, archiving – all originate from OpenSpec.
- **[Taskmaster AI](https://github.com/eyaltoledano/claude-task-master)** – The orchestrator pattern and agent coordination approach were inspired by Taskmaster's task management model.
- **[Skills for Real Engineers](https://github.com/mattpocock/skills)** by Matt Pocock – the Wayfinder map, the grilling technique, and the durability rule for agent briefs. SpecHub's node graph is a direct adaptation of Wayfinder. MIT licensed; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
- Additional inspiration from [Superpowers](https://github.com/obra/superpowers), [GSD](https://github.com/gsd-build/get-shit-done), and [Spec Kit](https://github.com/github/spec-kit).
