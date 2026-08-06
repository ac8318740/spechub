---
status: resolved
mode: hitl
kind: grilling
answers: 001
blocked-by: []
---

# What contract must a tracker satisfy?

## Question

Nodes should be able to live on GitHub issues, on a hosted tracker, or as files
in the repo. Users must be able to bring a tracker nobody has built support for.
How small can the backend contract be?

## Answer

Four operations: `create`, `read`, `update`, `list`.

Frontier, claim and resolve are compositions, not backend concerns:

| Operation | Composed from                          |
| --------- | -------------------------------------- |
| frontier  | `list`, then filter open and unblocked |
| claim     | `update` status to claimed             |
| resolve   | `update` status and answer             |

Three tiers of support:

- **First-class** – GitHub issues, then GitLab. Native sub-issues and native
  dependencies map onto the two link types directly.
- **Fallback** – files in the repo. No auth, works offline, works on any remote,
  diffs beside the living specs.
- **Custom** – a setup skill interviews the user about their tracker and writes
  a backend doc declaring the four operations. No skill edits, no CLI code.

Only trackers a typical engineer would recognise get first-class support. Every
backend hard-codes a CLI shape into the tooling and becomes permanent
maintenance surface. Everything else goes through the custom path.

Files stay supported, but as the fallback rather than the default. A map stored
as files is one more document that can go stale, and stale documents are what
this effort removes.

Rejected: six bespoke semantic operations, the way Wayfinder defines them. Six
is what made bring-your-own-tracker feel heavy. Four are the obvious questions
anyone can answer about any tracker.
