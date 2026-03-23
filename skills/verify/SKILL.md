---
name: verify
description: Perform a non-destructive cross-artifact consistency and quality analysis across proposal.md, design.md, and tasks.md after task generation.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Goal

Identify inconsistencies, duplications, ambiguities, and underspecified items across the three core artifacts (`proposal.md`, `design.md`, `tasks.md`) before implementation. This command MUST run only after `/tasks` has successfully produced a complete `tasks.md`.

## Operating Constraints

**STRICTLY READ-ONLY**: Do **not** modify any files. Output a structured analysis report.

**Constitution Authority**: If `openspec/constitution.md` exists, it is **non-negotiable** within this analysis scope.

## Execution Steps

### 1. Locate the Active Change

If `$ARGUMENTS` specifies a change name, use it. Otherwise:

```bash
openspec list --json
```

If only one active change, use it. If multiple, ask user.

### 2. Load Artifacts

**From proposal.md:** Overview, Functional Requirements, Non-Functional Requirements, User Stories, Edge Cases
**From design.md:** Architecture/stack choices, Data Model, Phases, Technical constraints
**From tasks.md:** Task IDs, Descriptions, Phase grouping, Parallel markers, File paths
**From constitution:** Load `openspec/constitution.md` for principle validation (if exists)

### 3. Detection Passes

#### A. Duplication Detection
#### B. Ambiguity Detection
#### C. Underspecification
#### D. Constitution Alignment (if constitution exists)
#### E. Coverage Gaps
#### F. Inconsistency

### 4. Severity Assignment

- **CRITICAL**: Violates constitution MUST, missing core artifact, requirement with zero coverage
- **HIGH**: Duplicate/conflicting requirement, ambiguous security/performance attribute
- **MEDIUM**: Terminology drift, missing non-functional task coverage
- **LOW**: Style/wording improvements

### 5. Produce Compact Analysis Report

Output a Markdown report with findings table, coverage summary, constitution alignment, unmapped tasks, and metrics.

### 6. Provide Next Actions

- If CRITICAL issues: Recommend resolving before implementation
- If only LOW/MEDIUM: User may proceed
- Provide explicit command suggestions

### 7. Offer Remediation

Ask: "Would you like me to suggest concrete remediation edits for the top N issues?"

## Operating Principles

- **NEVER modify files** (read-only analysis)
- **NEVER hallucinate missing sections**
- **Prioritize constitution violations** (always CRITICAL)
- **Report zero issues gracefully**
