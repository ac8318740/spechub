---
status: fog
mode: hitl
kind: grilling
answers: 003
blocked-by: []
---

# What happens when two sessions work one graph on the files backend?

## Question

Something about concurrency. On a hosted tracker, a claim is a write other
sessions can see immediately. On the files backend, two sessions claiming
different nodes both touch the same directory, and the design assumes sessions
run in parallel.

Not sharp yet. It may turn out to be nothing – separate files, separate writes –
or it may need a claim convention that survives a merge. The shape of the answer
depends on whether the files backend is expected to work across machines or only
within one working tree, which is not yet decided.
