# SpecHub

A Claude Code plugin for spec-driven TDD development.

## Overview

SpecHub grows planning structure only as far as the fog demands. Fog is the part of the work you cannot state precisely yet – the open questions, the undecided shape. Little fog means little structure, so the same entry point serves a one-question change and a fifty-question effort. Living specs stay in sync with your codebase automatically via commit-time spec sync.

Every rule exists because something went wrong without it. SpecHub grew over months of real product development with Claude Code.

## Workflows

No path selection. Planning structure grows only as far as the fog demands:

- **The way is clear** – `/spechub:implement` runs the TDD pipeline (test-writer → task-executor → task-checker, plus frontend-verifier when `project.yaml` sets `frontend`) on the request directly. A small unit of work is simply small.
- **Something broke** – `/spechub:quick-fix` forces root-cause analysis before any edit.
- **Decisions need settling** – `/spechub:map` charts a map if none exists and works the frontier if one does. You settle a single question in conversation. SpecHub calls that interview technique grilling. The question leaves an architecture decision record (ADR), a short note that states the decision and the reason. A long effort becomes a map instead, worked across sessions.

A map is a set of small records called nodes. Each node is one question to settle or one piece of work to do. Every node has one of five statuses: `fog`, `open`, `claimed`, `resolved` and `out-of-scope`. A `fog` node holds something you cannot state precisely yet. An `open` node is ready to settle, and a `claimed` node is one someone works now. You have settled a `resolved` node, and you have deliberately dropped an `out-of-scope` node.

Every node also names its provenance parent – the node whose answer raised this one. It names its blocking edges too – the nodes that must resolve before it can start. A node's mode says who settles it: `hitl` for a human, `afk` for an agent working alone.

The frontier is the set of nodes you can work right now – the open nodes with nothing unresolved blocking them. A tracker holds the nodes. A tracker is the swappable storage layer behind a map (GitHub issues first-class, plain files as the fallback). The packaging walk collects a map into one brief, so a fresh session can pick up an effort without re-reading everything.

For the full picture – each step and how they connect – read [docs/workflows.md](docs/workflows.md).

## Features

