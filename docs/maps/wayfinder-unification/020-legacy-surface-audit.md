---
status: resolved
mode: afk
kind: task
answers: 001
blocked-by: []
---

# What in the current skill set conflicts with the new design?

## Question

Twenty-two skills exist. Eight of them plus three CLI commands reference
`proposal.md`, `design.md` or `tasks.md`. Which parts die, which get rewired, and
which are untouched? Answering this before building stops the redesign from
landing beside the old surface instead of replacing it.

## Dies with the ladder

| Skill      | Why                                                          |
| ---------- | ------------------------------------------------------------ |
| `propose`  | writes `proposal.md`. Charting a map replaces it             |
| `design`   | writes `design.md`. Resolved nodes plus ADRs replace it      |
| `tasks`    | writes `tasks.md`. Work nodes on the frontier replace it     |
| `verify`   | cross-checks the three documents against each other. With one node type there is nothing to cross-check |

## Dies for its own reason

**`implement-quick`.** It exists because `workflow.auto_select` judges complexity
and routes to a shorter path. Node `007` rejected that whole mechanism – a map
with no fog already means the way was clear, so a separate quick path is the tier
system in another costume.

Its **three-explorer analysis pattern should be salvaged** before deletion. That
part is good and has no home in the new design yet.

## Becomes the primitive

**`clarify`.** Node `006` extracts the grilling technique from it. Two things to
fix on the way out, not carry over:

- It contradicts itself on the stop condition – ten questions in one place, five
  in another
- Its whole vocabulary assumes it is sharpening a `proposal.md`

## Rewired, survives

| Skill      | Change                                                                |
| ---------- | --------------------------------------------------------------------- |
| `implement` | reads `tasks.md` checkboxes today, claims from the frontier instead. Node `004` says rework it last |
| `archive`  | moves `changes/` to `archive/` today. Becomes residue extraction plus node disposal per node `016` |
| `explore`  | overlaps the map's charting mode. Both are read-only thinking. Needs a boundary or a merge |
| `handoff`  | writes `HANDOFF.md` before compaction. For map work the provenance walk is the handoff, so this may only be needed off-map |

## Untouched

`init`, `config`, `bootstrap`, `bridge`, `browser-verify`, `commit`, `code-review`,
`pre-commit-review`, `quick-fix`, `sync`, `test-conventions`, `visual-docs`.

`quick-fix` stays by the decision in node `008`. Broken is a different axis from
foggy.

## Config keys that die

- `workflow.auto_select` – rejected by node `007`
- `workflow.clarification.propose`, `.design`, `.tasks` – three keys named after
  the three documents. They cannot survive the documents

## Prose and code that assert the old model

- `CLAUDE.md` – the Workflows section lists the six-step pipeline, and Path
  Selection describes `auto_select`. Both describe behaviour that is going away
- `README.md` – the skill tables list what dies
- `cli/src/commands/new-change.ts` – hardcodes the three template filenames
- `cli/src/commands/validate.ts` – hardcodes `proposal.md`
- `cli/src/commands/status.ts` – derives state from one `existsSync` per artifact

## Sequencing

Delete nothing until its replacement works. Every skill above is reachable today,
and a half-migrated set is worse than either end state. The order in node `004`
holds: additive work first, `/implement` last, deletions after that.
