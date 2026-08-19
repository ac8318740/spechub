---
name: map
description: The entry point for planned work. Charts a map if none exists – one opening grill that fixes the destination and surfaces the fog – and works the frontier if one does. No tiers and no routing – the graph is however big the fog made it, and nothing declares which.
argument-hint: "[map name, or the request to chart]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

# Map

## Tracker

Nodes live behind a pluggable tracker. A backend declares four operations –
create, read, update, list – and everything else (frontier, claim, resolve,
walk) is composed from them. Two backends ship, each declared in this skill's
directory:

| Backend | Doc | When |
| ------- | --- | ---- |
| GitHub issues | `trackers/github.md` | first choice when `gh` is authenticated against a GitHub remote |
| Files | `trackers/files.md` | the fallback – no auth, offline, any remote |

`workflow.maps.tracker` in `spechub/project.yaml` (`github` or `files`) records
the project's choice. If set, read the matching doc and use its operations. If
unset, pick at materialisation time: recommend `github` when the repo qualifies,
`files` otherwise, confirm with the user, and write the key so later sessions
need not re-decide.

## Which mode

One command, two modes, picked by what exists. Check the configured tracker
for existing maps – `ls spechub/maps/` on the files backend,
`gh label list --search "map:" --json name` on GitHub. If `$ARGUMENTS` names a map, or
exactly one exists, work its frontier. If none exists, chart. If several exist
and `$ARGUMENTS` does not pick one, ask.

There are no tiers and no complexity judgement. One question is a small map or
no map at all; fifty questions is a long effort. Nothing declares which.

## Charting

1. **Fix the destination first.** Grill for what done looks like (invoke the
   `grilling` skill). The destination is the root of everything that follows –
   settle it before any other question.
2. **Open with a breadth-first grill.** Work the conversation frontier in
   rounds per the grilling skill. Explore the codebase for facts as you go –
   facts are your job, never the user's.
3. **Apply the fog test to what surfaced.** A question that can be stated
   precisely now is `open`. One that cannot is `fog` – record it without
   forcing it sharp. The test is whether it can be *stated* precisely, not
   whether it can be answered.

### Progressive materialisation

The machinery appears only when it has to persist. After the opening grill:

- **No fog surfaced** – the way was already clear. No map. Say so and proceed
  to the work.
- **At most one session's worth** – settle it in conversation. Invoke
  `record-context` on each decision. No map – there is nothing to resume.
- **More than one session's worth** – materialise the map and work the
  frontier across sessions.

The test is mechanical: will the fog outlive this session?

### Materialising

Pick the tracker (see Tracker above), then create the nodes with its `create`
operation. First the root:

```bash
# files backend – github.md has the equivalent
~/.claude/spechub/bin/spechub node create --map <name> --title "<destination>" \
  --status resolved --kind grilling --body "<the destination, as settled>"
```

- The root is the destination, already resolved. It is implicitly pinned –
  every session orients to it.
- Standing preferences for the effort (style rules, constraints discovered in
  the grill) become a resolved node with `--answers <root id> --kind notes
  --pinned`.
- Every other surfaced question becomes a node: `open` or `fog` per the fog
  test, `--answers <id>` naming the node whose resolution surfaced it,
  `--blocked-by` only where one genuinely cannot be settled before another.
- `mode` defaults to `hitl`. `afk` must be earned by a node containing no
  decision – research, or work whose questions are all settled. Getting this
  wrong means an agent quietly deciding something that was the human's.
- Nodes describe behaviour, not file paths. A node can sit on the frontier for
  weeks while the codebase moves – paths are resolved at claim time.
- On the files backend, suggest adding `spechub/maps/` to `.gitignore`. Nodes
  are transient working state, like `spechub/HANDOFF.md` – the durable output
  is specs, ADRs and glossary entries, extracted as nodes resolve.

## Working the frontier

All commands below are the files backend's shape – on GitHub, compose the
same queries per `trackers/github.md`.

1. **Orient.** The packaging walk (`spechub node walk --map <name>`) – the
   root and pinned nodes in full, everything else gisted. Zoom with
   `node read <id>` when a gist turns out to be relevant. Do not load every
   body. Also check `node list --map <name> --status claimed` – a claim left
   by a dead session hides its node from the frontier forever. If a claim
   exists and no other session is known to be working it, ask the user and
   release it (`--status open`).
2. **Query the frontier.** `spechub node frontier --map <name>` – open nodes
   with no unresolved blockers, shallowest provenance depth first, number
   only as a tiebreak.
3. **Route by `mode` – the only field the machine routes on** (`kind` is
   advisory):
   - `hitl` nodes: run grilling rounds over them. A round is the whole hitl
     frontier.
   - `afk` nodes: claim and run without the user. Unlimited, and in parallel
     when independent. Research goes to `Explore` subagents, with the findings
     written into the resolution. Implementation work follows
     `/spechub:implement`'s procedure – it owns the claim-execute-resolve
     flow, the explorer dispatch, and the TDD pipeline. Do not restate that
     flow here; invoke it.
4. **Claim, then resolve** – `afk` nodes only; `hitl` resolutions happen
   inside the grilling round, no claim step. Both are compositions over
   `update`:

   ```bash
   ~/.claude/spechub/bin/spechub node update <id> --map <name> --status claimed
   ~/.claude/spechub/bin/spechub node update <id> --map <name> --status resolved \
     --append-body "## Answer

   <what was decided or done, and why>"
   ```

   The pipeline's state lives inside the claim, not on the node – there is no
   phase field to maintain. If the work stalls or fails, release the claim
   (`--status open`) and the node is plainly open again.
5. **After every resolution**: invoke `record-context`, create nodes for
   anything the resolution surfaced, then recompute the frontier. A shallow
   node arriving late jumps the queue – that is correct, something big just
   opened up.
6. **Graduate fog as it sharpens.** When a fog node can now be stated
   precisely, `update <id> --status open` – one field, one write. Rewrite the
   title and body to the sharp statement if they drifted.

Never filter on leaf position or "has a resolved question above it". Work
nodes can hang anywhere, including straight off the root – a bug is work with
no question above it.

## Done

The map is cleared when the frontier is empty and no fog remains. The durable
residue – living specs via commit-time sync, ADRs and glossary via
`record-context` – has already been extracted along the way. Report what was
settled and point at anything the map left `out-of-scope`.
