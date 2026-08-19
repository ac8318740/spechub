---
name: archive
description: Close out a cleared map – verify the durable residue (living specs, ADRs, glossary) was extracted, then dispose of the nodes per workflow.maps.persist. Also archives legacy spechub/changes/ directories from the pre-map workflow.
argument-hint: "[map or legacy change name]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

A map is scaffolding. It exists to clear fog, and once the fog is gone the
answers belong in living specs, ADRs and the glossary – not in a second copy
that drifts. Archive verifies that extraction happened, then disposes of the
nodes.

## Step 1: Locate the Map

If `$ARGUMENTS` names a map, use it. Otherwise list maps on the configured
tracker (`workflow.maps.tracker`; files backend shown):

```bash
ls spechub/maps/
```

If exactly one, use it. If several, ask. If `$ARGUMENTS` names a legacy
`spechub/changes/` directory instead, jump to Legacy below.

## Step 2: Verify the Map Is Cleared

```bash
~/.claude/spechub/bin/spechub node frontier --map <name> --json
~/.claude/spechub/bin/spechub node list --map <name> --status fog --json
~/.claude/spechub/bin/spechub node list --map <name> --status claimed --json
```

All three must be empty. If not, WARN with what remains and ask for
confirmation – archiving an uncleared map throws away open questions.

## Step 3: Extract the Residue

Walk the resolved nodes (`spechub node walk --map <name> --full`) and check
each resolution left what it should have:

1. **Living specs** – behaviour the effort built should already be in
   `spechub/specs/` via commit-time sync. Spot-check the affected domains;
   fix gaps on sight per the Spec Correction Protocol.
2. **ADRs and glossary** – invoke `record-context` for any resolved decision
   that meets the bar but was never recorded. This is the last chance.
3. **Out-of-scope nodes** – report them; a scope boundary is worth the user
   hearing once more before the map disappears.

## Step 4: Dispose of the Nodes

`workflow.maps.persist` in `spechub/project.yaml` decides (default `false`):

| Value             | Action                                                       |
| ----------------- | ------------------------------------------------------------ |
| `false` (default) | delete `spechub/maps/<name>/`                                 |
| `true`            | move the nodes to `spechub/archive/[YYYY-MM-DD]-[name]/nodes/` |

Default is delete because keeping the nodes leaves a second copy of every
decision, and the two drift. On the GitHub tracker there is nothing to
dispose – closed issues are already the archive.

## Step 5: Report

- Nodes resolved / out-of-scope counts
- Residue: domains spot-checked, ADRs and glossary entries written
- Disposal: deleted, or archive path
- Reminder: commit with `/commit`

## Legacy: archiving a `spechub/changes/` directory

Changes created by the pre-map workflow (proposal.md / design.md / tasks.md)
still archive the old way, so an upgrade never strands work:

1. Read the change's artifacts and derive affected domains from file paths in
   `tasks.md` via `spechub/domain-map.yaml`.
2. For each domain, merge what the feature ADDED, MODIFIED or REMOVED into
   `spechub/specs/[domain]/spec.md`.
3. Write a `delta.md` summarising those entries, copy the artifacts to
   `spechub/archive/[YYYY-MM-DD]-[change-name]/`, and remove the change from
   `spechub/changes/` (the CLI's `spechub archive <name>` does the move).
