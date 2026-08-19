---
status: resolved
mode: hitl
kind: grilling
answers: 006
blocked-by: []
---

# Does a session settle one node or the whole frontier?

## Question

Two rules that both look right and disagree.

The map derives **one HITL node per session**, from Wayfinder's one-ticket-per-
session rule. It keeps context small and makes each session's output reviewable.

The upstream `grilling` skill asks the **whole frontier in one round** – number
every question whose prerequisites are settled, give a recommended answer for
each, wait, recompute, repeat. Node `006` adopts `grilling` as the primitive.

If a map session runs `grilling`, it asks the whole frontier, and the one-node
rule is broken by the primitive the design just adopted.

## Answer

The whole frontier. **The one-HITL-node-per-session rule is deleted.**

Session means one agent session, which is what made the rule look bigger than it
was. It never protected context – it protected against asking a question whose
answer depends on one still open. The definition of the frontier already
guarantees that, so the rule was a blunt proxy for a guarantee already in place.

`grilling` therefore needs no cap, and node `006` adopts it unmodified.

The cost, accepted knowingly: several nodes resolved in one session is a larger
diff to review than one, and disagreeing with the third answer later leaves work
stacked on top of it. Grilling this map itself is the evidence – a dozen nodes
settled across a handful of rounds, with errors caught in the round they appeared.

What survives from the old rule: **the frontier is recomputed every round.** A
round's answers can surface new nodes and unblock old ones, and the next round
must be derived fresh rather than continuing down a list planned in advance.
