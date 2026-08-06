---
status: resolved
mode: afk
kind: task
answers: 001
blocked-by: []
---

# Nothing writes domain-map.yaml, so spec sync is dead on a fresh install

## Question

Eight places read `spechub/domain-map.yaml`. Nothing writes it. `/spechub:init`
does not mention it. On a fresh install the file is absent, so every spec-sync
path takes its no-domain-map branch and skips silently.

Living specs are the durable half of this design, and spec sync is the one thing
the redesign does not replace. It should not stay broken while the rest is built.

## Why this is a work node, not a question

There is nothing to decide. The behaviour is wrong, the fix is generation at init
time, and no judgement is needed first. `mode: afk`, so it does not consume the
one-HITL-node-per-session budget.

## Answer

Fixed in 0.12.2 on two paths, because init only ever runs once.

**New installs** – `/spechub:init` gained Step 5, which explores
`directories.source`, proposes 3 to 10 domains grouped by responsibility rather
than by layer, confirms them, and writes the file. Greenfield projects get a
commented starter instead of invented domains. The init report now names the
file, so a missing map is visible rather than silent.

**Existing installs** – `/spechub:config check` gained check 2, which applies to
every project rather than only those with a frontend. It reports what a missing
map costs, offers to build one, and proposes existing `spechub/specs/` domain
names first so a rename cannot orphan a `spec.md`.

Behaviour only. No file paths, resolved at claim time.

## Note on the fix

Both paths route through the same procedure in `init` Step 5, so the generation
logic has one home. Diagnosis and generation stay separate: `config check` finds
the gap, `init` fills it.
