# SpecHub

A Claude Code plugin for spec-driven TDD development.

## Overview

SpecHub enforces a structured workflow where features start as proposals, get designed, broken into tasks, and then implemented through a three-phase TDD pipeline. Living specifications stay in sync with your codebase automatically.

Every rule exists because something went wrong without it. Built over months of actual product development with Claude Code.

## Features

- **Spec-driven development** – Features flow through proposal, design, task breakdown, and implementation phases
- **Three-phase TDD pipeline** – test-writer (writes failing tests) → task-executor (makes them pass) → task-checker (verifies everything)
- **Living specifications** – Cumulative specs that auto-sync with your codebase on every commit
- **Orchestrator pattern** – Claude coordinates specialized agents rather than doing everything itself
- **Quality gates** – Mock skepticism, test baseline enforcement, regression checking, TDD isolation audits
- **Frontend visual verification** – Playwright-based UI verification when a frontend is present

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

This detects your project type, generates `openspec/project.yaml`, and adds an `@import` line to your CLAUDE.md that activates the orchestrator.

## Skills

### Spec Workflow (Full Path)

| Skill | Description |
|-------|-------------|
| `/spechub:propose` | Create a feature proposal with user stories |
| `/spechub:clarify` | Resolve ambiguities in the proposal |
| `/spechub:design` | Generate implementation design |
| `/spechub:tasks` | Generate dependency-ordered task list |
| `/spechub:implement` | Execute tasks via TDD pipeline |
| `/spechub:archive` | Archive change, update living specs |

### Fast Path

| Skill | Description |
|-------|-------------|
| `/spechub:implement-quick` | Quick implementation with deep analysis |
| `/spechub:commit` | Git commit with automatic spec sync |

### Supporting

| Skill | Description |
|-------|-------------|
| `/spechub:init` | Initialize SpecHub in a project |
| `/spechub:bootstrap` | Generate initial living specs from code |
| `/spechub:sync` | Update specs from code changes |
| `/spechub:verify` | Cross-artifact consistency analysis |
| `/spechub:explore` | Thinking partner mode (read-only) |
| `/spechub:test-conventions` | Test placement rules and naming conventions |
| `/spechub:code-review` | Linus Torvalds code philosophy for reviews |

## Agents

| Agent | Role |
|-------|------|
| `test-writer` | TDD Phase 1 – writes failing tests from requirements only |
| `task-executor` | TDD Phase 2 – makes tests pass, cannot modify tests |
| `task-checker` | TDD Phase 3 – verifies everything (mock audit, regression, visual) |

## Language Profiles

- **python** – pytest, ruff, mypy
- **node-typescript** – npm test, eslint, tsc
- **fullstack-python** – Python backend + Node/TS frontend

## Design Principles

- **TDD is structural, not aspirational.** Test-writer can't see the implementation plan. Executor can't touch test files. Tests stay independent of the code they verify.
- **Specs converge toward reality.** Every commit updates the living specs. Agents fix inaccuracies on sight. Specs track what is implemented, never what's planned.
- **Planning outweighs coding.** Three parallel explorers run before any code is written. Mock audits, mutation checks, regression suites, integration wiring. Most bugs came from not understanding existing code, not from writing bad new code.
- **Strict defaults, easy to relax.** Set `orchestrator.strict: false` in `openspec/project.yaml` to allow direct code work for smaller projects.

## License

MIT. See [LICENSE](LICENSE).

## Credits

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** – SpecHub's CLI is forked from OpenSpec, which was the core spec engine that the workflow was originally built on. The spec-driven development concepts – proposals, designs, tasks, living specs, change management, archiving – all originate from OpenSpec.
- **[Taskmaster AI](https://github.com/eyaltoledano/claude-task-master)** – The orchestrator pattern and agent coordination approach were inspired by Taskmaster's task management model.
- Additional inspiration from [Superpowers](https://github.com/obra/superpowers), [GSD](https://github.com/gsd-build/get-shit-done), and [Spec Kit](https://github.com/github/spec-kit).
