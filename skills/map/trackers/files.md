# Files tracker

The fallback backend: no auth, works offline, works on any remote. One
markdown file per node under `spechub/maps/<name>/`, managed by the SpecHub
CLI. Nodes here are transient working state – scratch that is thrown away
once the map clears, so suggest `spechub/maps/` for `.gitignore` when the map
is first written.

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

Composed queries are built from the four operations above rather than stored.
The CLI ships the two this backend would otherwise recompute by hand every
session:

- `spechub node frontier --map <name> [--mode hitl|afk] [--json]` – open
  nodes with no unresolved blockers, shallowest provenance depth first.
  Provenance depth is how many `answers` links separate a node from the root.
- `spechub node walk --map <name> [--full] [--json]` – the packaging walk:
  the root first, then each node that hangs off it, depth first, with the
  root and pinned nodes printed in full.

Claim and resolve are `update` calls:

```bash
spechub node update <id> --map <name> --status claimed
spechub node update <id> --map <name> --status resolved --append-body "## Answer
..."
```
