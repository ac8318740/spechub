---
name: tasks
description: Generate an actionable, dependency-ordered tasks.md for the active OpenSpec change based on proposal and design artifacts.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## What This Skill Produces

A **tasks.md** file — a dependency-ordered checklist of implementation tasks referencing real files and integration points.

**Output**: `openspec/changes/<name>/tasks.md`

**Prerequisite**: A proposal.md must exist. design.md is optional but recommended.

## Steps

### 1. Locate the Active Change

If `$ARGUMENTS` specifies a change name, use it. Otherwise:

```bash
openspec list --json
```

If only one active change, use it. If multiple, ask the user.

### 2. Explore the Codebase

Read proposal.md and design.md (if exists) from `openspec/changes/<name>/`, then **launch 3 parallel Explore subagents** in a single message, each with a different strategy:

**Explore 1 — File Inventory**: List actual files that exist today in all affected areas. For each file, note its size and purpose. Tasks must reference real paths, not hypothetical ones.

**Explore 2 — Modification vs Creation**: For each component in the design, determine whether it's a NEW file or MODIFICATION to an existing file. Identify deprecation cleanup needed — duplicated logic, deprecated patterns, dead code to remove.

**Explore 3 — Integration Wiring**: Identify every integration point that needs wiring — route registration, component imports, service injection, config/env additions, database migrations. Check living specs for contradictions with actual code (fix per Spec Correction Protocol).

### 3. Draft the Tasks

Get the task template:

```bash
openspec instructions tasks --change "<name>" --json
```

Parse `template`, `instruction`, `outputPath`.

Draft the full tasks.md content organized by user story:

- **Phase 1**: Setup (project initialization)
- **Phase 2**: Foundational (blocking prerequisites)
- **Phase 3+**: One phase per user story in priority order
- **Final Phase**: Polish & cross-cutting concerns
- Include a task to update specs via `/archive` after implementation

Every task must follow the checklist format (see Task Generation Rules below).

### 4. Present the Draft to the User

**Print the full draft tasks.md as markdown in chat.** The user reviews it here — no need to open a file.

Then use the **AskUserQuestion tool** to ask: "Write this task list to `openspec/changes/<name>/tasks.md`? Or provide feedback to revise."

Options: "Write it", "Revise (I'll give feedback)"

If the user wants revisions, incorporate feedback and present again. Repeat until approved.

### 5. Write and Report

Once approved:

1. Write tasks.md to the `outputPath`
2. Show status:
   ```bash
   openspec status --change "<name>"
   ```
3. Report: path to tasks.md, total task count, tasks per story, parallel opportunities, suggested MVP scope

## Anti-Patterns

- **DO NOT** reference hypothetical file paths — every path must come from exploration
- **DO NOT** write to disk before the user approves the draft
- **DO NOT** skip the OpenSpec CLI steps (`openspec instructions tasks`)

## Task Generation Rules

**CRITICAL**: Tasks MUST be organized by user story to enable independent implementation and testing.

### Checklist Format (REQUIRED)

```text
- [ ] [TaskID] [P?] [Story?] Description with file path
```

1. **Checkbox**: ALWAYS `- [ ]`
2. **Task ID**: Sequential (T001, T002...)
3. **[P] marker**: Only if parallelizable
4. **[Story] label**: [US1], [US2], etc. — required for user story phases, not for setup/foundational/polish
5. **Description**: Clear action with exact file path

### Phase Structure

- **Phase 1**: Setup (project initialization)
- **Phase 2**: Foundational (MUST complete before user stories)
- **Phase 3+**: User Stories in priority order (P1, P2, P3...)
- **Final Phase**: Polish & Cross-Cutting Concerns
