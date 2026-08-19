# Files tracker

The fallback backend: no auth, works offline, works on any remote. One
markdown file per node under `spechub/maps/<name>/`, managed by the SpecHub
CLI. Nodes here are transient working state – suggest `spechub/maps/` for
`.gitignore` at materialisation.

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

The CLI ships the two compositions this backend would otherwise recompute by
hand every session:

- `spechub node frontier --map <name> [--mode hitl|afk] [--json]` – open
  nodes with no unresolved blockers, shallowest provenance depth first.
- `spechub node walk --map <name> [--full] [--json]` – the packaging walk:
  preorder over the provenance tree, root and pinned nodes in full.

Claim and resolve are `update` calls:

```bash
spechub node update <id> --map <name> --status claimed
spechub node update <id> --map <name> --status resolved --append-body "## Answer
..."
```
