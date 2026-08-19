---
status: resolved
mode: hitl
kind: grilling
answers: 002
blocked-by: []
---

# Does implementation work live in the same graph as fog-clearing questions?

## Question

Wayfinder plans and then hands off. Its author is explicit that a map hands off
rather than looping into implementation. SpecHub's `tasks.md` is a separate
structure with its own dependency column. Keep two structures, or one?

## Answer

One. `tasks.md` stops existing.

A task list is a map whose fog has fully cleared. Same nodes, same dependency
edges, same one-at-a-time execution. The only difference is that the questions
have become instructions.

Keeping them separate leaves the actual failure point untouched. Abandonment is
partly a resumption problem: `/implement` walks phases linearly, so resuming
means re-reading everything to work out where it stopped. A frontier query
answers "what can be done right now" in one call, at every altitude.

## What this breaks

| Today                                                | Becomes                     |
| ---------------------------------------------------- | --------------------------- |
| `/implement` walks `tasks.md` phases                 | pulls from the frontier     |
| `/archive` derives domains from paths in `tasks.md`  | derives them from nodes     |
| `/handoff` anchors `Phase: propose \| ... \| tasks`  | anchors a node id           |
| `/verify` cross-checks three documents               | deleted                     |
| checkbox mutation in `/implement`                    | deleted                     |

Rework `/implement` last. Everything before it is additive and nothing
downstream breaks until it is touched.

## The rule this forces us to restate

Wayfinder's hardest invariant is never resolve more than one ticket per session,
with research as the only exception. Ported literally that would mean one
implementation task per session, which is absurd.

Research is its only purely AFK type, so the rule was never about tickets. It is
about human attention. The first generalisation was:

> One HITL node per session. AFK nodes run unlimited and in parallel.

Wayfinder's research exception is a special case. Work nodes are AFK, so
implementation can still burn through many in one session via subagents.

**The HITL half was later deleted – see node `018`.** Adopting `grilling` as the
primitive settled it: a round is the whole frontier, so a session resolves as many
HITL nodes as the frontier holds. Attention is bounded by frontier width, which
provenance keeps small on its own, rather than by a count.

What survives is the AFK half, unchanged: AFK nodes run unlimited and in parallel,
and depth never constrains either kind (node `015`).
