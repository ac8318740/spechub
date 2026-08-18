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

### `workflow.grilling.questions`, default `inline`

| Value    | Behaviour                                              |
| -------- | ------------------------------------------------------ |
| `inline` | questions as prose in the reply, recommendation bolded |
| `tool`   | the host's question tool, one call per round           |

Default `inline` for two reasons, both about capability rather than taste.

The question tool caps a call at four questions with two to four discrete options
each. A frontier is however wide the settled prerequisites make it, so a round can
exceed four, and a grilling question is often open rather than a choice among
options. Inline has no cap and no shape requirement.

Observed too: over one long design session the tool was offered repeatedly and the
answer came back as prose that fitted none of the options roughly as often as it
fitted one. Forcing a shape on an answer loses the part that did not fit.

### When `tool` is set

Use it, and fall back to inline for any round it cannot hold – more than four
questions, or a question with no discrete options. Never split one round across
two calls to fit the cap: a round is defined as the whole frontier, and splitting
it silently reintroduces the ordering the frontier exists to prevent.

## Note

`skills/clarify/SKILL.md` contradicts itself on the stop condition – a maximum of
ten questions in one place, five in another. Extracting the primitive is the point
to settle that, not carry it over.
