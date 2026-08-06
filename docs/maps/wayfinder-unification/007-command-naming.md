---
status: resolved
mode: hitl
kind: grilling
answers: 001
blocked-by: []
---

# What is the entry command called, and are there tiers?

## Question

With the ladder gone, how does a user enter? A router over several tiers, an
automatic complexity judgement, or explicitly named tiers they pick from?

## Answer

No tiers. One command: `/spechub:map`.

Tiers are the rigidity in another costume. The graph is however big the fog made
it, and nothing declares which band the work falls into:

| Fog surfaced | What happens                          |
| ------------ | ------------------------------------- |
| none         | the way was already clear – just do it |
| one node     | one grilling, an ADR, done             |
| many nodes   | work the frontier across sessions      |

The command is a noun, and which mode runs depends on whether a map already
exists – charting if not, working the frontier if so. One thing to remember,
which is the point: the reason SpecHub went unused was partly that deciding
whether it applied was itself a decision.

This also generalises Wayfinder's no-fog early exit. Wayfinder stops and asks
when the opening breadth-first grill surfaces nothing. Here it simply continues
at whatever scale is right, because the scale was never declared.

Rejected:

- **A router skill.** Nothing left to route between once tiers are gone.
- **Extending `workflow.auto_select`.** It judges complexity invisibly, after
  the fact, inside whichever skill happened to be invoked. Close to today's
  behaviour, which is the behaviour that stopped being used.
- **Four named tiers.** Puts the band decision on the user every time.

## Progressive materialisation

The machinery appears only when it has to persist. One session with one question
needs no map, because there is nothing to resume – grill it in conversation and
write the ADR. A map materialises on the tracker when the fog will outlive the
session.

The test is mechanical rather than a judgement about tiers: did the opening grill
surface more than one session's worth of fog?
