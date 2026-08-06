---
status: resolved
mode: hitl
kind: grilling
answers: 005
blocked-by: []
---

# Do work nodes only ever sit at the bottom of the tree?

## Question

The story for unification was that a chain of questions resolves until nothing is
left to decide, and the nodes below that point are work. Writing this map by hand
broke it: node `012` is `afk` and hangs straight off the root, because a bug is
just work with no question above it.

## Answer

No. **`mode` is orthogonal to depth.** An `afk` node can sit at any position,
including directly under the root.

This is an invariant to state rather than a mechanism to build:

- The packaging walk emits nodes in provenance order regardless of `mode`.
- `/implement` pulls `afk` nodes from the frontier regardless of depth.
- **No query may filter on "is this a leaf"**, or on whether a resolved question
  sits above a node.

The thing to guard against is a future query keying off leaf position as a
shortcut for "is this work". It would pass every test written against a graph
that grew question-first, then silently skip work that arrived on its own.
