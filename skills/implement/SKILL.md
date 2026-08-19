---
name: implement
description: Execute implementation work via the TDD pipeline (test-writer -> task-executor -> task-checker). Claims afk work nodes from the map frontier when a map exists; runs the same discipline directly on the request when none does. A unit of work carries its own size – one node is a quick change, forty is a long effort, and nothing declares which.
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What This Skill Does

Implements work under the TDD pipeline. The unit of work is a map node when a
map exists, and the request itself when none does – same discipline either
way. Progress lives on the tracker as claims and resolutions; there is no
checkbox file to maintain.

## Steps

### 1. Find the Work

Check the configured tracker for maps (`workflow.maps.tracker` in
`spechub/project.yaml`; the map skill's `trackers/` docs declare the
operations – files backend shown below).

**A map exists** (or `$ARGUMENTS` names one):

```bash
~/.claude/spechub/bin/spechub node frontier --map <name> --mode afk --json
```

These are the workable nodes: open, unblocked, and containing no decision.
Pull them regardless of depth – work can hang anywhere, including straight
off the root. If the frontier holds only `hitl` nodes, stop and point the
user at `/spechub:map` – those need a human, not a pipeline.

**No map**: the request in `$ARGUMENTS` is the work item. Same discipline,
no tracker writes. This is the whole quick path – a small change is just a
small unit of work, and nothing has to declare it small.

### 2. Read Project Configuration

Read `spechub/project.yaml` for build/test/lint commands and directory paths.

### 3. Create Feature Branch

Branch from the default branch, named after the map (or a short slug of the
request). If the branch already exists, ask the user whether to continue on
it or start fresh.

### 4. Orient, Then Claim

With a map, orient once per session before claiming:

```bash
~/.claude/spechub/bin/spechub node walk --map <name>
```

The root and pinned nodes carry the destination and standing preferences.
The resolved chain above a work node carries its why – read it before
touching code.

Claim each node as you start it:

```bash
~/.claude/spechub/bin/spechub node update <id> --map <name> --status claimed
```

Nodes describe behaviour, not paths. **Resolve paths at claim time**: before
any code change, dispatch parallel explorer subagents over the relevant code
– as many as there are distinct places to look, not a fixed count – and act
on what they find.

### 5. Execute Within the Claim

The pipeline's state lives inside the claim, not on the node. For each
claimed node (or the bare request), run the Implementation Discipline to
completion:

1. **test-writer subagent** – failing tests from the node's behaviour
   description. Skip for pure config/setup work with no testable behaviour.
2. **task-executor subagent** – make the tests pass. Executor CANNOT modify
   test files.
3. **task-checker subagent** – verify: tests pass, full suite passes, test
   count >= baseline, mock audit, TDD isolation, integration wired, frontend
   visual verification (if applicable).

If the checker fails, route back to the executor with the feedback. If the
work stalls or the session must stop mid-node, release the claim
(`--status open`) – the node is plainly open again, and no phase breadcrumb
is needed.

**Parallelism**: afk nodes run unlimited and in parallel. When 2+ frontier
nodes touch non-overlapping files, launch an Agent Team where each teammate
owns one node and its file set. Otherwise work them sequentially.

### 6. Resolve

When the checker passes, resolve the node in one call:

```bash
~/.claude/spechub/bin/spechub node update <id> --map <name> --status resolved \
  --append-body "## Answer

<what was built, which files, what the tests pin down>"
```

Then:

- Invoke `record-context` – implementation decisions can earn ADRs too.
- Create nodes for anything the work surfaced (a question found mid-build is
  `hitl`, `--answers <this node>`).
- Recompute the frontier – resolutions unblock nodes.

### 7. Build Verification

After each node (and before ending the session), run the commands from
`spechub/project.yaml`: build, full test suite, lint and typecheck. All must
pass before claiming the next node.

### 8. Completion

Stop when the afk frontier is empty, or when only `hitl` nodes remain
(hand those to `/spechub:map`). Report: nodes resolved, tests passing, lines
added/removed. Remind the user: `/commit` to commit – spec sync extracts the
durable record from the diff.

## Key Rules

- **TDD pipeline is mandatory** – test-writer -> task-executor ->
  task-checker. No exceptions except pure config work.
- **Executors CANNOT modify test files** – if tests are wrong, report it.
- **The tracker is the progress record** – claim on start, resolve on pass,
  release on stall. No checkbox files, no phase fields.
- **Explore before writing** – parallel explorer subagents over the relevant
  code, sized to the node, before any edit.
- **Resume is a query** – a fresh session runs the frontier query and
  continues. Never re-read an effort end to end to find where it stopped.
- **Do NOT commit or push** – the user manages git via `/commit`.
