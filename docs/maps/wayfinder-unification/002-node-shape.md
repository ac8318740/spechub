---
status: resolved
mode: hitl
kind: grilling
answers: 001
blocked-by: []
---

# What shape is a node?

## Question

Wayfinder stores a map issue holding five sections, plus child ticket issues.
SpecHub stores three documents. Both carry state in more than one place. What is
the smallest structure that expresses a variable-depth hierarchy without an
index to keep in step?

## Answer

One node type. Five statuses, two modes, two link types.

```
status:  fog | open | claimed | resolved | out-of-scope
mode:    hitl | afk
answers:    one parent    -> tree -> reading order, packaging
blocked-by: many          -> DAG  -> frontier
kind:    advisory hint (grilling, research, prototype, task, ...)
```

Three collapses fall out of this.

**The destination is the root node.** Not a field on a map. The first question,
resolved before anything else. Every other node descends from it by provenance,
which is why the tree exists and why there is no separate destination to keep in
step.

**Wayfinder's five map sections become status values.** Decisions so far is
`resolved`. Not yet specified is `fog`. Out of scope is `out-of-scope`. The
frontier is `open` with no open blockers. Graduating fog is `status: fog ->
open`: one field, one write. Wayfinder's most error-prone rule – graduate the
fog, then clear the graduated patch from the map body so it lives in one place –
stops existing.

**Depth is derived, never declared.** An earlier draft tagged each node with an
altitude. That was the over-engineering: a taxonomy to maintain, a judgement
call per node, and a rebuild of the rigid ladder as metadata. The provenance
parent is free instead. At the moment a resolution sharpens fog into a node, we
already know which resolution caused it. Recording it is one field and no
judgement.

`mode` is the only field the machine reads for routing. It decides whether the
frontier hands a node to the human or to a subagent. `kind` is advisory, so
adding a sixth kind is a label rather than a code change.

`hitl` is the default. `afk` has to be earned by a node genuinely containing no
decision. Getting this wrong in the other direction means an agent quietly
deciding something that was the human's to decide.
