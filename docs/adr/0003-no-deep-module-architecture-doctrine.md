# SpecHub does not adopt deep-module architecture doctrine

SpecHub will not import an architecture-review skill built on deep modules and
narrow interfaces. The blocking reason is mechanical, not a matter of taste: that
doctrine instructs an agent to delete unit tests once a deepened interface
supersedes them, and SpecHub's task-checker fails any change where the test count
drops below `.test-baseline`. Adopting it would ship two rules that veto each
other.

Recorded so future architecture reviews do not re-suggest it.

## Considered options

Adopting it with the test-deletion rule stripped out. Rejected: the rule is not
incidental. Replace-don't-layer is how the doctrine keeps a deepened interface as
the single test surface, so removing it leaves the doctrine without its testing
strategy.

## Consequences

The presentation pattern was taken and the doctrine left behind: scan, present
candidates with a before-and-after visual and a strength badge, let the user pick
one, then grill that one. It is useful wherever several options need a human
decision and carries no architectural position. Note it assumes browser and
network access if the report is rendered with CDN-loaded libraries.

SpecHub therefore has no opinion on module shape, and reviews should not acquire
one by importing a vocabulary that bans words like component, service or
boundary.
