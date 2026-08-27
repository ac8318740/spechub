# SpecHub workflows

*Every request ends by updating the living specs. The requests differ only in how much fog stood in the way, fog being whatever nobody can state precisely yet.*

SpecHub is a workflow orchestrator, and planning structure grows only as far as the unknowns demand. A clear request goes straight to implementation, a broken thing gets root-cause discipline, and open decisions become a map. How does one entry point serve all three? It routes on what stands in the way, then works the map frontier by frontier.

```mermaid
flowchart TD
    R["A request<br/>(feature, bug, refactor)"] --> Q{"What stands<br/>in the way?"}
    Q -->|"nothing – the way is clear"| I["Implement<br/>(implement)"]
    Q -->|"it is broken"| F["Root-cause fix<br/>(quick-fix)"]
    Q -->|"open decisions"| M["Map<br/>(chart, then work the frontier)"]
    M -->|"work nodes"| I
    I --> T["Build under TDD<br/>(4-phase pipeline)"]
    F --> C["Commit<br/>(spechub:commit)"]
    T --> C
    C --> Y["Sync specs from the diff<br/>(domain-map.yaml)"]
    Y --> L[("Living specs<br/>spechub/specs/")]
    M -->|"map cleared"| A["Archive<br/>(check the residue,<br/>dispose of nodes)"]
    A --> L
```

| Step in the diagram   | Detail    |
| --------------------- | --------- |
| Map                   | section 1 |
| Implement             | section 2 |
| Grilling and records  | section 3 |
| Build under TDD       | section 4 |
| Commit **and** sync   | section 5 |
| Archive               | section 6 |
| Living specs          | section 7 |

The request box is a terminal, not a step. Section 5 covers two boxes because one command does both. Section 8 describes this document, so no box holds it.

## 1. The map

*One node primitive replaces the fixed proposal, design and tasks ladder that earlier versions used. Nothing stores the map, because it is queries over the nodes.*

- **A map** is a set of small records called nodes
- **A node** is one question to settle or one piece of work to do
- `/spechub:map` is the entry point for planned work
    - It charts a map when none exists, opening with a grill, a round of questions that fixes the destination and surfaces the fog
    - The destination is what finished looks like
    - It works the frontier instead when a map exists
- SpecHub never sorts requests into sizes, and nothing picks a different process for a big one
    - There is one path, and only the node count varies with the fog

A node carries one of five statuses.

| Status | What it means |
| --- | --- |
| `fog` | nobody can state it precisely yet |
| `open` | ready to settle |
| `claimed` | someone is working it |
| `resolved` | settled |
| `out-of-scope` | deliberately dropped |

A node carries a `mode` too, and two link types connect the nodes.

- **`mode`** says who settles the node: `hitl` for a human, `afk` for an agent alone
- **`answers`** names one provenance parent, the node whose resolution raised this one
    - The parent links form a tree, so they give reading order
    - An agent packages a handoff by walking that tree
- **`blocked-by`** names any number of nodes that must resolve before this one starts
    - The blocking edges form a directed acyclic graph, meaning the edges never loop back
    - These edges tell you what you can work right now

SpecHub derives depth from `answers`, and nobody declares it. The map itself is five queries.

| The question | The query |
| --- | --- |
| Where are we going? | the root node |
| What have we decided? | the `resolved` nodes in provenance order |
| What can we work now? | the `open` nodes with no unresolved blockers |
| What is not yet specified? | the `fog` nodes |
| What did we drop? | the `out-of-scope` nodes |

Nodes live in a tracker, the storage layer, which is swappable.

- A tracker provides four operations and nothing more: create, read, update, list
- GitHub issues are first-class, because sub-issues carry the provenance parent and dependencies carry the blocking edges
- Files under `spechub/maps/<name>/` are the fallback
- Frontier, claim and resolve build on those four operations, so no tracker implements them

**Progressive materialisation**: structure appears only when it has to persist.

