---
name: propose
description: Propose a new change with deep codebase exploration and feature specification. Uses SpecHub CLI for scaffolding and produces a grounded proposal.md.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## What This Skill Produces

A **proposal.md** file — a feature specification describing WHAT users need and WHY. Not implementation plans, not architecture, not code. Those come later via `/design` and `/tasks`.

**Output**: `spechub/changes/<name>/proposal.md`

## Clarification Level

This skill supports a `--none`, `--critical`, `--thorough`, or `--exhaustive` flag to override the configured clarification level. Parse `$ARGUMENTS` for these flags (remove the flag from the remaining arguments).

If no flag is provided, read the default from `spechub/project.yaml` at `workflow.clarification.propose`. If not set, default to `thorough`.

**Levels**:

| Level | Bar to ask a question |
|-------|----------------------|
| `none` | Never ask. Make informed guesses, use [NEEDS CLARIFICATION] markers. |
| `critical` | Only ask if the answer would fundamentally change scope or architecture. |
| `thorough` | Ask if the answer would meaningfully affect proposal quality. Anything ambiguous or with multiple valid interpretations. |
| `exhaustive` | Ask about anything not explicitly stated. Deep discovery – leave nothing to assumption. |

## Steps

### 1. Explore the Codebase

**Launch an Explore subagent** to investigate:

- **Existing functionality**: What code already exists related to this feature?
- **Living specs**: Read `spechub/specs/*/spec.md` for affected domains. What requirements already exist?
- **Integration points**: Where does this feature connect to existing systems?
- **Domain mapping**: Using `spechub/domain-map.yaml`, identify which domains this feature spans.
- **Spec correction**: If any living spec FR contradicts actual code, fix it per the Spec Correction Protocol.

### 2. Clarify Before Drafting

**Skip this step if clarification level is `none`.**

Based on exploration findings and the user's request, identify questions about requirements, user needs, and scope boundaries where the answer would materially improve the proposal. Apply the configured clarification level to decide what meets the bar.

Present questions using the **AskUserQuestion tool** – batch related questions together (up to 4 per call). For each question:

- Provide 2–4 concrete options with your recommended choice first
- Include a short description explaining why each option matters

After answers come back, assess whether more questions are needed at the current level. Continue until you're confident the remaining ambiguity is below the configured bar, then proceed to drafting.

### 3. Scaffold the Change

Generate a kebab-case short name from the feature description, then:

```bash
spechub new change "<name>"
```

Get the proposal template:

```bash
spechub instructions proposal --change "<name>" --json
```

Parse `template`, `instruction`, `outputPath`. The `context` and `rules` fields are constraints for you — do NOT copy them into the output.

### 4. Draft the Proposal

Using the template, exploration findings, and clarification answers, draft the full proposal content containing:

- **User Stories** (P1/P2/P3 prioritized) with Given/When/Then acceptance scenarios
- **Functional Requirements** (FR-NNN, each testable)
- **Success Criteria** (measurable, technology-agnostic)
- **Key Entities** (if data involved)
- **Assumptions** (reasonable defaults you chose)
- **Scope** (what's in, what's out)

Ground the requirements in reality using exploration findings — reference real integration points, note existing capabilities to preserve.

For aspects not covered during clarification, make informed guesses. Only use [NEEDS CLARIFICATION] markers (max 3) for decisions that significantly impact scope or UX and were not addressed in the clarification step.

### 5. Present the Draft to the User

**Print the full draft proposal as markdown in chat.** The user reviews it right here in the conversation — no need to open a file.

Then use the **AskUserQuestion tool** to ask: "Write this proposal to `spechub/changes/<name>/proposal.md`? Or provide feedback to revise."

Options: "Write it", "Revise (I'll give feedback)"

If the user wants revisions, incorporate their feedback and present the updated draft again. Repeat until approved.

### 6. Write and Report

Once approved:

1. Write proposal.md to the `outputPath`
2. Handle any [NEEDS CLARIFICATION] markers if the user wants to resolve them now
3. Show status:
   ```bash
   spechub status --change "<name>"
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
- **DO NOT** skip `spechub new change` — the change MUST be scaffolded
- **DO NOT** write to disk before the user approves the draft
