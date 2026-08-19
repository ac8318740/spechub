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

One command, two modes, picked by what exists:

```bash
~/.claude/spechub/bin/spechub node list --map <name> --json
```

Check `spechub/maps/` for existing maps. If `$ARGUMENTS` names one, or exactly
one map exists, work its frontier. If none exists, chart. If several exist and
`$ARGUMENTS` does not pick one, ask.

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

```bash
~/.claude/spechub/bin/spechub node create --map <name> --title "<destination>" \
  --status resolved --kind grilling --body "<the destination, as settled>"
```

- The root is the destination, already resolved. It is implicitly pinned –
  every session orients to it.
- Standing preferences for the effort (style rules, constraints discovered in
  the grill) become a resolved node with `--kind notes --pinned`.
- Every other surfaced question becomes a node: `open` or `fog` per the fog
  test, `--answers <id>` naming the node whose resolution surfaced it,
  `--blocked-by` only where one genuinely cannot be settled before another.
- `mode` defaults to `hitl`. `afk` must be earned by a node containing no
  decision – research, or work whose questions are all settled. Getting this
  wrong means an agent quietly deciding something that was the human's.
- Nodes describe behaviour, not file paths. A node can sit on the frontier for
  weeks while the codebase moves – paths are resolved at claim time.
- Suggest adding `spechub/maps/` to `.gitignore`. Nodes are transient working
  state, like `spechub/HANDOFF.md` – the durable output is specs, ADRs and
  glossary entries, extracted as nodes resolve.

## Working the frontier

1. **Orient.** `spechub node walk --map <name>` – the root and pinned nodes in
   full, everything else gisted. Zoom with `node read <id>` when a gist turns
   out to be relevant. Do not load every body.
2. **Query the frontier.** `spechub node frontier --map <name>`. It is already
   ordered: shallowest provenance depth first, number only as a tiebreak.
3. **Route by `mode` – the only field the machine routes on** (`kind` is
   advisory):
   - `hitl` nodes: run grilling rounds over them. A round is the whole hitl
     frontier.
   - `afk` nodes: claim and run without the user. Unlimited, and in parallel
     when independent. Research goes to `Explore` subagents; implementation
     work runs the TDD pipeline (test-writer, task-executor, task-checker)
     within the claim. Before any code change, dispatch explorer subagents
     over the relevant code – as many as there are distinct places to look.
4. **Claim, then resolve** – both are compositions over `update`:

   ```bash
   spechub node update <id> --map <name> --status claimed
   spechub node update <id> --map <name> --status resolved \
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
