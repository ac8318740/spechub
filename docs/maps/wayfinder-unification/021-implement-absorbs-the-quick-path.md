---
status: resolved
mode: hitl
kind: grilling
answers: 020
blocked-by: []
---

# If implement-quick dies, where does its work go?

## Question

Node `020` deletes `implement-quick` because it only exists to serve
`workflow.auto_select`, and node `007` rejected that router. But it does two things
worth keeping: it runs a short path, and it runs three parallel explorer subagents
over the relevant code before writing anything.

## Answer

### `implement` absorbs the short path by having no fixed size

A work node is claimed from the frontier and run. Effort follows the node, so one
small node is a quick change and forty nodes is a long effort. Nothing declares
which, and no skill has to be chosen.

This is node `007`'s progressive materialisation applied to building rather than
planning. `implement-quick` existed to answer a question – how big is this? – that
the design no longer asks.

### The three explorers become a rule in two places, not a skill

The pattern is: before acting, dispatch parallel explorer subagents over the
relevant code, then act on what they find.

`grilling` already prescribes exactly this for questions – finding facts is the
agent's job, never the user's, so a frontier question needing an environment fact
dispatches a subagent rather than asking. `implement-quick` prescribes the same
thing for code changes. Same mechanism, different trigger.

So it is stated as a rule in the grilling primitive and in `implement`, and it does
not become a skill. A skill would add a concept while deleting none, and the
built-in `Explore` subagent already does the work.

Dropped from the pattern: the fixed count of three. Fan-out should follow how many
distinct places need looking at, which is what the node is about. Three was a
default dressed as a rule.

## What this deletes

`implement-quick`, `workflow.auto_select`, and the path-selection section of
`CLAUDE.md`. One skill, one config key, and the decision that node `001` blamed for
SpecHub going unused – deciding whether SpecHub applied was itself a decision.
