---
name: archive
description: Close out a cleared map – one whose frontier is empty with no fog and no claims left – by verifying the durable residue, meaning what the effort leaves behind in living specs, ADRs and the glossary, was extracted, then disposing of the nodes per workflow.maps.persist. Invoke when a map has just been cleared, when the last node on a map resolves, or when the user asks to archive or close out a map. Refuses and asks first if anything is still open. Also archives legacy spechub/changes/ directories from the pre-map workflow.
argument-hint: "[map or legacy change name]"
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

A map is scaffolding. It exists to clear fog – the questions that could not
be stated precisely when the effort started – and once the fog is gone the
answers belong in living specs, ADRs and the glossary, not in a second copy
that drifts. That is the residue: what survives the map. Archive verifies the
residue was extracted, then disposes of the nodes.

## Step 1: Locate the Map

If `$ARGUMENTS` names a map, use it. Otherwise list maps on the configured
tracker (`workflow.maps.tracker`): `ls spechub/maps/` on the files backend,
`gh label list --search "map:" --json name` on GitHub.

If exactly one, use it. If several, ask. If `$ARGUMENTS` names a legacy
`spechub/changes/` directory instead, jump to Legacy below.

## Step 2: Verify the Map Is Cleared

A map is cleared when nothing is left to work: no open nodes, no fog, no
claims. Check all three on the files backend:

```bash
~/.claude/spechub/bin/spechub node list --map <name> --status open --json
~/.claude/spechub/bin/spechub node list --map <name> --status fog --json
~/.claude/spechub/bin/spechub node list --map <name> --status claimed --json
```

On GitHub, compose the same checks per `trackers/github.md` in the map skill:
`gh issue list --label "map:<name>" --state open` must be empty (an open
issue is open, fog or claimed – all three fail the gate). Never run the files
commands against a GitHub-tracked map; they return empty because the
directory does not exist, and the gate would pass vacuously.

All three must be empty. Open nodes are counted directly rather than through
the frontier query, because the frontier only lists nodes with no unresolved
blockers. Two open nodes that block each other therefore show an empty
frontier while both questions are still open – so an empty frontier is not
proof the map is cleared. If anything remains, WARN with what it is and ask
for confirmation – archiving an uncleared map throws away open questions.

## Step 3: Extract the Residue

Walk the resolved nodes – read them in order, root first, then each node that
hangs off it (`spechub node walk --map <name> --full` on files; compose the
walk per `trackers/github.md` on GitHub). Check each resolution left what it
should have:

1. **Living specs** – behaviour the effort built should already be in
   `spechub/specs/` via commit-time sync. Spot-check the affected domains;
   fix gaps on sight per the Spec Correction Protocol.
2. **ADRs and glossary** – invoke `record-context` for any resolved decision
   that meets the bar but was never recorded. This is the last chance.
3. **Out-of-scope nodes** – report them; a scope boundary is worth the user
   hearing once more before the map disappears.

## Step 4: Dispose of the Nodes

**Confirm first when you invoked this yourself.** A user who typed
`/spechub:archive` has already asked for disposal – proceed. If you reached
this skill on your own, because a map just cleared, state what will be deleted
or moved and wait for the user's go-ahead. Deletion is irreversible and they
never asked for it.

`workflow.maps.persist` in `spechub/project.yaml` decides (default `false`):

| Value             | Action                                                       |
| ----------------- | ------------------------------------------------------------ |
| `false` (default) | delete `spechub/maps/<name>/`                                 |
| `true`            | move the nodes to `spechub/archive/[YYYY-MM-DD]-[name]/nodes/` |

Default is delete because keeping the nodes leaves a second copy of every
decision, and the two drift. On the GitHub tracker there is nothing to
dispose – closed issues are already the archive.

Also dispose of `spechub/handoffs/<name>/` if it exists. Consumed handoffs
hold conversation content and should not outlive the map they served.

## Step 5: Report

- Nodes resolved / out-of-scope counts
- Residue: domains spot-checked, ADRs and glossary entries written
- Disposal: deleted, or archive path
- Reminder: commit with `/spechub:commit`

## Legacy: archiving a `spechub/changes/` directory

Changes created by the pre-map workflow (proposal.md / design.md / tasks.md)
still archive the old way, so an upgrade never strands work:

1. Read the change's artifacts and derive affected domains from file paths in
   `tasks.md` via `spechub/domain-map.yaml`.
2. For each domain, merge what the feature ADDED, MODIFIED or REMOVED into
   `spechub/specs/[domain]/spec.md`.
3. Write a `delta.md` into the change directory, then run the CLI's
   `spechub archive <name>` – it moves the artifacts (delta included) to
   `spechub/changes/archive/[YYYY-MM-DD]-[change-name]/` and removes the
   change from `spechub/changes/`.