- You create a map only when the fog will outlive the session
- You grill one question in conversation, and it leaves an architecture decision record (ADR), not a map

## 2. Implement

*A unit of work carries its own size. One node is a quick change, forty is a long effort, and nothing declares which.*

- `/spechub:implement` claims `afk` work nodes from the frontier when a map exists
    - It treats the request itself as the work item when none does
    - Either way, parallel explorer subagents run over the relevant code before anyone writes anything
- The command resolves paths at claim time, because a node describes behaviour and can sit on the frontier for weeks
- The test-driven development (TDD) pipeline of section 4 runs to completion inside each claim
- A node only ever moves `open -> claimed -> resolved`
    - The agent releases the claim when work stalls, and the node is plainly open again
- Progress is a frontier query, not a checkbox file, so resuming never means re-reading an effort end to end

`/spechub:quick-fix` stays separate, because broken is a different axis from foggy.

- A bug has a root cause to find, not a decision to settle
- `/spechub:quick-fix` therefore never creates a node

## 3. Grilling and durable records

*Three model-invoked primitives, skills the agent reaches for itself, carry the interviewing, the remembering and the writing.*

- **`grilling`** works decisions in rounds
    - A round asks the whole frontier, every question whose prerequisites have resolved, numbered, each with a recommended answer
    - It then recomputes the frontier and repeats
    - Facts are the agent's job, never the user's, so it sends a question an environment fact would answer to explorer subagents
    - Presentation follows `workflow.grilling.questions`, the host's question tool by default
    - It falls back to inline prose past 4 questions, or for a question with no discrete options
    - There is no question cap, because the frontier bounds itself
- **`record-context`** fires when a decision lands
    - It writes an ADR under `docs/adr/` only when the decision is hard to reverse *and* surprising *and* a real trade-off
    - It writes a glossary term when a term got settled, in root `CONTEXT.md` for cross-domain vocabulary
    - It writes a domain term in `spechub/specs/<domain>/CONTEXT.md` instead
    - It can write both, or neither
    - SpecHub generates the ADR index from the files, and nobody hand-edits it
- **`writing`** holds the standard every durable artifact follows: node answers, ADRs, glossary entries, specs and handoffs
    - The words to avoid live in `skills/writing/vocabulary.md`

## 4. Build under TDD

*Four phases with hard walls between them. The wall between phase 1 and phase 2 is the one that does the work.*

```mermaid
flowchart LR
    subgraph P["Order set by workflow.tdd.strict"]
        direction LR
        W["test-writer<br/>(requirements only)"]
        E["task-executor<br/>(cannot edit tests)"]
        W -.->|"strict: tests first"| E
        E -.->|"relaxed: code first"| W
    end
    P --> Fm["format<br/>(commands.format)"]
    Fm --> K["task-checker<br/>(PASS / FAIL)"]
    K -->|FAIL| E
    K -->|PASS| V["frontend-verifier<br/>(real browser)"]
    V -->|FAIL| E
```

The separation is the mechanism, not a formality.

- **test-writer** sees requirements and acceptance criteria, and never the implementation plan
    - Tests encode what should happen, so the implementation cannot shape them
- **task-executor** receives the failing tests and cannot modify anything in the test directory
    - It has to make the specification pass instead of editing it
- **task-checker** is a binary gate
    - It runs the task's tests, then the full suite for regressions
    - It checks the test count against `.test-baseline` and audits mocks for circular assertions
    - It confirms the executor left the tests alone
- **frontend-verifier** drives a real browser over the Chrome DevTools Protocol (CDP)
    - It takes before and after screenshots, and reports on the evidence

Which phases run, and in what order:

- A FAIL routes back to the executor with the reason
- Phases 1 and 4 are conditional
    - You can skip test-writer for a config or docs change with no testable behaviour
    - The frontend-verifier runs under three conditions: `spechub/project.yaml` configures a frontend, frontend files changed, and verification is on
