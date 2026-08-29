---
name: bootstrap
description: Multi-pass AI crawl to generate initial living specs from the existing codebase. Use when spechub/specs/ domains need their initial spec.md files bootstrapped from code.
argument-hint: "[domain-names (optional)]"
disable-model-invocation: true
---

## User input

```text
$ARGUMENTS
```

Consider the user input before you proceed, if it is not empty.

## Purpose

This skill bootstraps cumulative living specs in `spechub/specs/`. It crawls the existing codebase with multiple independent AI passes. It then merges the passes and validates the results.

**IMPORTANT**: This is a one-time bootstrapping operation. Only run when `spechub/specs/` domains have no `spec.md` files yet.

## Your role: orchestrator only

**You do NOT read code, explore the codebase, or write specs yourself.**

Your job is to:

1. Run the pre-flight check (read domain-map.yaml)
2. Launch subagents with the prompts below
3. Pass outputs from one phase to the next
4. Present summaries to the user for review
5. Coordinate the phases sequentially

## Pre-flight check

1. Read `spechub/domain-map.yaml` to get the list of domains and their file path mappings.
2. If `$ARGUMENTS` specifies domain names, filter to only those domains.
3. Check if any `spechub/specs/*/spec.md` files already exist:
    - If specs exist, warn the user. Ask for confirmation before overwriting.
    - If no specs exist, proceed automatically.

## Phase 1: independent exploration (passes 1-3)

Launch **3 parallel subagents** (`subagent_type=Explore`) in a single message. Each gets a different exploration strategy:

### Pass 1 – entry points strategy

Explore from entry points (main files, route handlers, API endpoints, page components) to discover functionality domain by domain.

### Pass 2 – data models strategy

Explore from data models outward (database models, schemas, interfaces) to map data flow from storage through services to API to UI.

### Pass 3 – tests strategy

Explore from test files to understand expected behaviors by reading test names, assertions, and cross-referencing with source code.

Each pass outputs domain drafts using this format:

```markdown
# [Domain Name] - Living Specification

## Overview
[1-2 paragraph description]

## Key Entities
[List major classes, services, models]

## Functional Requirements

### FR-001: [Requirement Name]
- **Description**: [What the system does]
- **Behavior**: Given [precondition], When [action], Then [result]
- **Source**: [File path where this is implemented]

### FR-002: ...
```

Write each functional requirement (FR) per the `writing` skill.

```markdown
## Integration Points
## Configuration
## Constraints & Invariants
```

## Phase 2: judge merge (pass 4)

Launch a single subagent to merge the 3 independent drafts per domain. It resolves conflicts, deduplicates, and picks the most accurate description for each FR.

## Phase 3: validation (passes 5-7)

Launch 3 parallel Explore subagents to validate ALL domains independently – each checks that FRs match actual code behavior.

## Phase 4: correction merge (pass 8)

Launch a single subagent to apply validated corrections from Phase 3.

## Phase 5: human review (pass 9)

Present a summary to the user. Ask: "Review the specs in `spechub/specs/`. Want to edit any domain before finalizing?"

## Phase 6: finalization (pass 10)

Launch a single subagent to finalize all specs. It removes markers, makes sure the formatting is consistent, and re-numbers FR entries.

## Completion

Report: the number of domain specs created, the total functional requirements, and the suggested next step.
