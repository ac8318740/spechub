---
status: resolved
mode: hitl
kind: grilling
answers: 004
blocked-by: []
---

# Is a work item the same kind of node as a question?

## Question

Once implementation lives in the graph, is a work item a second node kind with
its own fields – files touched, TDD phase, checker verdict – or the same kind
with `mode: afk`?

## Answer

The same kind. `mode` flips to `afk`, and nothing else changes.

A node is anything that must be settled before the effort is done. Some are
settled by asking a human, some by an agent working alone. When a resolution
stops producing questions and starts producing instructions, the nodes it
surfaces are simply `afk`, and the frontier hands them to the TDD pipeline
instead of to the human.

**The pipeline's state lives inside the claim, not on the node.** Test-writer,
executor and checker run to completion within one claim, exactly as a grilling
does. The node only ever moves `open -> claimed -> resolved`. So there is no
TDD-phase field and no test-status field.

That is the whole argument against a second kind. A `phase: tests-written` field
is a resumption breadcrumb, but the claim already expresses resumption. When the
checker fails, two kinds would have to decide which phase to roll back to and
write it; one kind releases the claim and the node is plainly open again. The
extra fields are a second, weaker copy of what claim and release already say –
the same index-versus-store drift this design removed one level up.

The cost: a work node cannot be read alone and reveal which files it touches.
That is what the answer text is for, and the resolved parent chain above it
carries the why, which is what `tasks.md` never had.

## Consequence: nodes describe behaviour, not paths

A node can sit in the frontier for weeks, which is the point of a map. `tasks.md`
mandates the opposite – every path must come from exploration – and that is safe
only because a task list is consumed within hours.

So: nodes describe behaviour. File paths are resolved at claim time, not at
creation time. This borrows the durability rule from Matt Pocock's agent briefs,
where an item may sit in a ready queue for weeks while the codebase moves.
