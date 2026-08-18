---
status: fog
mode: hitl
kind: grilling
answers: 006
blocked-by: []
---

# Nothing produces the glossary the design keeps promising

## Question

Three nodes name a glossary as durable output – `001` lists it beside living specs
and ADRs, `006` makes it the output of the one-session front door, `016` counts it
as durable residue extracted at archive. Nothing writes one.

`skills/clarify/SKILL.md:67` only *reads* "canonical glossary terms". There is no
skill that creates or sharpens them, and no equivalent of the upstream
`domain-modeling`, which is where that behaviour lives.

So the one-session path currently produces ADRs and nothing else, and the durable
half of `grill-with-docs` is the half SpecHub cannot do.

## What needs deciding

- Does the glossary belong in a `CONTEXT.md` at the repo root, inside
  `spechub/specs/`, or as a domain-level file beside each `spec.md`?
- Is it a skill of its own, or a second responsibility of the ADR skill? Both
  write durable prose from a settled decision.
- Living specs are generated from code at commit time. A glossary is not derivable
  from code – it is the vocabulary humans agreed on. Does spec sync leave it
  alone, and if so what keeps it from going stale?

The last one matters most. A glossary nothing maintains is exactly the stale
document this effort exists to remove.
