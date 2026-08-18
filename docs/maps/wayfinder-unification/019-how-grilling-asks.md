---
status: resolved
mode: hitl
kind: grilling
answers: 006
blocked-by: []
---

# How does grilling present a round?

## Question

The upstream `grilling` skill prescribes a fixed presentation: a question emoji,
a bold title, then an arrow emoji before the recommended answer. Claude Code also
offers a question tool that renders selectable options natively. Which does
SpecHub use?

## Answer

### No emoji

Emoji appear in one place in the whole plugin – the check marks in
`skills/config/SKILL.md`. Dropping them from grilling matches the house style
rather than making an exception to it.

`skills/clarify/SKILL.md:77` already has the convention: bold the recommended
option, put choices in a table. Grilling reuses it. A numbered round scans fine
on the numbers alone.

### `workflow.grilling.questions`, default `tool`

| Value    | Behaviour                                              |
| -------- | ------------------------------------------------------ |
| `tool`   | the host's question tool, one call per round            |
| `inline` | questions as prose in the reply, recommendation bolded |

Default `tool`. Selectable options are less work to answer than prose, and the
round is legible at a glance.

### The cap is mechanical, not a preference

The question tool accepts at most four questions per call, each with two to four
discrete options. A frontier is however wide the settled prerequisites make it,
and a grilling question is often open rather than a choice among options.

So `tool` falls back to inline for any round it cannot hold – more than four
questions, or a question with no discrete options. Never split one round across
two calls to fit the cap: a round is the whole frontier, and splitting it
reintroduces the ordering the frontier exists to prevent.

Whichever mode runs, an open answer must survive. When the reply fits none of the
offered options, the answer is the reply, not the nearest option.

## Note

`skills/clarify/SKILL.md` contradicts itself on the stop condition – a maximum of
ten questions in one place, five in another. Extracting the primitive is the point
to settle that, not carry it over.
