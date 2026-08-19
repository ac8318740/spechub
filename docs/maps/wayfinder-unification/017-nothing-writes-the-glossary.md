---
status: open
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

## Settled: where it lives

Two files, both created lazily, mirroring the upstream structure without its index.

- `CONTEXT.md` at the repo root – cross-domain vocabulary only.
- `spechub/specs/<domain>/CONTEXT.md` – domain terms, beside that domain's
  `spec.md`.

**No index file.** Upstream needs a `CONTEXT-MAP.md` to say where each context
lives. SpecHub already has `domain-map.yaml`, which lists every domain and the
paths it owns. An index would be a second place recording the same thing, and the
two would drift. This deletes a concept rather than adding one.

**Not co-located with code**, which is where upstream puts it. A domain owns a
list of path prefixes, not one directory – a real map in use has a single domain
owning four unrelated paths, including individual files in three different
directories. There is no obvious directory to put its glossary in. The domain's
spec directory is the only place a domain reliably has.

**Glossary and nothing else.** No implementation details, not a spec, not a
scratch pad. Borrowed from upstream and worth keeping: the moment it accepts
implementation notes it becomes another document competing with the living specs.

## Settled: one skill, three outputs

One skill, fired by a node resolving. It writes an ADR if the three-part bar is
met, a glossary term if a term got pinned down, both, or neither. The conditions
are independent; the trigger is shared.

Two skills watching one event drift. And "ADR skill" stops being the right name
once it also owns vocabulary – name it for the job, recording durable context.

### The ADR index is generated

`docs/adr/index.md`, rewritten by the same skill every time it writes an ADR.
Number and slug come from the filename, the title from the file's first heading.

Generated, never hand-edited, and that distinction is the whole point. The
objection to a `CONTEXT-MAP.md` was a second hand-maintained record of something
already recorded – not indexes as such. A derived view cannot drift from its
source. If it is ever edited by hand it becomes the thing that was rejected.

## Still open


- Living specs are generated from code at commit time. A glossary is not derivable
  from code – it is the vocabulary humans agreed on. Does spec sync leave it
  alone, and if so what keeps it from going stale?

The last one matters most. A glossary nothing maintains is exactly the stale
document this effort exists to remove.
