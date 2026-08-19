---
name: grilling
description: Interview technique for settling open decisions in rounds. A round asks the whole frontier – every question whose prerequisites are settled – numbered, each with a recommended answer, then recomputes and repeats. Use whenever decisions need a human and requirements are foggy, with or without a map. Called by /spechub:map for charting and frontier work; also usable directly in conversation.
---

# Grilling

One technique at two scales. In conversation, the frontier is every open
question whose prerequisites are settled. On a map, it is what
`~/.claude/spechub/bin/spechub node frontier --map <name> --mode hitl` returns.
Same structure either way – the only difference is whether it outlives the
session.

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
option **bolded** with its one-line reason. No emoji.

Whichever mode runs, an open answer survives: if the user types something no
option covers, that text is the answer.

## Stop condition

Stop when the frontier is empty, or the user signals stop ("stop", "done",
"proceed"). There is no question cap. The frontier is already bounded by
settled prerequisites, and provenance keeps it narrow – a cap would be a
blunt proxy for a guarantee the frontier definition provides.

## On a map

When the questions are map nodes, each answer is a resolution:

1. Append the answer to the node body under `## Answer`, set
   `--status resolved` (one `spechub node update` call does both).
2. Create a node for each new question the answer surfaced, with
   `--answers <id of the node that surfaced it>`. Questions that can be
   stated precisely are `open`; the rest are `fog`.
3. Invoke the `record-context` skill for each resolution – it decides whether
   the decision earns an ADR, a glossary term, both, or neither.
4. Recompute with `spechub node frontier` and present the next round.
