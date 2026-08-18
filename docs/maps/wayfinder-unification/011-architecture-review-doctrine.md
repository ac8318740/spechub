---
status: out-of-scope
mode: hitl
kind: grilling
answers: 006
blocked-by: []
---

# Should SpecHub adopt deep-module architecture review?

## Question

The upstream architecture review skill scans a codebase and proposes refactors,
then grills through whichever the user picks. Worth adopting, on the condition
that it not be opinionated about what the architecture should look like?

## Out of scope, and why

The condition is not met. The skill has no mode in which it proposes anything
other than deepening – turning shallow modules into deep ones. Its five scan
prompts are all shallowness detectors, and one names a widely-held style as a
defect: pure functions extracted for testability, where the real bugs hide in
how they are called. It also constrains how the agent may describe code, banning
component, service, API and boundary in favour of a fixed vocabulary.

Two points in its favour, for the record. It wants narrow public surfaces rather
than large files – depth is defined as a property of the interface, not the
implementation. And ports and adapters is prescribed only for one dependency
class, not everywhere.

The disqualifier is mechanical rather than a matter of taste. Its deepening guide
instructs the agent to delete unit tests that a deepened interface supersedes.
SpecHub's task-checker fails any change where the test count drops below
`.test-baseline`. Adopting it would ship two rules that veto each other.

## What was taken instead

The shape, not the doctrine: scan, present candidates with a before-and-after
visual and a strength badge, let the user pick one, then grill that one. Useful
for any moment where several options need a human decision, and independent of
any architectural position.

Note that even the shape carries a dependency – the report is specified as
Tailwind and Mermaid over CDN, so it needs browser and network access.

## Status note

Out-of-scope work never graduates. This returns only if the destination is
redrawn, and then as a fresh effort. It is recorded here rather than in the
resolved decisions, because a scope boundary is not a step on the route.
