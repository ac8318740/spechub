# Map: Wayfinder unification

The design record for replacing SpecHub's fixed proposal / design / tasks ladder
with a single node primitive. Written by hand, before any code, to test whether
the shape can hold the design of itself.

## What is here

One file per node. Nothing else. There is deliberately no `map.md`.

The map is a set of queries over the nodes, not a stored index. Storing it would
mean every decision lives in two places, and keeping those two places in step is
the bookkeeping this design removes.

| View              | Query                                    |
| ----------------- | ---------------------------------------- |
| Destination       | the root node – the one with no `answers` |
| Decisions so far  | `status: resolved`, in provenance order  |
| Frontier          | `status: open`, no open blockers          |
| Not yet specified | `status: fog`                            |
| Out of scope      | `status: out-of-scope`                   |

## Node format

```yaml
---
status: fog | open | claimed | resolved | out-of-scope
mode: hitl | afk          # who settles it: a human, or an agent alone
kind: grilling            # advisory hint only; the machine reads mode
answers: 001              # provenance parent, one; omitted on the root
blocked-by: []            # blocking edges, many
---
```

Two link types, doing different jobs:

- `answers` forms a **tree**. It records why a node exists: which resolution
  surfaced it. This gives reading order and makes packaging a traversal.
- `blocked-by` forms a **DAG**. It answers what can be worked right now.

Depth is derived, never declared. There are no altitude labels, so nothing has
to be classified and nothing can drift.

## Reading it top-down

Start at `001` and follow `answers` downward. That walk is the design document.
No separate document is maintained.

## This map is not tool output

It was written by hand and is committed on purpose. It is the design record for
the redesign, not an example of what the tool produces.

The files backend writes to `spechub/maps/<name>/`, and those nodes are transient
working state that is deleted at archive unless `workflow.maps.persist` is on.
Nothing is written to `docs/`. See node `016`.
