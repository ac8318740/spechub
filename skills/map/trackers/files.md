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
| create    | `spechub node create --map <name> --title <t> --kind <k> --label <l> [--status] [--mode] [--answers <id>] [--blocked-by <ids>] [--pinned] [--body <md>] [--body-file <path>]` |
| read      | `spechub node read <id> --map <name> [--json]` |
| update    | `spechub node update <id> --map <name> [--title] [--status] [--mode] [--kind] [--label] [--answers] [--blocked-by] [--pinned true\|false] [--body] [--body-file] [--append-body]` |
| list      | `spechub node list --map <name> [--status <s>] [--json]` |

`create` rejects a node that omits `--kind` or `--label`. `--kind` takes one of
`destination`, `notes`, `decision`, `research`, or `work`. `--label` takes the
node's short name for a diagram, at most four words and thirty characters.

## No body header

The GitHub backend opens every node body with a header line, because an issue
has nowhere else to put the fields. This backend writes none.

Frontmatter holds the same facts. `answers` and `blocked-by` sit there
directly, the map is the directory name, and the root is the node that
`answers` chains up to. A header here would copy data the CLI already owns
and would be free to drift from it.

`node read` prints the frontmatter, so a reader sees the same facts either
way.

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
