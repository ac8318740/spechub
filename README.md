# SpecHub

A Claude Code plugin for spec-driven TDD development with modular workflow tiers.

## Overview

SpecHub provides right-sized workflows for any task – from a one-line fix to a fully planned initiative. Living specifications stay in sync with your codebase automatically via commit-time spec sync.

Every rule exists because something went wrong without it. Built over months of actual product development with Claude Code.

## Workflow Tiers

Four tiers, each including everything from the tiers below it. The orchestrator auto-selects the right tier based on complexity, or you can force one explicitly.

```
┌──────────────────────────────────────────────────────────────────┐
│                       WORKFLOW TIERS                             │
├───────────┬────────────┬──────────────┬──────────────────────────┤
│  PATCH    │  FEATURE   │  PROJECT     │  INITIATIVE              │
│           │            │              │                          │
│  Just     │  Tasks +   │  Design +    │  Proposal + Design +     │
│  do it    │  TDD       │  Tasks +     │  Tasks + TDD + Archive   │
│           │  pipeline  │  TDD         │                          │
├───────────┼────────────┼──────────────┼──────────────────────────┤
│ Planning  │  none      │  tasks.md    │  design.md               │ proposal.md
│ artifacts │            │              │  tasks.md                │ design.md
│           │            │              │                          │ tasks.md
├───────────┼────────────┼──────────────┼──────────────────────────┤
│ TDD       │  ✗         │  ✓           │  ✓                       │ ✓
│ pipeline  │            │  test→exec   │  test→exec→check         │ test→exec→check
│           │            │  →check      │  →verify                 │ →verify
├───────────┼────────────┼──────────────┼──────────────────────────┤
│ Spec      │  at commit │  at commit   │  at commit               │ at archive
│ sync      │            │              │                          │ + at commit
├───────────┼────────────┼──────────────┼──────────────────────────┤
│ Invoke    │  (auto)    │  /feature    │  /project                │ /initiative
│           │  or /patch │              │                          │
├───────────┼────────────┼──────────────┼──────────────────────────┤
│ Example   │ "fix typo" │ "add login   │ "refactor auth to       │ "build payments
│ use case  │ "change    │  button"     │  use JWT"               │  system from
│           │  color"    │ "new API     │ "add search with        │  scratch"
│           │            │  endpoint"   │  filters"               │
└───────────┴────────────┴──────────────┴──────────────────────────┘
```

## Features

- **Modular workflow tiers** – Right-sized process for every task, from patch to initiative
- **Commit-time spec sync** – Living specs auto-update on every commit, regardless of tier
- **Four-phase TDD pipeline** – test-writer → task-executor → task-checker → frontend-verifier
- **Orchestrator pattern** – Claude coordinates specialized agents rather than doing everything itself
- **Quality gates** – Mock skepticism, test baseline enforcement, regression checking, TDD isolation audits
- **Frontend visual verification** – Playwright-based UI verification when a frontend is present
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

This detects your project type, generates `spechub/project.yaml` with workflow settings, and adds an `@import` line to your CLAUDE.md that activates the orchestrator.

## Skills

### Tier Entry Points

| Command | Tier | Description |
|---------|------|-------------|
| `/patch` or simple request | PATCH | Just do it – spec sync at commit |
| `/feature` | FEATURE | Tasks + TDD pipeline |
| `/project` | PROJECT | Design + tasks + TDD |
| `/initiative` | INITIATIVE | Full proposal → design → tasks → archive |

### Spec Workflow (Initiative Tier)

| Skill | Description |
|-------|-------------|
| `/spechub:propose` | Create a feature proposal with user stories |
| `/spechub:clarify` | Resolve ambiguities in the proposal |
| `/spechub:design` | Generate implementation design |
| `/spechub:tasks` | Generate dependency-ordered task list |
| `/spechub:implement` | Execute tasks via TDD pipeline |
| `/spechub:archive` | Archive change, update living specs |

### Operations

| Skill | Description |
|-------|-------------|
| `/spechub:commit` | Git commit with mandatory spec sync |
| `/spechub:config` | View/modify workflow settings |
| `/spechub:sync` | Update specs from code changes |

### Setup and Supporting

| Skill | Description |
|-------|-------------|
| `/spechub:init` | Initialize SpecHub in a project |
| `/spechub:bootstrap` | Generate initial living specs from code |
| `/spechub:verify` | Cross-artifact consistency analysis |
| `/spechub:explore` | Thinking partner mode (read-only) |
| `/spechub:implement-quick` | Quick implementation with deep analysis |
| `/spechub:test-conventions` | Test placement rules and naming conventions |
| `/spechub:code-review` | Linus Torvalds code philosophy for reviews |
| `/spechub:playwright-helpers` | Scaffold Playwright test helper library |

## Agents

| Agent | Role |
|-------|------|
| `test-writer` | TDD Phase 1 – writes failing tests from requirements only |
| `task-executor` | TDD Phase 2 – makes tests pass, cannot modify tests |
| `task-checker` | TDD Phase 3 – verifies everything (mock audit, regression, TDD isolation) |
| `frontend-verifier` | TDD Phase 4 – real browser verification with Playwright (when frontend configured) |

## Language Profiles

- **python** – pytest, ruff, mypy
- **node-typescript** – npm test, eslint, tsc
- **fullstack-python** – Python backend + Node/TS frontend

## Design Principles

- **TDD is structural, not aspirational.** Test-writer can't see the implementation plan. Executor can't touch test files. Tests stay independent of the code they verify.
- **Specs converge toward reality.** Every commit updates the living specs via spec sync. Agents fix inaccuracies on sight. Specs track what is implemented, never what's planned.
- **Right-sized workflow.** A typo fix doesn't need a proposal. A new payment system does. The orchestrator picks the right tier, or you force one explicitly.
- **Planning outweighs coding.** Three parallel explorers run before any code is written. Mock audits, mutation checks, regression suites, integration wiring.
- **Strict defaults, easy to relax.** Use `/spechub:config` to adjust TDD strictness, orchestrator mode, or default tier.

## License

MIT. See [LICENSE](LICENSE).

## Credits

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** – SpecHub's CLI is forked from OpenSpec, which was the core spec engine that the workflow was originally built on. The spec-driven development concepts – proposals, designs, tasks, living specs, change management, archiving – all originate from OpenSpec.
- **[Taskmaster AI](https://github.com/eyaltoledano/claude-task-master)** – The orchestrator pattern and agent coordination approach were inspired by Taskmaster's task management model.
- Additional inspiration from [Superpowers](https://github.com/obra/superpowers), [GSD](https://github.com/gsd-build/get-shit-done), and [Spec Kit](https://github.com/github/spec-kit).
