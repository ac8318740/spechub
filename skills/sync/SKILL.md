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

## Step 2: refresh DESIGN.md

`DESIGN.md` at the repo root records the project's design tokens. The
`impeccable document` command writes that file from the code. A **token
source** is a file that defines those tokens, meaning CSS custom properties or
a Tailwind theme.

This step runs before Step 3. Step 3 exits early when the diff touches no
domain, and a token source such as `app/globals.css` usually sits outside every
domain.

1. Run `~/.claude/spechub/bin/spechub design-gate`
    - It prints `on` and exits 0 when the design gate is on
    - It prints `off: <reason>` and exits 1 when the gate is off
    - Skip the whole step on a non-zero exit
2. Check for `DESIGN.md` at the repo root
    - Skip the whole step when the file is missing
    - Sync never creates `DESIGN.md` – the open-designer plugin writes it
3. Look for a token source in the diff Step 1 chose

    A token source is exactly one of these four, matching what `impeccable
    document` scans:

    - a CSS file whose diff adds or changes a line holding `--color-`,
      `--font-`, `--spacing-`, `--radius-`, `--shadow-`, `--ease-` or
      `--duration-`
    - a Tailwind config: `tailwind.config.js`, `tailwind.config.ts` or
      `tailwind.config.mjs`
    - a CSS-in-JS theme file: `theme.ts`, `theme.js`, `tokens.ts` or `tokens.js`
    - a token file: `tokens.json` or `design-tokens.json`

    Grep the diff for the CSS-property case:

    ```bash
    git diff --cached -U0 -- '*.css' | grep -E '^[+-].*--(color|font|spacing|radius|shadow|ease|duration)-'
    ```

    Match the diff command to what Step 1 chose. Use `git diff HEAD -U0`
    instead when Step 1 picked `git diff HEAD`.

    Skip the whole step when the diff holds no token source.

4. Run the `/impeccable document` slash command

    `document` is a slash-command playbook, not a command-line verb.

    The playbook finds `DESIGN.md` and stops. It asks whether to refresh,
    overwrite, or merge. Answer refresh every time.

    Do not call AskUserQuestion. Do not ask the user. The code is the only
    source of truth for design tokens.

5. Stage what `document` wrote

    `document` writes `DESIGN.md` and `.impeccable/design.json`. Stage both
    with the commit, the same way this skill stages an updated spec file.

## Step 3: map changes to domains

1. Read `spechub/domain-map.yaml`
2. Match changed files against domain path patterns
3. Group changes by domain
4. Skip files outside all domains (tests, config, docs)

If the diff affects no domains, report "No spec-relevant changes". Then exit.

## Step 4: generate lightweight deltas

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

## Step 5: apply deltas

For each affected domain:

- If the spec exists, merge ADDED/MODIFIED/REMOVED into it
- If no spec exists, create a minimal spec with ADDED entries and a comment:
  `<!-- Auto-generated from code changes. Run /bootstrap for full spec. -->`

Write each merged FR per the `writing` skill.

## Step 6: glossary check

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

## Step 7: report

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
4. Adds `DESIGN.md` and `.impeccable/design.json` when Step 2 refreshed them
5. Outputs minimal detail so it does not interrupt the commit flow

## Spec correction (fix it when you see it)

While reading existing specs to generate deltas, if you notice ANY existing FR that contradicts the code in the diff, fix it immediately.
