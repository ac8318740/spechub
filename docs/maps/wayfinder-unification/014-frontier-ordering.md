---
status: resolved
mode: hitl
kind: grilling
answers: 002
blocked-by: []
---

# What orders the frontier?

## Question

Wayfinder's local tracker tie-breaks the frontier by "first by number wins".
Writing this map by hand broke that: node `010` descends from `003`, so directory
order and reading order diverge. The number is identity, not sequence. What
orders the frontier instead?

## Answer

**Shallowest provenance depth first. Number only as a stable final tiebreak.**

Depth is already stored, already derived, and encodes the descent this design
exists for: settle the higher-altitude question before the ones beneath it.

It also handles the interesting case correctly. A shallow node surfacing late
means something big just opened up, so jumping to it ahead of a nearly-finished
deep chain is right, not a distraction.

Numbers survive as identity and as a deterministic last resort when two nodes sit
at the same depth. They must never be read as order.

Rejected: **most-blocking-first**, which maximises how much the next resolution
unblocks. Defensible, and it beats depth on throughput, but it needs the whole
blocking graph to compute and it orders the frontier by mechanical convenience
rather than by altitude. Revisit if the frontier gets wide enough that
parallelism matters more than descent.
