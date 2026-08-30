# Files tracker

The fallback backend: no auth, works offline, works on any remote. One
markdown file per node under `spechub/maps/<name>/`, managed by the SpecHub
CLI. Nodes here are transient working state – scratch discarded once the map
clears.

Suggest adding `spechub/maps/` to `.gitignore` when you first create the
map.

CLI path: `~/.claude/spechub/bin/spechub`

To enumerate a project's maps: `ls spechub/maps/`.

## The four operations

| Operation | Command |
| --------- | ------- |
| create    | `spechub node create --map <name> --title <t> [--status] [--mode] [--kind] [--answers <id>] [--blocked-by <ids>] [--pinned] [--body <md>]` |
| read      | `spechub node read <id> --map <name> [--json]` |
| update    | `spechub node update <id> --map <name> [--title] [--status] [--mode] [--kind] [--answers] [--blocked-by] [--pinned true\|false] [--body] [--body-file] [--append-body]` |
| list      | `spechub node list --map <name> [--status <s>] [--json]` |

## Composed queries

The CLI builds composed queries from the four operations above, rather than
storing them.
The CLI ships the two this backend would otherwise recompute by hand every
session:

- `spechub node frontier --map <name> [--mode hitl|afk] [--json]` – open
  nodes with no unresolved blockers, shallowest provenance depth first.
  Provenance depth is how many `answers` links separate a node from the root.

- `spechub node walk --map <name> [--full] [--json]` – the packaging walk:
  the root first, then each node that hangs off it, depth first. The walk
  prints the root and pinned nodes in full.

Claim and resolve are `update` calls:

```bash
spechub node update <id> --map <name> --status claimed
spechub node update <id> --map <name> --status resolved --append-body "## Answer
..."
```
