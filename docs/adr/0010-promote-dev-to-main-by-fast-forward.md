# A labelled workflow fast-forwards main to dev, and nobody merges

SpecHub promotes `dev` to `main` by fast-forward. Open a pull request with base
`main` and head `dev`. Review it, then add the `promote-to-main` label.
`.github/workflows/promote.yml` checks six preconditions and moves
`refs/heads/main` to the commit the pull request carries.

GitHub then closes the pull request as merged on its own. `main` reaches every
commit on `dev`, which is what GitHub reads as merged. The workflow pushes with
`GITHUB_TOKEN`, so no credential sits at rest in this repository.

GitHub offers no fast-forward merge. Its three options are a merge commit, a
squash, and a rebase. Each one writes a commit to `main` that `dev` can never
contain, and that commit forces a back-merge afterwards.

Commits `ee41411` and `04602c7` are the last two the old flow cost. The open
question was how to stop a person merging into `main`. `GITHUB_TOKEN` bypasses
nothing, which rules out the usual answer.

## Considered options

A GitHub App can hold a bypass on a ruleset, so an App blocks the Merge button
outright. We rejected it for two reasons. Its private key would sit in a
repository secret and need rotating by hand, and this repository has one person
in it.

We rejected a fine-grained personal access token for two other reasons. It
expires silently. Its bypass would also come from the owner's admin role, which
leaves the Merge button open to the very person the rule binds.

We chose `GITHUB_TOKEN`. Nothing sits in a secret, the token expires when the
job ends, and GitHub scopes it to this repository.

That choice rules out a bypass, so the block comes from somewhere else. It comes
from a required check that no ordinary pull request ever gets: `promotion-gate`.
Only `promote.yml` creates it.

A pull request into `main` without the label is missing that check and cannot
merge. `enforce_admins` extends that to admins. The workflow posts the check
green immediately before it moves the ref, then flips it to failed if the push
does not land.

A personal repository could not have taken the App route anyway. The rulesets
API rejects the GitHub Actions integration as a bypass actor. Classic branch
protection rejects a bypass list outright.

Both errors came from this repository, and `promote.yml` quotes both messages.

## Consequences

`main` stays an ancestor of `dev` by construction. The next promotion therefore
fast-forwards too, and nothing is ever stranded on `main`.

Three things follow as rules rather than preferences. No merge commit, squash,
or rebase onto `main`. No cherry-pick onto `main`, since a new SHA makes the two
graphs diverge for good.

No back-merge of `main` into `dev` either. A fast-forward strands nothing there.

The Merge button works for about a second per promotion. That is the gap between
`promotion-gate` going green and the ref moving, inside a run an admin
triggered. Pressing it there writes a merge commit to `main`, and the
fast-forward then refuses and says so.

The gate step therefore sits as late in the job as it can. Every new
precondition belongs above it.

A push made with `GITHUB_TOKEN` starts no workflow runs. `tag-release.yml` would
never fire, and a promotion would tag nothing. `promote.yml` dispatches it
explicitly through `workflow_dispatch`. GitHub documents that event as always
creating a run.

Nothing enforces that coupling. Add any future workflow that triggers on a push
to `main` to the dispatch step by hand.

`tag-release.yml` no longer compares `HEAD` against `HEAD~1`. A fast-forward
carries every commit `dev` collected, so `HEAD~1` is the second-newest `dev`
commit rather than `main`'s previous tip.

Most of those commits leave the version alone, so the old comparison would read
"unchanged" and skip the tag. The workflow now tags whatever version `main`
holds, unless that tag already exists.

The label that starts a promotion used to sabotage it. `version-gate.yml`
triggers on `labeled` and `unlabeled`, so adding `promote-to-main` started a
fresh `version-gate` run on the same commit.

That run is pending while the promotion reads the checks and pushes, and branch
protection refuses a push whose required check is pending. Removing and re-adding
the label fired the gate twice more, so the advice for a stuck promotion made it
permanent.

`version-gate.yml` now skips every label event except `no-bump`. That is the one
label which changes its verdict. A skipped job reports as passing, so the earlier
green run still stands.

`promote.yml` also waits up to ten minutes on a pending or absent check, rather
than refusing it.

The close step looks the gate up by name on the commit, not by the id the open
step captured. A `POST` can land while `gh` still exits non-zero on a dropped
response read. Trusting that id would leave the gate green and the pull request
mergeable by hand.

One hole stays open. A runner killed between the gate opening and the ref moving
leaves `promotion-gate` green with no job left to close it. Close the pull
request, or set that check run to `failure` by hand.

An admin can still turn branch protection off in the repository settings. No
configuration prevents that on any plan. This decision makes merging into `main`
impossible, not repository administration.

`promote.yml` names five CI checks by their `name:` values in `ci.yml`,
`tests.yml`, and `version-gate.yml`. Rename a job in one place without the
other, and every promotion blocks. The workflow says so when it happens.
