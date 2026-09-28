# The decision log

An afk run has no human watching it. The decision log is how that human later
sees what the agent chose, and why. Read this file before you write the first
row.

## When to write a row

Write one row per decision point, never one per action:

- **A fork chosen** – two ways to build something, and you picked one
- **A unit verified** – a node's checker passed, or a build verification went green
- **A revert** – you undid work, and the row names what triggered it
- **A blocker** – something stopped the node, and the row names it

Running a test, reading a file, or dispatching a subagent is an action. It
gets no row.

## Where the log lives

The log is one file per map, in the main checkout:
`<main checkout>/spechub/.decisions/<name>.tsv`. The `<name>` is the map name
you pass to `--map`.

Write it in the main checkout, never in a worktree. Removing a worktree
deletes its gitignored files, so a log there vanishes before `archive` reads
it. Find the main checkout from any worktree:

```bash
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
```

Nobody commits the log. When you first create the `spechub/.decisions/`
directory, write `.gitignore` inside it, containing a single line:

```text
*
```

## What a row holds

A row is one tab-separated line with six columns, in this order:

| Column | Holds |
| --- | --- |
| `ts` | the time, in ISO 8601 |
| `node` | the node id |
| `decision` | what you chose, verified, reverted, or hit |
| `why` | the reason, in one short phrase |
| `evidence` | a pointer: a commit SHA, a `file:line`, or a path |
| `result` | what happened next |

- **Evidence is a pointer, never prose**, so a reader can follow it to the proof
- **Keep tabs and newlines out of every field**, because each one breaks the row

## Append only

Never edit or delete a row. A wrong call gets a new row that supersedes it,
and its `why` names the row it replaces.

`/spechub:archive` reads the log before it closes the map. It hands lasting
decisions to `record-context`, then deletes the log file.
