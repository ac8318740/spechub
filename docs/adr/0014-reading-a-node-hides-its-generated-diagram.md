# Reading a node hides its generated diagram

`spechub node read` and `spechub node walk` strip generated blocks from their
human-readable output, and `--visuals` puts them back. `--json` always carries
the whole body.

A generated block repeats what the map already holds. An agent that can call
`spechub node frontier` gets those facts on demand, so a picture of them in
every read spends the context twice.

## Considered options

Keeping the whole body is the honest default. It costs an agent a diagram on
every read of every node. A map that draws one on each parent node makes that
cost grow with the map.

Stripping every mermaid fence would take the hand-drawn diagrams with it.
Those are the explanation the node exists to give.

## Consequences

Only the markers decide what goes. A hand-drawn diagram never sits inside
them, so the split is exact and needs no heuristic.

A reader who wants the picture passes `--visuals`. A caller composing
something parses `--json`, which never strips.

A node body that documents the markers keeps them. A marker inside a fenced
code block is prose about the markers, never a block.
