# A tracker backend declares four operations, not six

Node storage is pluggable, and a backend declares only `create`, `read`,
`update` and `list`. Frontier, claim and resolve are compositions over those:
frontier is `list` plus a filter, claim is an `update`, resolve is an `update`.
Wayfinder defines six bespoke semantic operations instead, and that is what makes
bringing your own tracker feel heavy; four are the obvious questions anyone can
answer about any tracker.

## Considered options

Six semantic operations, as Wayfinder specifies them. Rejected: three of the six
are derivable, and every non-derivable operation is a semantics negotiation with
whoever writes a new backend.

## Consequences

Support comes in three tiers. GitHub is first-class, because native sub-issues
and native dependencies map onto the two link types directly. Files in the repo
are the fallback – no auth, offline, any remote. Anything else goes through a
setup skill that interviews the user and writes a backend doc, so a new tracker
needs no skill edits and no CLI code.

Only trackers a typical engineer would recognise get first-class support. Each
one hard-codes a CLI shape into the tooling and becomes permanent maintenance
surface.

Files are supported but not the default. A map stored as files is one more
document that can go stale, and removing stale documents is the point of the
change.
