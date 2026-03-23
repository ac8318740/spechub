---
name: implement-quick
description: Quick implementation path with deep codebase analysis for bug fixes, migration regressions, restoring dropped functionality, and small well-understood changes. Launches 3 parallel Explore agents before coding. Use instead of the full /propose -> /design -> /tasks path when requirements are clear. Do NOT use for new multi-domain features or architectural changes.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

Consider the user input before proceeding (if not empty).

## Overview

Analyze deeply, then implement quickly. No OpenSpec scaffolding, no proposal/design/tasks documents. The 3-explorer pattern ensures changes are grounded in codebase reality before any code is written.

## Steps

### 1. Read Project Configuration

Read `openspec/project.yaml` for build/test/lint commands and directory paths.

### 2. Branch Setup

```bash
git branch --show-current
```

If on `master` or `main`, create a feature branch. If on a feature branch, confirm with the user it's the right one.

### 3. Deep Analysis — 3 Parallel Explore Subagents

Launch **exactly 3 Explore subagents in parallel** using the Agent tool:

**Explorer 1 — Current State & Integration Points**

> Investigate the current code for: $ARGUMENTS
>
> Find and report:
> - Current implementation in the affected area (read the actual code)
> - All integration points: imports, API calls, event handlers, state connections
> - Data flow through the affected components/functions

**Explorer 2 — Existing Patterns & Reuse**

> Search for reusable code related to: $ARGUMENTS
>
> Find and report:
> - Existing utilities, helpers, hooks, or components that solve part of this problem
> - Code elsewhere that does something similar (to reuse, not duplicate)
> - Conventions the codebase follows for this type of change
> - Shared abstractions that MUST be used instead of creating new ones

**Explorer 3 — Impact & Risk**

> Assess the impact and risk of changing: $ARGUMENTS
>
> Find and report:
> - Existing tests for the affected area
> - Other consumers of the functions/components being modified
> - What could break from this change
> - Related living specs in openspec/specs/ that describe expected behavior

### 4. Synthesize Findings

After all 3 explorers report, produce a synthesis:

- **What changes** — specific files, functions, components
- **What to reuse** — existing code that solves part of the problem (from Explorer 2). FAIL if this is ignored during implementation.
- **What NOT to build** — things that already exist or aren't needed
- **What could break** — risk areas requiring test coverage
- **Approach** — recommended implementation, grounded in explorer findings

### 5. Clarify with User

Review synthesis for ambiguities. Use **AskUserQuestion** to resolve them.

**Rules:**

- Maximum 5 questions. Each must offer a recommended option.
- Only ask questions whose answers change what code gets written.
- If no ambiguities, say so and proceed.

### 6. Plan Tasks

Break work into discrete tasks:

- What specifically changes (files, functions)
- Acceptance criteria
- Independence (for parallelism)

Present to the user for approval.

### 7. Implement — Mandatory TDD Pipeline

Follow the Implementation Discipline for every task. No exceptions.

**Phase 1: test-writer** (subagent_type=test-writer)

- Provide requirements and acceptance criteria ONLY — no implementation plans
- Verify all tests FAIL (feature not yet built)
- Skip ONLY for pure config/infra with no testable behavior

**Phase 2: task-executor** (subagent_type=task-executor)

- Provide failing tests + task requirements + Explorer 2 reuse findings
- Executor CANNOT modify files in test directory
- **FAIL if executor creates code that duplicates something Explorer 2 identified as reusable**

**Phase 3: task-checker** (subagent_type=task-checker)

- Run full verification per Mandatory Constraints below
- FAIL -> route back to appropriate phase with feedback
- Do NOT proceed until checker PASSES

**Parallelism**: 2+ independent tasks with non-overlapping files -> Agent Team.

### 8. Build Verification

Run the full build verification suite from project.yaml. ALL must pass.

### 9. Frontend Visual Verification

**Only if `frontend` is configured in `openspec/project.yaml`.**

If any frontend files changed:

1. Check dev server using `frontend.dev_server_check`
2. Running -> Playwright MCP: navigate, snapshot, verify rendering
3. Not running -> report LOW CONFIDENCE

### 10. Completion

Report tasks completed, tests passing, files changed. Remind user to run `/commit`. Do NOT commit or push.

---

## Mandatory Constraints

These are FAIL conditions. Any violation means the task-checker MUST reject the implementation.

### C1: YAGNI — No Speculative Code

- FAIL if code adds abstractions for hypothetical future use
- FAIL if code adds configurability beyond what was requested
- FAIL if code adds error handling for impossible scenarios
- FAIL if code creates a helper/utility used only once
- Only implement what the user asked for. Nothing more.

### C2: DRY — Reuse What Exists

- FAIL if new code duplicates functionality Explorer 2 identified as existing
- FAIL if a new utility is created without confirming no equivalent exists
- Reuse existing components, hooks, services, patterns. Extract to shared location ONLY at 3+ uses.

### C3: KISS — Simplest Approach

- FAIL if a new component is created when adding to an existing component suffices
- FAIL if indirection is added without justification
- Match the complexity level of surrounding code.

### C4: Integration Integrity

- FAIL if any change is unreachable from UI or API (dead code)
- FAIL if import chains don't resolve
- FAIL if state management is incomplete
- Verify: user action -> state change -> API call -> response -> UI update

### C5: Test Quality

- FAIL if tests mock the thing they're testing (mocks ONLY for external deps)
- FAIL if assertions are circular
- FAIL if introducing a deliberate bug doesn't break at least one test

### C6: Minimal Diff

- FAIL if code refactors adjacent untouched code
- FAIL if type annotations, docstrings, or comments are added to unchanged code
- FAIL if import ordering or style is "improved" in untouched files

### C7: Security

- FAIL if code introduces OWASP top 10 vulnerabilities
- Validate at system boundaries only.

### C8: TDD Isolation

- FAIL if the task-executor modified any file in the test directory

### C9: Regression

- FAIL if any tests fail
- FAIL if test count drops below `.test-baseline`
