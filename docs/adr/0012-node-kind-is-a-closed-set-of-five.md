# A map node's kind is a closed set of five

A map node carries one `kind`. It is one of `destination`, `notes`, `decision`, `research`, or `work`.

The CLI enforces the set with a zod enum. It rejects anything else at create, at update, and on reading a stored file. Before this, `kind` was free text that the CLI called advisory only.

The five split in two. `destination` and `notes` are records, resolved the moment someone writes them. `decision`, `research`, and `work` are things still to settle.

Each has one test.

- `destination` is the root, one per map
- `notes` holds no question, and it binds every other node
- `decision` has two or more defensible answers
- `research` has one findable answer
- `work` ends in a diff

## Considered options

- Keep `kind` free text and let the generated legend list only the kinds a map happens to contain. Rejected: `kind` now picks a node's shape in the map diagram, and an unknown value has no drawing.
- Fix a set of six, to leave one slot spare. Rejected: every candidate sixth landed inside an existing kind. A bug is `work`, a spike is `research`, and a glossary term is a `decision` about what a word means.

## Consequences

- Five kinds map to five distinct mermaid shapes, so shape carries kind and the other channels are free for status, mode, and the frontier.
- Every node must name a kind, and nothing can clear it. A node with no kind has no shape, so the field cannot be optional.
- The enum rejects any map still carrying an older kind such as `grilling` or `task`. That is acceptable, because nodes are transient working state a map throws away at archive.
- `kind` and `mode` will agree most of the time, and the disagreements are the point. A `decision` node marked `afk` draws as a dashed rhombus, which is an agent about to settle something that was the human's.
