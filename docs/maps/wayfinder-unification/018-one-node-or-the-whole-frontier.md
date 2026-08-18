---
status: fog
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

## What needs deciding

Whether these are the same rule at different scales or a genuine conflict.

A reading that might hold: one node per session bounds what a session *resolves*
and commits, while a grilling round bounds what it *asks*. Asking six questions
and settling one is coherent, but it wastes five answers unless they are recorded,
and recording them means six nodes resolved, not one.

The opposite reading is that the one-node rule was inherited without being tested,
and batching the frontier is strictly better for a human who is already sitting
there. It costs context, which is the thing the rule was protecting.

Writing this map by hand is weak evidence for batching: answering several
questions in one message was normal and did not feel like too much at once.
