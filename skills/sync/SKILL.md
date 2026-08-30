---
name: sync
description: Update living specs in spechub/specs/ from recent code changes. Called automatically by /commit for retroactive spec updates. Can also be invoked manually.
argument-hint: "[file-paths or 'staged']"
---

## User input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

This skill analyzes code changes. It updates the cumulative living specs in
`spechub/specs/` to reflect what changed. It is the "fast path" mechanism
that keeps specs current even when a workflow skips full spec planning.

## Step 1: determine change scope

1. If `$ARGUMENTS` is "staged", or `/commit` calls this skill, use `git diff --cached`
2. If `$ARGUMENTS` contains file paths: Diff those files against HEAD
3. If no arguments: Use `git diff HEAD` (staged + unstaged)

Extract from the diff: files added/modified/deleted, functions/classes changed.

## Step 2: map changes to domains

1. Read `spechub/domain-map.yaml`
2. Match changed files against domain path patterns
3. Group changes by domain
4. Skip files outside all domains (tests, config, docs)

If the diff affects no domains, report "No spec-relevant changes". Then exit.

## Step 3: generate lightweight deltas

For each affected domain:

1. Read `spechub/specs/[domain]/spec.md` (if it exists)
2. Analyze changes:
    - New functions/endpoints/components -> ADDED requirements
    - Modified signatures or behavior -> MODIFIED requirements
    - Deleted functions/endpoints -> REMOVED requirements

Write each functional requirement (FR) entry per the `writing` skill.

**Example**

```markdown
### FR-014: The handoff anchor loads once

- **Description**: The SessionStart hook injects `spechub/HANDOFF.md` after a
  compaction, then moves the file into `spechub/handoffs/`.
- **Behavior**: Given `spechub/HANDOFF.md` carries the `spechub_handoff`
  marker, When a session starts with source `compact`, Then the hook injects
  the file and retires it.
- **Source**: `hooks/session-start-handoff.sh`
```

## Step 4: apply deltas

For each affected domain:

- If the spec exists, merge ADDED/MODIFIED/REMOVED into it
- If no spec exists, create a minimal spec with ADDED entries and a comment:
  `<!-- Auto-generated from code changes. Run /bootstrap for full spec. -->`

Write each merged FR per the `writing` skill.

## Step 5: glossary check

Glossaries live in `CONTEXT.md` at the repo root (cross-domain terms) and
`spechub/specs/[domain]/CONTEXT.md` (domain terms). If neither exists, skip.

For each glossary term, check the diff. Look for a renamed or deleted
identifier that matches it: function, class, table, config key, route. If
so, surface it in the report:

```
Glossary: 'ticket' may be stale – the diff renames Ticket to WorkItem
```

Never edit the glossary. Never block the commit.

For specs, the code wins. For the glossary, the human wins. The glossary
records vocabulary that humans agreed on, so only a human decision changes
it.

This check only surfaces the drift.

## Step 6: report

```
Spec sync: [N] domains updated
  - domain-a: +2 added, ~1 modified
  - domain-b: +1 added, -1 removed
```

## Integration with /commit

When `/commit` calls this skill:

1. Receives the staged diff as context
2. Runs silently (no user prompts)
3. Returns a list of modified spec files for staging
4. Outputs minimal detail so it does not interrupt the commit flow

## Spec correction (fix it when you see it)

While reading existing specs to generate deltas, if you notice ANY existing FR that contradicts the code in the diff, fix it immediately.