- **Progressive materialisation** – structure appears only when it has to persist; a map exists only when the fog will outlive the session
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
/plugin marketplace add ac8318740/ac-agentic-coding
/plugin install spechub@ac-agentic-coding
```

Then in your project:

```
/spechub:setup
```

This detects your project type and generates `spechub/project.yaml` with workflow settings. SpecHub loads its orchestrator instructions at session start whenever it detects a spechub project. Your CLAUDE.md stays clean for project-specific content.

For every key in that file, its values, its default and what changes when you change it, read [docs/config-reference.md](docs/config-reference.md).

Each machine also declares its own dev setup once, with `/spechub:host`. For every axis, what reads it, and how to describe a fresh machine, read [docs/dev-setups.md](docs/dev-setups.md).

## Terminal workspace for driving several agents

Run `/spechub:terminal-workspace` to set up a keyboard-only terminal for driving several agents on a dev machine, the remote machine your agents run on. The skill installs every tool and writes every config. SpecHub needs none of it, so the whole setup is optional. [docs/terminal-workspace.md](docs/terminal-workspace.md) documents it.

The setup builds on herdr, a terminal multiplexer that keeps each agent's terminal running after you disconnect. You attach to it from your own machine with `herdr --remote`, so your own clipboard and browser reach the session. Each agent can get its own git worktree, meaning its own checkout on its own branch. Then gh-dash triages pull requests and diffnav reads diffs, both without leaving the terminal. The document gives the exact config, every key, and the traps worth knowing.

## CLI

SpecHub ships a Node.js CLI (`spechub config`, `spechub list`, `spechub node ...`, `spechub archive`).

A tracker has to provide four operations and nothing more: create, read, update, list. GitHub issues are the first-class tracker, because they already have the two links a map needs. Sub-issues carry the provenance parent, and issue dependencies carry the blocking edges. The CLI also ships a files tracker as the fallback (`spechub node create | read | update | list`), which writes one markdown file per node under `spechub/maps/<name>/`.

The CLI builds everything else on those four operations. `spechub node frontier` lists the nodes ready to work. It returns the open nodes with nothing unresolved blocking them, closest to the root node first.

`spechub node walk` packages the map for a handoff. It reads the nodes in provenance order. It includes the root node in full, plus any node marked pinned. Pinned marks a node as always worth carrying along. The skills claim and resolve a node with `update` calls.

The plugin's skills and agents invoke the CLI through an invariant absolute path – `~/.claude/spechub/bin/spechub` – that the SessionStart hook maintains. Agents therefore do not depend on your shell `PATH`. The CLI keeps working across plugin version bumps, non-interactive subshells, and fresh agent contexts.

For typing `spechub` at a terminal yourself, the hook also creates `~/.local/bin/spechub`. Add `~/.local/bin` to your `PATH` to use it. The hook prints a one-line reminder if it isn't already there. This second symlink is a convenience only – nothing in the plugin breaks if you don't set up `PATH`.

If `spechub` doesn't run after install, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). A Claude Code session can read it and apply the fix directly.

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
| `/spechub:archive` | Close out a cleared map – check the residue landed (the durable output: spec updates, ADRs, glossary entries), then dispose of the nodes |
| `/spechub:sync` | Update specs from code changes |
| `/spechub:handoff` | Hand work to a visible agent – a new one in its own pane, or one already running – with acknowledgement |
| `/spechub:compact-and-continue` | Anchor the session's load-bearing state to survive compaction, then continue in place |

### Setup and supporting

| Skill | Description |
|-------|-------------|
| `/spechub:setup` | Set up SpecHub in a project, and change how a project already set up is configured |
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
| `/spechub:terminal-workspace` | Set up a keyboard-only terminal for driving agents on a dev machine |

## Agents

| Agent | Role |
|-------|------|
| `test-writer` | Writes tests from requirements only, before the code under strict TDD and after it under relaxed |
| `task-executor` | TDD Phase 2 – makes tests pass, cannot modify tests |
| `task-checker` | TDD Phase 3 – verifies everything (mock audit, regression, TDD isolation) |
| `frontend-verifier` | TDD Phase 4 – real browser verification via agent-browser CLI (when frontend configured) |

## Output style

The plugin ships one output style, shown to Claude Code as `spechub:ac-writing-style`. It applies the `writing` skill's plain-language rules and the `visual-docs` skill's Minto pyramid to every chat reply. A reply leads with the answer, keeps one idea per sentence, names the actor, and uses no em dash or emoji.

`/spechub:setup` offers the style on both paths: late and optional on a new project, and as a health-check row on one already set up. The skill writes `outputStyle` for you, and asks first. Use `~/.claude/settings.json` for every project, or `.claude/settings.local.json` for this one. A project value overrides the global one. The style applies after `/clear`, or in a new session. The plugin never forces it on.

## Language profiles

- **python** – pytest, ruff, mypy
- **node-typescript** – npm test, eslint, tsc
- **fullstack-python** – Python backend + Node/TS frontend

## Design principles

- **TDD is structural under strict, instructional under relaxed.** Executor can't touch test files, either way. Under strict TDD the test-writer runs first, so no implementation exists for it to see. Under relaxed it runs after the executor, and only its instructions keep it from reading the code it tests. The two settings do not give equal independence, which is why strict is the default.
- **Specs converge toward reality.** Every commit updates the living specs via spec sync. Agents fix inaccuracies on sight. Specs track what the code implements, never what anyone plans.
- **Progressive materialisation.** Structure appears only when it has to persist. A typo fix needs no machinery. A long effort earns a map. The same entry point serves both, and nothing declares which.
- **Planning outweighs coding.** Three parallel explorers run before anyone writes code. Mock audits, mutation checks, regression suites, integration wiring.
- **Strict defaults, easy to relax.** Run `spechub config set` to adjust TDD strictness, orchestrator mode, or how grilling presents questions.

## License

[MIT](LICENSE)

## Credits

- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)** – SpecHub forks its CLI from OpenSpec. OpenSpec was the core spec engine under the original workflow. The spec-driven development concepts – proposals, designs, tasks, living specs, change management, archiving – all originate from OpenSpec.
- **[Taskmaster AI](https://github.com/eyaltoledano/claude-task-master)** – Taskmaster's task management model inspired the orchestrator pattern and the agent coordination approach.
- **[Skills for Real Engineers](https://github.com/mattpocock/skills)** by Matt Pocock – the Wayfinder map, the grilling technique, and the durability rule for agent briefs. SpecHub's node graph is a direct adaptation of Wayfinder. MIT licensed; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
- Additional inspiration from [Superpowers](https://github.com/obra/superpowers), [GSD](https://github.com/gsd-build/get-shit-done), and [Spec Kit](https://github.com/github/spec-kit).
- The optional terminal workspace installs, but does not bundle, the three tools you drive and the five behind them. Each keeps its own licence.
  - [herdr](https://herdr.dev)
  - [tuicr](https://github.com/agavra/tuicr) by agavra, which reviews a pull request inside the terminal
  - [gh-dash](https://github.com/dlvhdr/gh-dash) and [diffnav](https://github.com/dlvhdr/diffnav) by dlvhdr
  - [delta](https://github.com/dandavison/delta) by dandavison
  - [yazi](https://github.com/sxyazi/yazi) by sxyazi, the file manager that previews whatever the cursor sits on
  - [mermaid-ascii](https://github.com/AlexanderGrooff/mermaid-ascii) by AlexanderGrooff
  - [glow](https://github.com/charmbracelet/glow) by charmbracelet
- The optional fork build of tuicr compiles [agavra/tuicr#607](https://github.com/agavra/tuicr/pull/607) by [antonio2368](https://github.com/antonio2368). It also compiles [agavra/tuicr#633](https://github.com/agavra/tuicr/pull/633) and one counts fix not yet submitted upstream, both written for this fork. That build is off by default and temporary. See [docs/terminal-workspace.md](docs/terminal-workspace.md).
