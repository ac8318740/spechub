---
name: pre-commit-review
description: "Deep code quality review of all changes since last commit. Checks for hardcodes, single-source-of-truth violations, scalability issues, edge cases, and project convention drift using dynamic project awareness (living specs, codebase search, surrounding code). Also flags adjacent code rot worth cleaning up. Auto-invocable in two contexts – (1) when working autonomously through a task list and about to commit (e.g., user said \"implement all tasks and commit\"), use --auto-fix mode; (2) when the user manually invokes /commit and this skill has not already run on the current changes, use INTERACTIVE mode (default). Manual invocation via /pre-commit-review also uses interactive mode by default."
argument-hint: "[--auto-fix] [scope description]"
---

# Pre-Commit Review

Deep, project-aware code quality review of uncommitted changes. Finds issues that linters miss:
hardcodes, duplicated logic, missing edge cases, convention drift, and adjacent rot.

## User Input

```text
$ARGUMENTS
```

## Mode Detection

Parse `$ARGUMENTS` and invocation context to determine mode:

- **Auto-fix mode**: Use when ANY of these are true:
  - Arguments contain `--auto-fix`, `fix everything`, `auto fix`, or `fix automatically`
  - The LLM is working autonomously (user asked to implement + commit + push, work through
    a task list, "handle everything", etc.) and the LLM itself decided to commit — the user
    is likely not present, so don't block on questions.

- **Interactive mode** (default): Use when ANY of these are true:
  - No `--auto-fix` argument and skill was invoked manually via `/pre-commit-review`
  - Skill was auto-invoked because the user typed `/commit` — the user is clearly present
    and should be consulted via AskUserQuestion waves.
  - When in doubt, use interactive — it's always safe to ask.

**Rule of thumb**: Who initiated the commit? User typed `/commit` -> interactive.
LLM decided to commit during autonomous work -> auto-fix.

## Workflow Overview

```
1. SNAPSHOT  — collect the diff and understand what changed
2. DISCOVER  — learn project conventions dynamically (parallel subagents)
3. REVIEW    — analyze changes against conventions + best practices (parallel subagents)
4. ADJACENT  — check surrounding code for related rot (parallel subagents)
5. REPORT    — synthesize findings
6. FIX       — auto-fix or interactive proposal waves
```

## Step 1: SNAPSHOT

Collect the raw material:

```bash
# All changes (staged + unstaged + untracked) since last commit
git diff HEAD
git diff --cached
git status --short
git log --oneline -3  # recent context
```

Read `spechub/project.yaml` to understand the project's directory layout, commands, and conventions.

Categorize changed files into scopes using the project configuration:

- **source**: files under `directories.source` from project.yaml
- **frontend**: files under `frontend.directory` from project.yaml (if configured)
- **config**: `*.yaml`, `*.toml`, `*.json`, config files, etc.
- **tests**: files under `directories.tests` from project.yaml
- **other**: everything else

If no meaningful code changes exist (only docs, config, assets), report "No code changes to review" and exit.

## Step 2: DISCOVER — Learn Project Conventions (Parallel)

Launch **3 parallel Explore subagents** to build a dynamic understanding of the project's current conventions.
Do NOT hardcode conventions — discover them fresh each time.

**Subagent A — Living Specs & Architecture:**

```
Read the living specs relevant to this change:
- Check spechub/specs/ directory listing
- Read spec.md files for domains touched by the changed files
  (use spechub/domain-map.yaml to map files -> domains)
- Extract documented conventions, patterns, and requirements (FR-NNN entries)
Report: list of project conventions and patterns relevant to these changes.
```

**Subagent B — Codebase Patterns via Search:**

```
Use Grep and Glob to find established patterns related to the changes.
For each changed function/component, search for similar implementations:
  Grep for function signatures, class names, and patterns from the diff
  Glob for files with similar naming conventions
Identify: how does the rest of the codebase handle similar things?
Report: established patterns, common approaches, naming conventions observed.
```

**Subagent C — Local Context & Config:**

```
For each changed file, read:
- The full file (to see surrounding code context)
- Import targets (what does this file import? read those files' signatures)
- Config that governs this area (linter rules, compiler config, etc.)
Report: local conventions, related code patterns, existing abstractions nearby.
```

Synthesize the three reports into a **convention profile** — the set of expectations
changes will be measured against.

## Step 3: REVIEW — Analyze Changes (Parallel)

Launch **3 parallel review subagents**, each examining a different quality dimension.
Every subagent receives the diff AND the convention profile from Step 2.

**Subagent 1 — Hardcodes & SSOT:**

```
Examine the diff for:
- Hardcoded values: URLs, ports, credentials, API keys, magic numbers, string literals
  that should be constants or config
- Single Source of Truth violations: same logic/value defined in 2+ places,
  copy-pasted code that should be a shared function, config scattered across files
- Constants that belong in a central config but are inline
- Duplicated type definitions or interfaces

For each finding, report:
  FILE:LINE | SEVERITY (MUST/SHOULD/CONSIDER) | WHAT | WHY | SUGGESTED FIX
```

**Subagent 2 — Scalability & Readability:**

