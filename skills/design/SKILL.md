---
name: design
description: Generate the implementation design (architecture, tech approach, research) for an active OpenSpec change. Reads proposal.md, produces design.md and research.md.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## What This Skill Produces

**design.md** and **research.md** — the technical architecture and implementation approach for a change that already has a proposal.md. Translates WHAT/WHY into HOW.

**Output**: `openspec/changes/<name>/design.md` and `openspec/changes/<name>/research.md`

**Prerequisite**: A proposal.md must exist. Run `/propose` first.

## Steps

### 1. Locate the Active Change

If `$ARGUMENTS` specifies a change name, use it. Otherwise:

```bash
openspec list --json
```

If only one active change, use it. If multiple, ask the user.

### 2. Explore the Codebase

Read `openspec/changes/<name>/proposal.md` and `openspec/constitution.md` (if exists), then **launch 3 parallel Explore subagents** in a single message, each with a different strategy:

**Explore 1 — Architecture & Patterns**: Map the current architecture in affected areas. Find actual patterns used (not what docs say — what code does). Trace call chains for every system this feature interacts with. Identify entry points, service boundaries, data flow.

**Explore 2 — Reuse & Deprecation**: Find existing code that can be extended rather than duplicated. Identify code to replace or consolidate. Flag duplicate logic, deprecated patterns, dead code, TODO/FIXME markers in affected areas.

**Explore 3 — Tests & Integration Surface**: Map existing test patterns, fixtures, and utilities in the affected area. Identify integration wiring points (route registration, component imports, config/env). Check living specs for contradictions with actual code (fix per Spec Correction Protocol).

### 3. Draft the Design

Get the design template:

```bash
openspec instructions design --change "<name>" --json
```

Parse `template`, `instruction`, `outputPath`.

Draft the full design content containing:

- **Technical Context** (stack, dependencies, constraints)
- **Constitution Check** (verify against all principles — ERROR if violations unjustified). Skip if no constitution.md exists.
- **Research** (decisions made, rationale, alternatives considered)
- **Architecture** (how components interact, data flow)
- **Data Models** (entities, relationships, validation rules)
- **API Contracts** (endpoints, request/response shapes)
- **Integration Plan** (how this wires into existing systems)

### 4. Present the Draft to the User

**Print the full draft design as markdown in chat.** The user reviews it here — no need to open a file.

Then use the **AskUserQuestion tool** to ask: "Write this design to `openspec/changes/<name>/design.md`? Or provide feedback to revise."

Options: "Write it", "Revise (I'll give feedback)"

If the user wants revisions, incorporate feedback and present again. Repeat until approved.

### 5. Write and Report

Once approved:

1. Write research.md to `openspec/changes/<name>/research.md`
2. Write design.md to the `outputPath`
3. Show status:
   ```bash
   openspec status --change "<name>"
   ```
4. Report: change name, design.md path, research.md path, next step (`/tasks`)

## Anti-Patterns

- **DO NOT** skip the proposal — design requires proposal.md to exist
- **DO NOT** skip the constitution check if constitution.md exists
- **DO NOT** write to disk before the user approves the draft
- **DO NOT** produce task lists or implementation phases — that's `/tasks`
