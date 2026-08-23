---
name: grilling
description: Interview technique for settling open decisions in rounds. A round asks the whole frontier – every question whose prerequisites are settled – numbered, each with a recommended answer, then recomputes and repeats. Use whenever decisions need a human and requirements are foggy, with or without a map. Called by /spechub:map for charting and frontier work; also usable directly in conversation.
---

# Grilling

Grilling settles open decisions by asking the user a whole round of questions
at once. One technique at two scales.

The frontier is the set of questions ready to ask – every open question whose
prerequisites are settled. In conversation you work it out as you go. On a
map – a stored graph of question and work nodes – you ask the tracker for it,
limited to `hitl` nodes, meaning the ones a human must answer rather than an
agent. On the files backend:

`~/.claude/spechub/bin/spechub node frontier --map <name> --mode hitl`

Other backends are declared in the map skill's `trackers/` docs. Same
structure either way – the only difference is whether the frontier outlives
the session.

## The round

1. **Compute the frontier.** Every question whose prerequisites are settled,
   nothing else. Never ask a question whose answer depends on one still open.
2. **Facts are your job, never the user's.** A question that an environment
   fact would answer is not a question for the human. Dispatch parallel
   `Explore` subagents – as many as there are distinct places to look, not a
   fixed count – and fold what they find into the round.
3. **Number the questions.** Attach a recommended answer to each, with one
   line of reasoning. A question you cannot recommend an answer for is usually
   two questions.
4. **Present the whole round at once** (see Presentation). One round, one
   message. Never trickle questions one at a time.
5. **Record each answer.** When the reply fits none of the offered options,
   the answer is the reply – never the nearest option.
6. **Recompute the frontier.** Answers surface new questions and unblock old
   ones. Derive the next round fresh. Never continue down a list planned in
   advance.

## Presentation

`workflow.grilling.questions` in `spechub/project.yaml` picks the mode:

| Value            | Behaviour                                                  |
| ---------------- | ---------------------------------------------------------- |
| `tool` (default) | the host's question tool (AskUserQuestion), one call per round |
| `inline`         | questions as prose in the reply                             |

**`tool` falls back to inline** for any round it cannot hold: more than 4
questions, or any question with no discrete options. Never split one round
across two tool calls – a round is the whole frontier, and splitting it
reintroduces the ordering the frontier exists to prevent. In tool mode, put
the recommended option first with "(Recommended)".

**Inline format**: numbered questions, options in a table, the recommended
option **bolded** with its one-line reason. Prose follows the `writing` skill.

Whichever mode runs, an open answer survives: if the user types something no
option covers, that text is the answer.

## Stop condition

Stop when the frontier is empty, or the user signals stop ("stop", "done",
"proceed"). There is no question cap. The frontier is already bounded by
settled prerequisites, and provenance keeps it narrow – every question hangs
off the answer that surfaced it, so nothing unrelated can join the round. A
cap would be a blunt proxy for a guarantee the frontier definition provides.

## On a map

When the questions are map nodes, each answer is a resolution – all through
the tracker's `update` and `create` operations:

1. Append the answer to the node body under `## Answer` and mark the node
   resolved (on the files backend, one `spechub node update` call does both).
   Write the answer per the `writing` skill.
2. Create a node for each new question the answer surfaced, with `answers`
   naming the node that surfaced it. Questions that can be stated precisely
   are `open`; the rest are `fog`.
3. Invoke the `record-context` skill for each resolution – it decides whether
   the decision earns an ADR, a glossary term, both, or neither.
4. Recompute the frontier with the tracker's query and present the next
   round.

**Example** – the `## Answer` body of a node asking whether map nodes
belong in git:

```markdown
## Answer

Map nodes stay out of git. `spechub/maps/` goes in `.gitignore`, because a
node is working state that the map throws away once it clears.

The durable output is the living specs, the architecture decision records and
the glossary. The `record-context` skill extracts each one as a node
resolves, so nothing of lasting value leaves with the nodes.
```