```
Examine the diff for:
- Functions > 40 lines or > 3 levels of nesting
- God functions doing too many things
- Unclear variable/function names
- Missing or premature abstractions
- Complex conditionals that could be simplified
- Code that would be hard for a new developer to understand
- Performance concerns (N+1 queries, unnecessary re-renders, blocking I/O)

For each finding, report:
  FILE:LINE | SEVERITY (MUST/SHOULD/CONSIDER) | WHAT | WHY | SUGGESTED FIX
```

**Subagent 3 — Edge Cases & Robustness:**

```
Examine the diff for:
- Unhandled null/undefined/None cases
- Empty array/object assumptions
- Missing error handling on I/O, network calls, or DB queries
- Race conditions in async code
- Missing input validation at system boundaries
- Unhappy paths not tested or handled
- Type narrowing gaps (any casts, missing type hints on public APIs)

For each finding, report:
  FILE:LINE | SEVERITY (MUST/SHOULD/CONSIDER) | WHAT | WHY | SUGGESTED FIX
```

## Step 4: ADJACENT — Check Surrounding Code for Rot

For each file that has findings from Step 3, launch an **Explore subagent** (up to 3 in parallel)
to examine the rest of that file and its immediate imports for the SAME categories of issue.

```
File [path] has these issues in the changed code: [summary].
Read the FULL file and its direct imports.
Find any OTHER instances of the same categories of problem in this file
or closely related files — even if they weren't part of this commit's changes.
These are "while we're here" cleanup opportunities.

Report as: ADJACENT | FILE:LINE | WHAT | WHY | SUGGESTED FIX
```

Only flag adjacent issues that are **closely related** to the current changes (same file,
same module, or same pattern). Don't boil the ocean.

## Step 5: REPORT — Synthesize Findings

Merge all subagent findings. Deduplicate. Sort by:

1. MUST FIX (correctness, security, will-break-in-prod)
2. SHOULD FIX (convention violations, readability, maintainability)
3. CONSIDER (style preferences, minor improvements, adjacent rot)

For each finding, ensure it has:

- `file:line` reference
- Category tag (HARDCODE, SSOT, SCALABILITY, READABILITY, EDGE-CASE, ADJACENT)
- Severity (MUST / SHOULD / CONSIDER)
- Clear 1-sentence description of the problem
- Why it matters (1 sentence)
- Suggested fix (concrete, actionable — code snippet or approach)

If any finding needs deeper analysis to determine the right fix, launch a **planning subagent**:

```
This code has [problem]. The file is [path]. Here's the surrounding context: [context].
Think through 2-3 possible fixes, evaluate trade-offs, and recommend the best approach.
Consider: does a fix here require changes in other files? What's the minimal change?
```

## Step 6: FIX — Auto-Fix or Interactive Waves

### Auto-Fix Mode

For each finding (MUST first, then SHOULD, then CONSIDER):

1. Launch a **task-executor subagent** with the finding + suggested fix
2. Verify the fix doesn't break anything (run lint, typecheck, and test commands from project.yaml)
3. If fix breaks something, revert and try alternate approach
4. Move to next finding

After all fixes, run full verification using commands from `spechub/project.yaml`:

```bash
# Run the project's configured test, lint, and typecheck commands
# Read these from project.yaml — do not hardcode
```

Report summary of what was fixed.

### Interactive Mode (Default)

Present findings in **waves of up to 4** using AskUserQuestion. Group related findings together.

Format each wave like:

```
I found these issues in your changes. For each, choose: FIX / SKIP / DISCUSS

1. [MUST | HARDCODE] `path/to/file.py:42`
   Hardcoded timeout value `30` — should use config constant.
   Suggested fix: Move to config, reference from there.

2. [SHOULD | SSOT] `path/to/api/client.ts:15`
   Duplicated error handling pattern — same try/catch in 3 functions.
   Suggested fix: Extract shared wrapper function.

3. [CONSIDER | ADJACENT] `path/to/component.tsx:88`
   Existing code (not your change) has a magic string — should use constant.
   Suggested fix: Add constant, use in both places.

4. [SHOULD | EDGE-CASE] `path/to/manager.py:120`
   No null check on response before accessing `.status`.
   Suggested fix: Add guard clause with appropriate error.

Reply with numbers to fix (e.g., "1,2,4") or "all" or "skip all", and any notes on approach.
```

After user responds:

- Fix selected items via task-executor subagents (parallelize independent fixes)
- Present next wave if more findings remain
- Continue until all findings addressed or user says "done" / "skip the rest"

## Severity Guide

| Severity | Meaning                                                | Examples                                                           |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| MUST     | Will cause bugs, security issues, or prod failures     | Hardcoded secrets, unhandled null on critical path, race condition |
| SHOULD   | Violates conventions, hurts maintainability, tech debt | SSOT violations, unclear naming, missing error handling on I/O     |
| CONSIDER | Improvement opportunity, not urgent                    | Adjacent rot, minor style, could-be-cleaner patterns               |

## What This Skill Does NOT Check

- **Formatting/style** — linters and formatters handle this
- **Type errors** — typecheckers handle this
- **Test coverage** — task-checker handles this
- **UI rendering** — frontend-verify handles this
- **Security scanning** — dedicated security tools handle credentials in committed code

Focus exclusively on the semantic/architectural issues that automated tools miss.