- `workflow.tdd.strict: false` reverses phase 1 and phase 2
    - The order becomes task-executor, then test-writer, then task-checker
    - It drops no phase, and all three agents run
    - Relaxed TDD means nobody writes the tests first, never that the work goes unverified

Relaxed weakens one wall, the one this section calls the important one.

- Under `false` the test-writer works beside an implementation it must not read, instead of one that does not exist yet
- Its independence then rests on its instructions rather than on context isolation
- That is the cost of relaxed TDD
- The checker pays for it too, because no run can show the new tests failing without the implementation
    - It holds them to existing and passing instead

The format step sits immediately before phase 3.

- The pipeline runs `commands.format` over the files the work touched
- Under relaxed that puts the format step after the test-writer, so the new tests get formatted too
- A project whose `commands.format` is `null` gets no format step
- A non-zero exit gets reported, and never counts as a failed implementation

## 5. Commit and sync specs

*Spec sync runs on every commit on every path. It reads the diff, so specs describe what you built rather than what you planned.*

`/spechub:commit` groups changes into MECE commits, mutually exclusive and collectively exhaustive, so no change appears twice and no change goes missing. Before writing them it does five things.

1. Reads `spechub/domain-map.yaml` to map each changed file to a domain.
2. Works out what the diff adds, modifies or removes, for each affected domain with a `spec.md`.
3. Writes those entries into the domain's spec and stages them in the same commit.
4. Flags source files that match no domain.
5. Checks the glossaries.

On the glossary check:

- It says so when the diff renames or deletes an identifier matching a glossary term
- It never edits the glossary
- For specs the code wins, and for the glossary the human wins

Four cases stop sync.

- `workflow.spec_sync` set to `false`
- no domain map
- no file matching a domain
- a change that touches only docs and config

**Without `spechub/domain-map.yaml` this step does nothing, silently.**

- `/spechub:setup` generates that file
- `spechub config check` reports it as missing on a project set up before that existed

## 6. Archive

*A map is scaffolding. Archive checks that someone extracted the residue, the durable output meaning spec updates, decision records and glossary entries, then disposes of the nodes.*

- `/spechub:archive` checks for a cleared map: empty frontier, no fog, no claims
- It spot-checks that living specs, ADRs and glossary entries captured what the effort settled
- It then disposes of the nodes
    - It deletes them by default
    - It moves them to `spechub/archive/<date>-<name>/nodes/` when `workflow.maps.persist` is `true`
    - Keeping nodes is off by default, because a kept map is a second copy of every decision and the two drift
    - On the GitHub tracker there is nothing to dispose, because a closed issue is already the archive
- Archive runs either way
    - The user types `/spechub:archive`
    - `/spechub:map` hands off to it once the frontier empties, and the disposal step then asks first
- Legacy `spechub/changes/` directories from the pre-map workflow still archive the old way, so an upgrade never strands work

## 7. Living specs

*The durable output. Maps are scaffolding, and `spechub/specs/` is what the project keeps.*

- Specs live at `spechub/specs/<domain>/spec.md`, organised by the domains in `domain-map.yaml`
- Each spec states numbered functional requirements (`FR-NNN`) in Given, When, Then form
- They are cumulative, and they describe only what the code already does
- A roadmap item in a living spec is a bug in the spec

Two rules keep them honest.

- **Two writers, one target**
    - Commit-time sync handles incremental change
    - Archive verifies a completed map left nothing behind
    - Both converge on the same files
- **Fix it when you see it**
    - Any agent that finds a spec contradicting the code corrects the spec immediately
    - It rewrites wrong behaviour, appends missing requirements, and deletes stale references

`/spechub:bootstrap` generates the first set from an existing codebase, so a project does not start from an empty directory.

## 8. Where the design record lives

*This section describes the document, not the system, so no diagram box holds it.*

- The reasoning behind this design lives in the issues labelled `wayfinder` on this repository
- That covers why one node type, why four tracker operations, and why no tiers
- Each issue is one decision with the reasoning that produced it
