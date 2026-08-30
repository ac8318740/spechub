# The node body header is the authoritative edge encoding on GitHub

Every map node on the GitHub tracker opens its body with one header line. It names the node's map, its root, its `answers` parent, its `blocked-by` ids, and its short `label`. Every composed query reads its edges from that line.

The tracker still writes GitHub's native sub-issue and dependency links. Those links drive GitHub's own interface, and no query reads them.

The header costs one `gh issue list` call to read the whole graph, because `body` is one of the fields that command returns.

## Considered options

- Read the edges from GitHub's native links. Rejected: the parent needs a GraphQL query and the blockers need a REST call, both per issue. A forty-node map would spend eighty calls on every frontier recompute.
- Drop the native links and keep only the header. Rejected: the links render a map inside GitHub's own issue interface. That is half the reason to pick this tracker.
- Give the files backend the same header. Rejected: its frontmatter already holds `answers` and `blocked-by`, and its directory name is the map. A header there would copy data the CLI owns, free to drift from it.

## Consequences

- One edge lives in two places on GitHub. The tracker doc states the dual write as a single step, for adding an edge and for removing one. A write that updates one copy alone leaves the two out of step.
- A degraded remote, meaning one where GitHub's link features are off, now loses only the link interface. Every query keeps working. The tracker needs no second encoding and no per-map choice between them.
- A reader landing on an issue from a notification sees which map it belongs to and what sits above it. The issue title alone never told them.
- The two backends no longer share one body shape. A header line on GitHub, frontmatter on files.
