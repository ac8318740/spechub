---
status: resolved
mode: hitl
kind: grilling
answers: 020
blocked-by: []
---

# What replaces the handoff skill?

## Question

Node `020` left `handoff` as rewired but undecided. Upstream has two skills for
this: `productivity/handoff` writes a document for a fresh agent, and
`in-progress/claude-handoff` launches that agent directly with the summary as its
prompt. Ours does neither – it carries one session across compaction into itself.

## What upstream does that we do not

**References instead of restating.** Its rule: do not duplicate content already
captured in other artifacts – specs, plans, ADRs, issues, commits, diffs – and
reference them by path or URL instead.

Ours restates. Four of its ten sections are copies of state that already exists:
the task ledger duplicates `spechub status`, files in flight duplicates
`git status`, test and build state duplicates `.test-baseline`, workflow position
duplicates the change directory. Each copy is correct only at the instant it is
written.

**Redaction.** Upstream says to redact secrets and personal data explicitly. Ours
says nothing, and writes into the repository.

**Suggested skills.** Upstream names which skills the next agent should invoke.
Ours assumes the next session is the same session, so it never needed to.

**It launches the next session.** `claude-handoff` runs
`claude --bg --name "<name>" "<summary>"` and returns. No document to find, no
command for the user to run.

## Answer

A hybrid. Adopt the discipline, keep the one section upstream has no equivalent
for.

### Adopt

- **The de-duplication rule.** Reference `spechub status`, `git status`, the map.
  Never copy them. Under this design the provenance walk is already the state, so
  a handoff that restates it is a second copy of the map
- **Explicit redaction**, and the default location outside the repository
- **A suggested-skills section**
- **Launching the next session** rather than printing a command

### Keep

**Agent-team file ownership.** Which teammate owns which non-overlapping file set
has no upstream equivalent and cannot be derived from anything on disk. It is the
one part of our schema that is not a restatement.

### Drop

Task ledger, files in flight, test and build state, workflow position. Four of ten
sections, all derivable, all stale the moment anything moves. Workflow position
also hardcodes the router and the ladder that nodes `007` and `020` delete.

## The security problem this fixes

`spechub/HANDOFF.md` is written into the working tree, may contain anything that
was in context, and the skill only suggests the user might want to add it to
`.gitignore`. That is a suggestion, not a guarantee, on a file whose whole purpose
is to capture conversation state.

Upstream avoids it twice over: the OS temporary directory by default, and an
explicit instruction to redact. Both are worth taking regardless of the rest.

## Not adopted

**Free-form prose with no schema.** Fine for a linear conversation, but it would
lose file ownership on parallel work, which is the case a handoff matters most.

**Hardcoding `claude --bg`.** It is correct for this plugin today, but it bakes one
CLI's shape into a skill. Same objection node `003` raised about tracker backends:
name the behaviour, and let the invocation be resolved where it is known.
