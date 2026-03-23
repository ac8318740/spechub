---
name: propose
description: Propose a new change with deep codebase exploration and feature specification. Uses OpenSpec CLI for scaffolding and produces a grounded proposal.md.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## What This Skill Produces

A **proposal.md** file — a feature specification describing WHAT users need and WHY. Not implementation plans, not architecture, not code. Those come later via `/design` and `/tasks`.

**Output**: `openspec/changes/<name>/proposal.md`

## Steps

### 1. Explore the Codebase

**Launch an Explore subagent** to investigate:

- **Existing functionality**: What code already exists related to this feature?
- **Living specs**: Read `openspec/specs/*/spec.md` for affected domains. What requirements already exist?
- **Integration points**: Where does this feature connect to existing systems?
- **Domain mapping**: Using `openspec/domain-map.yaml`, identify which domains this feature spans.
- **Spec correction**: If any living spec FR contradicts actual code, fix it per the Spec Correction Protocol.

### 2. Scaffold the Change

Generate a kebab-case short name from the feature description, then:

```bash
openspec new change "<name>"
```

Get the proposal template:

```bash
openspec instructions proposal --change "<name>" --json
```

Parse `template`, `instruction`, `outputPath`. The `context` and `rules` fields are constraints for you — do NOT copy them into the output.

### 3. Draft the Proposal

Using the template and exploration findings, draft the full proposal content containing:

- **User Stories** (P1/P2/P3 prioritized) with Given/When/Then acceptance scenarios
- **Functional Requirements** (FR-NNN, each testable)
- **Success Criteria** (measurable, technology-agnostic)
- **Key Entities** (if data involved)
- **Assumptions** (reasonable defaults you chose)
- **Scope** (what's in, what's out)

Ground the requirements in reality using exploration findings — reference real integration points, note existing capabilities to preserve.

For unclear aspects, make informed guesses. Only use [NEEDS CLARIFICATION] markers (max 3) for decisions that significantly impact scope or UX.

### 4. Present the Draft to the User

**Print the full draft proposal as markdown in chat.** The user reviews it right here in the conversation — no need to open a file.

Then use the **AskUserQuestion tool** to ask: "Write this proposal to `openspec/changes/<name>/proposal.md`? Or provide feedback to revise."

Options: "Write it", "Revise (I'll give feedback)"

If the user wants revisions, incorporate their feedback and present the updated draft again. Repeat until approved.

### 5. Write and Report

Once approved:

1. Write proposal.md to the `outputPath`
2. Handle any [NEEDS CLARIFICATION] markers if the user wants to resolve them now
3. Show status:
   ```bash
   openspec status --change "<name>"
   ```
4. Report: change name, proposal path, next step (`/clarify` or `/design`)

## Proposal Content Rules

- Focus on **WHAT** users need and **WHY**
- **NO** implementation details — no architecture, components, APIs, frameworks, libraries
- Written so a non-developer could understand the feature
- Every requirement must be testable with Given/When/Then
- Success criteria must be measurable, technology-agnostic, user-focused
- Maximum 3 [NEEDS CLARIFICATION] markers

## Anti-Patterns

- **DO NOT** produce architecture diagrams or component trees — that's `/design`
- **DO NOT** list implementation phases or tasks — that's `/tasks`
- **DO NOT** skip `openspec new change` — the change MUST be scaffolded
- **DO NOT** write to disk before the user approves the draft
