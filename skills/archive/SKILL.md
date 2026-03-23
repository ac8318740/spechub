---
name: archive
description: Archive a completed OpenSpec change, merge deltas into living specs, and move artifacts to the archive directory.
argument-hint: "[change-name]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

Archive a completed change's artifacts and update the cumulative living specs with any changes the feature introduced.

## Step 1: Locate the Change

1. If `$ARGUMENTS` provided: Use as change name
2. If no arguments: Run `openspec list --json` to find active changes
3. If only one active change, use it. If multiple, ask the user.
4. Verify directory exists at `openspec/changes/<name>/`
5. Read `openspec/changes/<name>/tasks.md` — if many tasks incomplete, WARN user and ask for confirmation

## Step 2: Check Artifact Status

```bash
openspec status --change "<name>" --json
```

Parse to check if all artifacts are `done`. If any incomplete, warn and ask for confirmation.

## Step 3: Generate Delta

Read the change's artifacts and the current living specs.

For each domain affected (determine from file paths in tasks.md mapped via `openspec/domain-map.yaml`):

1. Read current living spec at `openspec/specs/[domain]/spec.md`
2. Analyze what the feature added, modified, or removed
3. Generate delta:

```markdown
# Delta: [Feature Name]
# Date: [YYYY-MM-DD]
# Source: openspec/changes/[change-name]/

## Domain: [domain-name]

### ADDED Requirements
- FR-NEW-NNN: [Description]
  - Source: [file path]

### MODIFIED Requirements
- FR-NNN: [Updated description] (was: [old description])
  - Reason: [why changed]

### REMOVED Requirements
- FR-NNN: [Description] (reason: [why removed])
```

## Step 4: Merge Deltas into Living Specs

For each affected domain:

1. Read `openspec/specs/[domain]/spec.md`
2. Apply ADDED — append new FR-NNN entries with next available number
3. Apply MODIFIED — update existing FR-NNN in place
4. Apply REMOVED — delete the FR-NNN entry
5. Write updated spec back

## Step 5: Update Documentation

**After merging deltas, update project documentation if warranted.**

Skip for pure config/infra/internal refactors with no user-facing changes.

If docs updates are warranted, launch a subagent to update docs/ (if it exists) with:
- New or changed user-facing behavior
- API changes
- Configuration changes
- Architecture changes for developer docs

## Step 6: Archive Change Artifacts

1. Create: `openspec/archive/[YYYY-MM-DD]-[change-name]/`
2. Copy from change directory: all artifacts
3. Write generated `delta.md` to archive directory
4. Remove the change from `openspec/changes/`

## Step 7: Report

- Archive location
- Domains updated (N added, N modified, N removed per domain)
- Docs updated (list files changed, or "skipped")
- Reminder: commit with `/commit`
