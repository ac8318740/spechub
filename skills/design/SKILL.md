---
name: design
description: Generate the implementation design (architecture, tech approach, research) for an active SpecHub change. Reads proposal.md, produces design.md and research.md.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## What This Skill Produces

**design.md** and **research.md** — the technical architecture and implementation approach for a change that already has a proposal.md. Translates WHAT/WHY into HOW.

**Output**: `spechub/changes/<name>/design.md` and `spechub/changes/<name>/research.md`

**Prerequisite**: A proposal.md must exist. Run `/propose` first.

## Clarification Level

This skill supports a `--none`, `--critical`, `--thorough`, or `--exhaustive` flag to override the configured clarification level. Parse `$ARGUMENTS` for these flags (remove the flag from the remaining arguments).

If no flag is provided, read the default from `spechub/project.yaml` at `workflow.clarification.design`. If not set, default to `thorough`.

**Levels**:

| Level | Bar to ask a question |
|-------|----------------------|
| `none` | Never ask. Decide all technical choices yourself. |
| `critical` | Only ask if the answer would fundamentally change the architecture. |
| `thorough` | Ask if the answer would meaningfully affect the design. Ambiguous technical choices or multiple valid patterns. |
| `exhaustive` | Ask about every non-trivial technical decision. Leave no assumption unchecked. |

## Steps

### 1. Locate the Active Change

If `$ARGUMENTS` specifies a change name, use it. Otherwise:

```bash
spechub list --json
```

If only one active change, use it. If multiple, ask the user.

### 2. Explore the Codebase

Read `spechub/changes/<name>/proposal.md` and `spechub/constitution.md` (if exists), then **launch 3 parallel Explore subagents** in a single message, each with a different strategy:

**Explore 1 — Architecture & Patterns**: Map the current architecture in affected areas. Find actual patterns used (not what docs say — what code does). Trace call chains for every system this feature interacts with. Identify entry points, service boundaries, data flow.

**Explore 2 — Reuse & Deprecation**: Find existing code that can be extended rather than duplicated. Identify code to replace or consolidate. Flag duplicate logic, deprecated patterns, dead code, TODO/FIXME markers in affected areas.

**Explore 3 — Tests & Integration Surface**: Map existing test patterns, fixtures, and utilities in the affected area. Identify integration wiring points (route registration, component imports, config/env). Check living specs for contradictions with actual code (fix per Spec Correction Protocol).

### 3. Clarify Before Drafting

**Skip this step if clarification level is `none`.**

Based on exploration findings and the proposal, identify questions about technical preferences, constraints, and patterns where the answer would materially improve the design. Apply the configured clarification level to decide what meets the bar.

Examples: framework/library choices, database technology, auth approach, API style (REST vs GraphQL), deployment targets, performance constraints, patterns to follow or avoid.

Present questions using the **AskUserQuestion tool** – batch related questions together (up to 4 per call). For each question:

- Provide 2–4 concrete options with your recommended choice first
- Include a short description explaining the trade-offs

After answers come back, assess whether more questions are needed at the current level. Continue until you're confident the remaining ambiguity is below the configured bar, then proceed to drafting.

### 4. Draft the Design

Get the design template:

```bash
spechub instructions design --change "<name>" --json
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

### 5. Present the Draft to the User

**Print the full draft design as markdown in chat.** The user reviews it here — no need to open a file.

Then use the **AskUserQuestion tool** to ask: "Write this design to `spechub/changes/<name>/design.md`? Or provide feedback to revise."

Options: "Write it", "Revise (I'll give feedback)"

If the user wants revisions, incorporate feedback and present again. Repeat until approved.

### 6. Write and Report

Once approved:

1. Write research.md to `spechub/changes/<name>/research.md`
2. Write design.md to the `outputPath`
3. Show status:
   ```bash
   spechub status --change "<name>"
   ```
4. Report: change name, design.md path, research.md path, next step (`/tasks`)

## Anti-Patterns

- **DO NOT** skip the proposal — design requires proposal.md to exist
- **DO NOT** skip the constitution check if constitution.md exists
- **DO NOT** write to disk before the user approves the draft
- **DO NOT** produce task lists or implementation phases — that's `/tasks`
