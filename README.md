# SpecHub

A Claude Code plugin for spec-driven TDD development.

## Overview

SpecHub provides right-sized workflows for any task – from a one-line fix to a fully planned initiative. Living specifications stay in sync with your codebase automatically via commit-time spec sync.

Every rule exists because something went wrong without it. Built over months of actual product development with Claude Code.

## Workflows

Two paths. The orchestrator picks based on complexity, or you can steer it.

**Quick** – small, clear-scope changes (bug fixes, typos, config tweaks):

```
/spechub:implement-quick
```

**Full pipeline** – features, refactors, and larger work:

```
/spechub:propose → /spechub:design → /spechub:tasks → /spechub:implement → /spechub:archive
```

Two optional adjustments:
- Add `/spechub:clarify` between propose and design when requirements are ambiguous
- Skip `/spechub:design` for simple features – `/spechub:tasks` can run right after propose

The full pipeline always ends with the TDD pipeline (test-writer → task-executor → task-checker) and `/spechub:archive` to update living specs. Frontend-verifier also runs when `frontend` is configured in `project.yaml`.

## Features

- **Right-sized workflows** – Quick path for small changes, full pipeline for features and larger work
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

SpecHub ships a Node.js CLI for change management (`spechub new change`, `spechub status`, `spechub list`, `spechub archive`).

On session start, the plugin symlinks the CLI to `~/.local/bin/spechub`. If that directory is on your `PATH`, run `spechub --help` to get started – the symlink refreshes automatically on plugin upgrades. If `~/.local/bin` isn't on your `PATH`, the hook prints a one-line reminder so you can add it.

If `spechub` doesn't run after install, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). It's written so a Claude Code session can read it and apply the fix directly.

## Upgrading

Upgrading from a version before 0.8.0? See [docs/migrate-0.8.md](docs/migrate-0.8.md) for how to remove the stale `@import` line from your project CLAUDE.md.

## Skills

### Implementation

| Skill | Description |
|-------|-------------|
| `/spechub:implement-quick` | Quick path for small, clear-scope changes – 3-explorer analysis then implement |
| `/spechub:implement` | Execute tasks from an active change via the TDD pipeline |

For larger work, chain the planning skills below first, then run `/spechub:implement`.

### Planning

| Skill | Description |
|-------|-------------|
| `/spechub:propose` | Create a feature proposal with user stories |
| `/spechub:clarify` | Resolve ambiguities in the proposal |
| `/spechub:design` | Generate implementation design |
| `/spechub:tasks` | Generate dependency-ordered task list |

### Operations

| Skill | Description |
|-------|-------------|
| `/spechub:commit` | Git commit with mandatory spec sync |
| `/spechub:archive` | Archive completed change, update living specs |
| `/spechub:config` | View/modify workflow settings |
| `/spechub:sync` | Update specs from code changes |

### Setup and Supporting

| Skill | Description |
|-------|-------------|
| `/spechub:init` | Initialize SpecHub in a project |
| `/spechub:bootstrap` | Generate initial living specs from code |
| `/spechub:verify` | Cross-artifact consistency analysis |
| `/spechub:explore` | Thinking partner mode (read-only) |
| `/spechub:quick-fix` | Structured bug fix workflow with root cause analysis |
| `/spechub:pre-commit-review` | Deep quality review of all changes since last commit |
| `/spechub:test-conventions` | Test placement rules and naming conventions |
| `/spechub:code-review` | Linus Torvalds code philosophy for reviews |
| `/spechub:browser-verify` | agent-browser command reference, CDP troubleshooting, and selector strategy |

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
- **Right-sized workflow.** A typo fix doesn't need a proposal. A new payment system does. The orchestrator picks the right path automatically.
- **Planning outweighs coding.** Three parallel explorers run before any code is written. Mock audits, mutation checks, regression suites, integration wiring.
- **Strict defaults, easy to relax.** Use `/spechub:config` to adjust TDD strictness, orchestrator mode, or default tier.

## License

[MIT](LICENSE)

## Credits

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** – SpecHub's CLI is forked from OpenSpec, which was the core spec engine that the workflow was originally built on. The spec-driven development concepts – proposals, designs, tasks, living specs, change management, archiving – all originate from OpenSpec.
- **[Taskmaster AI](https://github.com/eyaltoledano/claude-task-master)** – The orchestrator pattern and agent coordination approach were inspired by Taskmaster's task management model.
- Additional inspiration from [Superpowers](https://github.com/obra/superpowers), [GSD](https://github.com/gsd-build/get-shit-done), and [Spec Kit](https://github.com/github/spec-kit).
