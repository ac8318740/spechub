---
name: quick-fix
description: "Structured workflow for fixing bugs, issues, and broken behavior. Enforces codebase exploration before touching code, root cause analysis, minimal change principle, and full verification. Use when (1) something is broken and needs fixing, (2) behavior is wrong and needs correcting, or (3) user reports a bug. Lighter than a full debug investigation but more disciplined than ad-hoc fixes. Not for new features – use the Implementation Discipline directly."
argument-hint: "<description of what's broken>"
---

# Quick Fix

Structured fix workflow: understand -> locate -> root-cause -> fix -> verify.

## Input

```
$ARGUMENTS
```

If `$ARGUMENTS` is empty, ask the user to describe what's broken.

## Step 1: Understand the Problem

Before touching any code:

1. Restate the problem in one sentence. What is the expected behavior vs actual behavior?
2. Classify the problem type:
   - **Crash/error**: Stack trace or error message available
   - **Wrong behavior**: Code runs but produces incorrect results
   - **Regression**: Something that used to work stopped working
   - **Performance**: Too slow, too many resources

If the user provided an error message or stack trace, note the key details (file, line, error type).

## Step 2: Explore the Codebase

**Do NOT skip this step.** Delegate exploration to subagents:

1. **Locate the code**: Find the file(s) involved. Use Grep and Glob to search for relevant functions, classes, and modules. Launch an Explore subagent if the scope is unclear.

2. **Read the integration points**: Don't just read the broken function — read its callers and callees. Understand:
   - What calls this code? (upstream)
   - What does this code call? (downstream)
   - What data flows through it? (inputs/outputs)
   - Are there tests covering this behavior?

3. **Check recent changes**: If this is a regression, run:
   ```bash
   git log --oneline -20 -- <file>
   ```
   to see if a recent commit introduced the issue.

Produce a brief exploration summary:

```
Files involved: <list>
Integration points: <upstream -> target -> downstream>
Existing tests: <list or "none">
Recent changes: <relevant commits or "none suspicious">
```

## Step 3: Root Cause Analysis

Based on the exploration, identify the root cause — not just the symptom.

Bad: "The function returns null" (symptom)
Good: "The function returns null because the query filter uses `org_id` but the test user's org isn't in the result set" (root cause)

If the root cause isn't clear after exploration, escalate to deeper investigation with parallel debug subagents. Don't guess.

## Step 4: Plan the Fix

Before coding, state:

1. **What** will change (which file(s), which function(s))
2. **Why** this fixes the root cause (not just the symptom)
3. **What won't change** (confirm the fix is minimal — no drive-by refactors)

If the fix touches more than 3 files, pause and confirm with the user — it may be bigger than a quick fix.

## Step 5: Implement via Implementation Discipline

Follow the standard pipeline:

1. **test-writer** — Write a failing test that reproduces the bug (if testable behavior exists). Skip for pure config/infra fixes.
2. **task-executor** — Implement the minimal fix to make the test pass. Executor CANNOT modify test files.
3. **task-checker** — Verify: task tests pass, full suite passes, test count >= baseline, no regressions.
4. **frontend-verify** — Only if frontend files were modified (check `frontend.directory` in project.yaml).

## Step 6: Verify

Run build verification using commands from `spechub/project.yaml`:

```bash
# Run the project's configured test, lint, and typecheck commands
# Read these from project.yaml — do not hardcode
```

**STOP — if frontend files were modified, you MUST visually verify before proceeding to Step 7.**

If the project has a frontend verification agent or browser verification configured, use them. Otherwise, take a browser screenshot and think through:

1. **Expected vs actual** — What should the change look like? Does the screenshot match?
2. **Gaps** — Is anything missing, wrong, or showing the wrong data/labels/formatting?
3. **General UX** — Anything weird? Overlapping elements, bad spacing, truncation, unprofessional appearance?

If any issue -> fix it and re-verify. Do NOT proceed to Step 7 with unverified frontend changes.

## Step 7: Report

```
=== Quick Fix Complete ===

Problem: <one-line description>
Root cause: <what was actually wrong>
Fix: <what changed and why>
Files modified: <list>
Tests: <added/modified/passing>
Regressions: none
```

Remind the user to `/commit` when they're satisfied.
