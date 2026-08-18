---
status: resolved
mode: hitl
kind: grilling
answers: 003
blocked-by: []
---

# Where do map nodes live, and do they survive the effort?

## Question

Node `001` says everything per-effort is transient. Node `003` says a map stored
as files is one more document that can go stale. Neither says where the files
backend writes, or what happens to the nodes once the effort closes. The design
record for this effort sits in `docs/maps/` and is committed forever, which is
the thing both nodes argue against.

## Answer

Two separate things that were being confused, plus one config axis.

### The design record is not tool output

`docs/` holds hand-written prose. `spechub/` holds what the tool manages –
`changes/`, `specs/`, `archive/`, `handoffs/`. This map stays in `docs/` because
it is a hand-written record of the redesign, permanent on purpose. The files
backend writes to `spechub/maps/<name>/` and never to `docs/`.

The path is the signal. A reader can tell which kind of thing they are looking
at without a convention to remember.

### Live nodes are transient working state

`spechub/maps/<name>/` follows the precedent already set for `spechub/HANDOFF.md`:
transient, suggested for `.gitignore`, not committed as part of feature work.

### Persistence is `workflow.maps.persist`, default `false`

| Value             | At archive                                                    |
| ----------------- | ------------------------------------------------------------- |
| `false` (default) | extract the durable residue, then delete the nodes            |
| `true`            | move nodes to `spechub/archive/[YYYY-MM-DD]-[name]/nodes/`    |

Durable residue is what it always was: ADRs, living spec updates, glossary
entries. That extraction runs either way. `persist` only decides whether the
nodes themselves outlive it.

Default `false` because the map is scaffolding. It exists to clear fog, and once
the fog is gone the answers have been promoted into specs and ADRs. Keeping the
nodes leaves a second copy of every decision, and the two drift.

## Consequences

A transient map does not survive a handoff to another device, because a
gitignored directory does not travel. That is the cost of the default, and the
escape hatch is the setting. The same is already true of `spechub/HANDOFF.md`.

Most users never hit this. Per node `003`, first-class backends are trackers, so
the map is not in the repo at all. This governs the offline fallback only.

## Not built yet

The config key ships with the files backend, not before. A documented key that
controls nothing is worse than an undocumented one – `/spechub:config set
workflow.maps.persist true` would report success and change nothing.
