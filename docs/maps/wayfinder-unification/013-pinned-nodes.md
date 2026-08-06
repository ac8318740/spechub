---
status: resolved
mode: hitl
kind: grilling
answers: 002
blocked-by: []
---

# Where do standing preferences for an effort live?

## Question

Every map section collapsed into a status except Wayfinder's `## Notes` – the
domain, the skills each session should consult, standing preferences. Writing
this map by hand forced it into the root node's answer, so the root ended up
doing two jobs. Config file, root-node overload, or something else?

## Answer

A `pinned: true` flag. Notes become an ordinary resolved node with
`kind: notes`.

The requirement was never "notes need a home". It is that **some nodes load in
full every session, while the rest are gisted and zoomed on demand**. That is a
property of a node, not a section of a document.

- `pinned: true` loads in full at session start.
- The root is implicitly pinned – every session orients to the destination.
- Everything else is gisted, then zoomed when relevant.

Net cost is zero concepts: it deletes the `## Notes` section and adds a boolean
that generalises. A hard constraint discovered halfway through an effort deserves
pinning just as much as a style preference does, and a section would not have
held it.

Rejected: an effort-level config file. It adds an artifact, and the rule for this
effort is that anything added must name something removed.
