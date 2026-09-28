---
name: map
description: The entry point for planned work. A map is a graph of question and work nodes. Charts one if none exists – an opening grill, meaning a round of interview questions, that fixes the destination and surfaces the fog, meaning what cannot yet be stated precisely – and works the frontier, the nodes ready to be worked now, if one does. No tiers and no routing – the graph is however big the fog made it, and nothing declares which. Invoke whenever decisions need settling before work can start, the request is foggy or underspecified, or a map already exists and has open nodes. Use implement instead when the way is already clear.
argument-hint: "[map name, or the request to chart]"
---

## User input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

# Map

## Tracker

Nodes live behind a pluggable tracker. A backend declares four operations –
create, read, update, list. SpecHub builds everything else from those four:
frontier, claim, resolve and walk.

Two backends ship, each declared in this skill's directory:

| Backend | Doc | When |
| ------- | --- | ---- |
| GitHub issues | `trackers/github.md` | first choice when `gh` holds a login for the repo's GitHub remote |
| Files | `trackers/files.md` | the fallback – no auth, offline, any remote |

`workflow.maps.tracker` in `spechub/project.yaml` (`github` or `files`) records
the project's choice. If the key names a backend, read the matching doc and use
its operations. If the key is absent, pick at materialisation time – the moment
you first write the map's nodes down.

Recommend `github` when the repo qualifies, `files` otherwise. Confirm the
choice with the user. Then write the key, so later sessions need not re-decide.

## Which mode

One command runs two modes, and what already exists picks between them. Check
the configured tracker for existing maps – `ls spechub/maps/` on the files
backend, `gh label list --search "map:" --json name` on GitHub.

If `$ARGUMENTS` names a map, or exactly one exists, work its frontier – the
nodes ready to work now. If none exists, chart. If several exist and
`$ARGUMENTS` does not pick one, ask.

There are no tiers and no complexity judgement.

One question is a small map or no map at all. Fifty questions is a long
effort. Nothing declares which.

## Charting

1. **Fix the destination first.** Grill for what done looks like (invoke the
   `grilling` skill). The destination is the root of everything that follows –
   settle it before any other question.

2. **Load the frontend branch on a frontend destination.** `frontend.md`
   beside this skill holds five more rules. Read it when the destination
   touches `frontend.directory`, the path in `spechub/project.yaml` where the
   frontend lives. Every other map skips it.

