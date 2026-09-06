# The map root carries no status of its own

A map's root node has no status of its own. Its state follows its subtree: open while any node below it is open, fog, or claimed, and resolved otherwise.

The frontier never returns the root. `archive` closes it when the map clears.

Before this, the map skill created the root as resolved and nothing ever changed it. The field called the destination resolved while eleven nodes below it were still open.

On GitHub, `gh issue create` opened the root issue and nothing closed it. The two backends disagreed, and the GitHub frontier returned its own root.

## Considered options

- Keep the root resolved at creation, and let the frontier skip it as a resolved node. Rejected: a green root on an open map misreads on every diagram. A closed issue at the top of an open map misreads on GitHub.
- Store the derived status on the root and rewrite it after every resolution. Rejected: every writer would have to recompute the subtree, and one missed write leaves a stale field. Deriving it at read time cannot drift.

## Consequences

- The root is the one node whose stored status means nothing on its own. The diagram prints a count in its place, for example `#229 destination - 11 of 13 open`.
- The frontier has one structural exception: the node with no `answers`. Both backends share it, because the diagram renderer runs the same function over GitHub nodes.
- `archive` gains a step. After its gate passes, it resolves the root, then disposes of the map. Its gate ignores the root, or an open root would fail every map.
- A root closed before this decision stays closed. Nothing reopens history.
