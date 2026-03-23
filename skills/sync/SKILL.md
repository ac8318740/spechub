---
name: sync
description: Update living specs in openspec/specs/ from recent code changes. Called automatically by /commit for retroactive spec updates. Can also be invoked manually.
argument-hint: "[file-paths or 'staged']"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

Analyze code changes and update the cumulative living specs in `openspec/specs/` to reflect what changed. This is the "fast path" mechanism that keeps specs current even when the full spec workflow is skipped.

## Step 1: Determine Change Scope

1. If `$ARGUMENTS` is "staged" or called from `/commit`: Use `git diff --cached`
2. If `$ARGUMENTS` contains file paths: Diff those files against HEAD
3. If no arguments: Use `git diff HEAD` (staged + unstaged)

Extract from diff: files added/modified/deleted, functions/classes changed.

## Step 2: Map Changes to Domains

1. Read `openspec/domain-map.yaml`
2. Match changed files against domain path patterns
3. Group changes by domain
4. Skip files outside all domains (tests, config, docs)

If no domains affected: report "No spec-relevant changes" and exit.

## Step 3: Generate Lightweight Deltas

For each affected domain:

1. Read `openspec/specs/[domain]/spec.md` (if exists)
2. Analyze changes:
   - New functions/endpoints/components -> ADDED requirements
   - Modified signatures or behavior -> MODIFIED requirements
   - Deleted functions/endpoints -> REMOVED requirements

## Step 4: Apply Deltas

For each affected domain:

- If spec exists: merge ADDED/MODIFIED/REMOVED into it
- If no spec exists: create minimal spec with ADDED entries and a comment:
  `<!-- Auto-generated from code changes. Run /bootstrap for full spec. -->`

## Step 5: Report

```
Spec sync: [N] domains updated
  - domain-a: +2 added, ~1 modified
  - domain-b: +1 added, -1 removed
```

## Integration with /commit

When called from `/commit`:

1. Receives staged diff as context
2. Runs silently (no user prompts)
3. Returns list of modified spec files for staging
4. Minimal output to not interrupt commit flow

## Spec Correction (Fix It When You See It)

While reading existing specs to generate deltas, if you notice ANY existing FR that contradicts the code in the diff, fix it immediately.
