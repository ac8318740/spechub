# One node type for questions and work

SpecHub's fixed `proposal.md` / `design.md` / `tasks.md` ladder is replaced by a
single node primitive carrying a status, a `mode` of `hitl` or `afk`, one
provenance parent and any number of blocking edges. A question and an
implementation task are the same kind of node; only `mode` differs. We chose this
over two node kinds because a work item's extra state – which TDD phase it
reached, whether tests are written – is a resumption breadcrumb, and the claim
already expresses resumption. The pipeline runs to completion inside one claim,
so a node only ever moves `open -> claimed -> resolved`.

## Consequences

Wayfinder's rule of one ticket per session had to be restated. Research was its
only purely AFK type, so the rule was never about tickets but about human
attention: **one HITL node per session, AFK nodes unlimited and in parallel.**
Implementation still burns through many nodes per session via subagents.

Depth is derived from the provenance parent, never declared. An earlier draft
tagged nodes with altitudes; that reintroduced the rigid ladder as metadata and
was dropped.

Nodes describe behaviour, not file paths. A node can sit in the frontier for
weeks, so paths are resolved at claim time. This inverts `tasks.md`, which
mandated real paths from exploration – safe only because a task list is consumed
within hours.

`/implement`, `/archive` and `/handoff` all assume `tasks.md` today and must be
reworked. `/verify` cross-checks the three documents and is deleted.
