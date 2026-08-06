---
status: resolved
mode: hitl
kind: grilling
blocked-by: []
---

# What does done look like for bringing Wayfinder into SpecHub?

## Question

SpecHub only fits a narrow band of work. Below it, plan mode is enough. Above
it, the three-document ladder is too much ceremony. What is the destination for
folding Matt Pocock's Wayfinder ideas in, and how will we know we reached it?

## Answer

A SpecHub whose planning structure grows only as far as the fog demands.

- One node primitive replaces `proposal.md`, `design.md` and `tasks.md`.
- Nodes live behind a pluggable tracker.
- Durable output is living specs, ADRs and a glossary. Everything per-effort is
  transient.
- The same entry point serves a one-question change and a fifty-question
  effort. Nothing declares which.

Done when the change **deletes more concepts than it adds**. If that stops being
true, stop.

## Why this effort exists

Across three projects, five changes were started and every one was abandoned at
the same point: `proposal.md`, `design.md` and `tasks.md` all written, then
nothing. Last activity was roughly three months before this effort began.

The failure is structural, not a lack of discipline. A document is useless until
it is complete, so the full planning cost is paid before any value is returned.
A question is useful the moment it closes. SpecHub also asks planning to take
about four times the effort of implementation, then hands over three blank
templates to pay that into.

## Standing preferences for this effort

- En dashes only. Short sentences. Active voice.
- Skills stay markdown. The CLI stays thin – a scaffolder and a query tool, not
  a workflow engine.
- Any step that adds a concept must name one it removes.
- The plugin is public. No project, employer, person or internal host names in
  anything committed here.
