---
name: clarify
description: Identify underspecified areas in the current change's proposal by asking up to 5 highly targeted clarification questions and encoding answers back into the spec.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

Goal: Detect and reduce ambiguity or missing decision points in the active change's proposal and record the clarifications directly in the proposal file.

Note: This clarification workflow is expected to run (and be completed) BEFORE invoking `/design`.

Execution steps:

1. **Locate the active change**:

   If `$ARGUMENTS` specifies a change name, use it. Otherwise:

   ```bash
   openspec list --json
   ```

   If only one active change exists, use it. If multiple, ask the user.

   Read `openspec/changes/<name>/proposal.md` as the feature spec.

   If proposal.md doesn't exist, instruct user to run `/propose` first.

2. Load the current spec file. Perform a structured ambiguity & coverage scan using this taxonomy. For each category, mark status: Clear / Partial / Missing. Produce an internal coverage map.

   Functional Scope & Behavior:
   - Core user goals & success criteria
   - Explicit out-of-scope declarations
   - User roles / personas differentiation

   Domain & Data Model:
   - Entities, attributes, relationships
   - Identity & uniqueness rules
   - Lifecycle/state transitions

   Interaction & UX Flow:
   - Critical user journeys / sequences
   - Error/empty/loading states

   Non-Functional Quality Attributes:
   - Performance, Scalability, Reliability, Observability, Security, Compliance

   Integration & External Dependencies:
   - External services/APIs and failure modes
   - Data import/export formats

   Edge Cases & Failure Handling:
   - Negative scenarios, rate limiting, conflict resolution

   Constraints & Tradeoffs:
   - Technical constraints, explicit tradeoffs

   Terminology & Consistency:
   - Canonical glossary terms

3. Generate (internally) a prioritized queue of candidate clarification questions (maximum 5). Apply these constraints:
   - Maximum of 10 total questions across the whole session.
   - Each question must be answerable with EITHER:
     - A short multiple-choice selection (2-5 options), OR
     - A short-phrase answer (<=5 words)
   - Only include questions whose answers materially impact architecture, data modeling, task decomposition, test design, UX behavior, operational readiness, or compliance.

4. Sequential questioning loop (interactive):
   - Present EXACTLY ONE question at a time.
   - For multiple-choice: present **recommended option** prominently, then all options as a table.
   - For short-answer: provide your **suggested answer**.
   - After user answers, record and move to next.
   - Stop when: all critical ambiguities resolved, user signals completion, or 5 questions asked.

5. Integration after EACH accepted answer:
   - Ensure a `## Clarifications` section exists
   - Append bullet: `- Q: <question> -> A: <final answer>`
   - Apply clarification to the most appropriate section(s)
   - Save the proposal file after each integration

6. Validation (after each write plus final pass):
   - Clarifications section contains exactly one bullet per accepted answer
   - No contradictory earlier statement remains
   - Markdown structure valid

7. Write the updated proposal back to `openspec/changes/<name>/proposal.md`.

8. Report completion:
   - Number of questions asked & answered
   - Path to updated proposal
   - Sections touched
   - Coverage summary table
   - Suggested next command (`/design`)

Behavior rules:

- If no meaningful ambiguities found, respond: "No critical ambiguities detected." and suggest proceeding.
- Never exceed 5 total asked questions.
- Respect user early termination signals ("stop", "done", "proceed").
