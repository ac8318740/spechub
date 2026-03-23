---
name: bootstrap
description: Multi-pass AI crawl to generate initial living specs from the existing codebase. Use when openspec/specs/ domains need their initial spec.md files bootstrapped from code.
argument-hint: "[domain-names (optional)]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

Bootstrap cumulative living specs in `openspec/specs/` by crawling the existing codebase with multiple independent AI passes, then merging and validating the results.

**IMPORTANT**: This is a one-time bootstrapping operation. Only run when `openspec/specs/` domains have no `spec.md` files yet.

## Your Role: ORCHESTRATOR ONLY

**You do NOT read code, explore the codebase, or write specs yourself.**

Your job is to:

1. Run the pre-flight check (read domain-map.yaml)
2. Launch subagents with the prompts below
3. Pass outputs from one phase to the next
4. Present summaries to the user for review
5. Coordinate the phases sequentially

## Pre-flight Check

1. Read `openspec/domain-map.yaml` to get the list of domains and their file path mappings.
2. If `$ARGUMENTS` specifies domain names, filter to only those domains.
3. Check if any `openspec/specs/*/spec.md` files already exist:
   - If specs exist: WARN the user and ask for confirmation before overwriting.
   - If no specs exist: Proceed automatically.

## Phase 1: Independent Exploration (Passes 1-3)

Launch **3 parallel subagents** (`subagent_type=Explore`) in a single message. Each gets a different exploration strategy:

### Pass 1 — Entry Points Strategy

Explore from entry points (main files, route handlers, API endpoints, page components) to discover functionality domain by domain.

### Pass 2 — Data Models Strategy

Explore from data models outward (database models, schemas, interfaces) to map data flow from storage through services to API to UI.

### Pass 3 — Tests Strategy

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

## Integration Points
## Configuration
## Constraints & Invariants
```

## Phase 2: Judge Merge (Pass 4)

Launch a single subagent to merge the 3 independent drafts per domain — resolve conflicts, deduplicate, pick the most accurate description for each FR.

## Phase 3: Validation (Passes 5-7)

Launch 3 parallel Explore subagents to validate ALL domains independently — each checks that FRs match actual code behavior.

## Phase 4: Correction Merge (Pass 8)

Launch a single subagent to apply validated corrections from Phase 3.

## Phase 5: Human Review (Pass 9)

Present summary to user. Ask: "Review the specs in `openspec/specs/`. Want to edit any domain before finalizing?"

## Phase 6: Finalization (Pass 10)

Launch a single subagent to finalize all specs — remove markers, ensure consistent formatting, re-number FR entries.

## Completion

Report: number of domain specs created, total functional requirements, suggested next step.
