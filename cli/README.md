# spechub-cli

The command-line half of [SpecHub](https://github.com/ac8318740/spechub) – a
spec-driven development workflow where an agent plans changes as a graph of
nodes before writing code.

Most people get this CLI by installing the SpecHub plugin for Claude Code, which
bundles it. Install it from npm when you want to drive a SpecHub project from
somewhere else: a different agent harness, a script, or CI.

```sh
npm install -g spechub-cli
spechub init
```

## What it does

The CLI owns the project state. It reads and writes `spechub/project.yaml` and
the change graph beside it, and it does nothing else – no model calls, no
network.

| Command | Purpose |
|---|---|
| `spechub init` | Set up SpecHub in a project |
| `spechub list` | List active changes or specs |
| `spechub show <name>` | Display a change or spec |
| `spechub node create/get/set` | Read and write graph nodes |
| `spechub node walk/frontier/path` | Traverse the graph |
| `spechub archive` | Archive a completed change |
| `spechub config` | Read and write project config |
| `spechub feedback` | Record feedback against a node |

Run `spechub --help`, or `spechub <command> --help`, for the full surface.

## Using it without the Claude Code plugin

The CLI gives you the graph operations. It does not carry the instructions that
tell an agent *how* to use them – those ship with the plugin as skills and
agent definitions. To drive SpecHub from another harness you need both: this
package, and a copy of the orchestrator guidance from the repository.

## Requirements

Node 20 or newer. The published bundle is self-contained and installs no
runtime dependencies.

## Licence

MIT.
