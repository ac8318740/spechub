---
name: implement
description: Execute tasks from an active OpenSpec change following the TDD pipeline (test-writer -> task-executor -> task-checker). Creates a feature branch and implements phase by phase.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What This Skill Does

Implements tasks from an active OpenSpec change's `tasks.md`. Creates a feature branch, executes tasks phase by phase using the TDD pipeline, and verifies everything builds. Keeps tasks.md updated as the single source of progress.

## Steps

### 1. Find the Change

If `$ARGUMENTS` specifies a change name, use it. Otherwise:

```bash
openspec list --json
```

If only one active change, use it. If multiple, ask the user.

Read all artifacts from `openspec/changes/<name>/`:

- **tasks.md** (required — the task list to execute)
- **proposal.md** (context — what/why)
- **design.md** (context — how, architecture decisions)
- **research.md** (context — if exists)

### 2. Read Project Configuration

Read `openspec/project.yaml` for build/test/lint commands and directory paths.

### 3. Create Feature Branch

```bash
git checkout master && git checkout -b "<change-name>"
```

If the branch already exists, ask the user whether to continue on it or start fresh.

### 4. Execute Tasks Phase by Phase

For each phase in tasks.md:

**Assess parallelism**: If the phase has 2+ tasks marked `[P]` that touch non-overlapping files, launch an **Agent Team** where each teammate owns a scope. Otherwise, execute sequentially with subagents.

**For each task (or scope), follow the Implementation Discipline:**

1. **test-writer subagent** — Write failing tests from the task requirements. Skip for pure config/setup tasks (T001, T002, etc.) that have no testable behavior.

2. **task-executor subagent** — Make the failing tests pass. Executor CANNOT modify test files.

3. **task-checker subagent** — Verify: tests pass, full suite passes, test count >= baseline, mock audit, TDD isolation, integration wired, frontend visual verification (if applicable).

If checker fails -> route back to executor with feedback. Do not proceed to next task until checker passes.

### 5. Task Progress Tracking (MANDATORY)

**tasks.md is the single source of truth for progress.** Keep it updated at all times:

- **Immediately after task-checker passes** for a task: update `- [ ]` -> `- [x]` in tasks.md
- **Do NOT batch updates** — mark each task done as soon as it passes verification
- **If a task is partially done or blocked**: add a note below the task line: `  <!-- BLOCKED: reason -->`
- **If you discover a task needs splitting**: add sub-tasks indented below the original, numbered as T005a, T005b, etc.
- **If a task turns out unnecessary**: mark it `- [~]` with a note: `  <!-- SKIPPED: reason -->`

**After completing each phase**, report progress to the user:

```
## Phase N Complete

Tasks: X/Y done (Z skipped)
Tests: [pass count] passing, [fail count] failing
Build: OK | FAIL

Moving to Phase N+1...
```

### 6. Build Verification (After Each Phase)

Run the commands from `openspec/project.yaml`:

- Backend/source build command
- Frontend build command (if configured)
- Full test suite
- Lint and typecheck

All must pass before moving to the next phase.

### 7. Frontend Visual Verification

**Only if `frontend` is configured in `openspec/project.yaml`.**

For any phase that creates or modifies UI components, the task-checker handles this automatically. For deeper visual audits, launch an Explore subagent to verify spacing, styling, and visual consistency.

### 8. Completion

After all phases complete:

- Verify all tasks in tasks.md are marked `[x]` or `[~]`
- Run final build verification
- Report summary: tasks completed, tests passing, lines added/removed
- Remind user: run `/commit` to commit, then `/archive` to update living specs

## Key Rules

- **TDD pipeline is mandatory** — test-writer -> task-executor -> task-checker. No exceptions except pure config tasks.
- **Executors CANNOT modify test files** — if tests are wrong, report the issue.
- **Agent Teams for parallel scopes** — 2+ independent `[P]` tasks with non-overlapping files -> team.
- **Build verification after every phase** — do not skip.
- **Update tasks.md immediately** — every completed task gets checked off right away.
- **Do NOT commit** — the user manages git commits via `/commit`.
- **Do NOT push** — the user decides when to push.