3. **Open with a breadth-first grill.** Work the conversation frontier in
   rounds per the grilling skill. Explore the codebase for facts as you go –
   facts are your job, never the user's. Try a throwaway prototype before you
   ask the user anything (grilling's "Run it before you ask it").

4. **Apply the fog test to what surfaced.** A question you can state precisely
   now is `open`. One you cannot state is `fog` – record it without forcing it
   sharp. The test is whether you can *state* the question precisely, not
   whether you can answer it.

### Progressive materialisation

The machinery appears only when it has to persist. After the opening grill:

- **No fog surfaced** – the way was already clear. No map. Say so and proceed
  to the work.

- **At most one session's worth** – settle it in conversation. Invoke
  `record-context` on each decision. No map – there is nothing to resume.

- **More than one session's worth** – materialise the map and work the
  frontier across sessions.

The test is mechanical. Will the fog outlive this session?

### Materialising

Pick the tracker (see Tracker above), then create the nodes with its `create`
operation. First the root:

```bash
# files backend – github.md has the equivalent
~/.claude/spechub/bin/spechub node create --map <name> --title "<destination>" \
  --kind destination --label "<at most four words>" \
  --body "<the destination, as settled>"
```

- The root is the destination. Pass no `--status` flag, so it opens.

    The root's state follows its subtree. It stays open while any node below
    it is open, fog or claimed. `archive` resolves it when the map clears.
    Nothing else writes the root's status, and the frontier never returns it.

- The root counts as pinned without the flag, and on GitHub it carries the
  `root-node` label. The walk returns pinned nodes in full at the start of
  every session, so every session orients to the root.

- On GitHub, every node body opens with a header line that encodes its edges.
  `trackers/github.md` holds the format. The files backend writes none.

- Every node carries a `kind` and a `label`, both required. A `label` is the
  node's short name for a diagram. `trackers/files.md` holds the kinds, the
  caps, and the contract the CLI enforces.

- Every node body carries a diagram, two at most. A childless `notes` node is
  the one exception.

    `visuals.md` holds which visual each kind gets, where it sits in the body,
    and the rules a hand-drawn one follows. Read it before the first body.

- Standing preferences for the effort become one resolved node. Style rules
  and constraints the grill surfaced go there. Create it with
  `--answers <root id> --kind notes --label "<at most four words>" --pinned`.

- Every other surfaced question becomes a node. Give it `open` or `fog` per
  the fog test.

    Pass `--answers <id>` to name the node whose resolution surfaced it. That
    link is the node's provenance, the trail back to the root. Pass
    `--blocked-by` only where you genuinely cannot settle one node before
    another.

- `mode` defaults to `hitl` – human in the loop, meaning a person answers it.

    A node earns `afk` – away from keyboard, meaning an agent settles it alone
    – only by containing no decision. Research earns it, and so does work
    whose questions are all settled. Get this wrong and an agent quietly
    decides something that was the human's.

- Write every title and body per the `writing` skill.
- Nodes describe behaviour, not file paths. A node can sit on the frontier for
  weeks while the codebase moves – you resolve the paths at claim time.

- Draw every parent's diagram once every node exists, per Regenerating
  diagrams below. A parent draws its subtree, so nothing can draw one earlier.
  The root is a parent too, and it draws the whole map.

- On the files backend, suggest adding `spechub/maps/` to `.gitignore`
  (`trackers/files.md` gives the reason).

## Working the frontier

All commands below are the files backend's shape – on GitHub, compose the
same queries per `trackers/github.md`.

Before step 1, copy the bold title of each numbered step below into your todo
list word for word, ahead of any task-specific items. A step you skip stays in
the list, marked `skip: <reason>`.

1. **Orient.** The packaging walk (`spechub node walk --map <name>`) – the root
   and pinned nodes in full, everything else gisted, meaning title and status
   only. Zoom in with `node read <id>` when a gist matters – it drops the
   generated diagram blocks, and `--visuals` puts them back. Do not load
   every body.

    Also check `node list --map <name> --status claimed`. A claim marks a node
    someone is working, so a dead session's claim hides it from the frontier
    forever. If a claim exists and you know of no session working it, ask the
    user and release it (`--status open`).

2. **Query the frontier.** `spechub node frontier --map <name>` – open nodes
   with no unresolved blockers, shallowest provenance depth first, number
   only as a tiebreak. Provenance depth is how many `answers` links separate
   a node from the root, so the broadest questions come first. The query never
   returns the root.

3. **Route by `mode` – the only field the machine routes on** (`kind` picks
   the node's diagram shape, never its route):
    - `hitl` nodes: run grilling rounds over them. A round is the whole hitl
     frontier.
    - `afk` nodes: claim and run without the user. Unlimited, and in parallel
     when independent. Research goes to `Explore` subagents, with the findings
     written into the resolution.

     Implementation work follows `/spechub:implement`'s procedure – it owns
     the claim-execute-resolve flow, the explorer dispatch, and the TDD
     pipeline. Do not restate that flow here. Invoke it.

4. **Claim, then resolve** – `afk` nodes only. A `hitl` resolution happens
   inside the grilling round, with no claim step. Both are compositions over
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

5. **After every resolution**, in order:
    - Invoke `record-context`
    - Create nodes for anything the resolution surfaced
    - Create the critique node when the resolved node changed the frontend,
      per `frontend.md`
    - Regenerate the diagram on the resolved node's parent (see Regenerating
      diagrams)
    - Recompute the frontier

    The regeneration comes after the new nodes exist. A surfaced node hangs
    off the node you just resolved, inside that same subtree.

    A shallow node arriving late jumps the queue – that is correct, something
    big just opened up.

6. **Graduate fog as it sharpens.** When you can state a fog node precisely,
   run `update <id> --status open` – one field, one write. Rewrite the title
   and body to the sharp statement if they drifted.

Never filter on leaf position or "has a resolved question above it". Work
nodes can hang anywhere, including straight off the root – a bug is work with
no question above it.

## Regenerating diagrams

A parent's diagram draws its subtree, so any status change below it leaves
that diagram wrong. Regenerate on the resolved node's parent after every
resolution, and on every parent at each frontier recompute. The map skill's
`visuals.md` holds the commands and the write rules (Regenerating a parent's
diagram).

## Done

The map clears when the frontier is empty and no fog remains. The durable
residue is what the map leaves behind – the living specs through commit-time
sync, the ADRs and glossary entries through `record-context`. You have already
extracted it along the way.

Report what the map settled. Point at anything the map left `out-of-scope`.

Then invoke `archive` to close the map out. It re-checks the gate itself and
refuses if anything is still open. It verifies the residue actually landed,
resolves the root, and asks before disposing of the nodes.
