# A PR gate enforces the version bump; CI never bumps it

The Claude Code plugin cache is keyed by the version in
`.claude-plugin/plugin.json`, so a merge to `main` that does not change the
version is invisible to every installed copy. A pull request gate
(`scripts/version-gate.sh`, run by the `version-gate` workflow) fails the check
when a shipped path changed without a higher version, rather than CI bumping
the version itself. The author decides the semver level, because deriving it
from commit message prefixes is brittle and gets the level wrong exactly when
it matters.

## Considered options

- **Auto-bump on push to `main`.** CI raises the patch version whenever shipped
  files land. Removes the failure, but a feature or a breaking change ships as
  a patch, and CI has to write to `main`.
- **release-please.** Derives the level from Conventional Commit prefixes and
  opens a release pull request. Correct only when every commit is labelled
  correctly, which squashed merges and hand-written subjects do not guarantee.
- **A pull request gate.** CI refuses the merge; a human sets the version.
  Chosen.

## Consequences

- `main` needs branch protection with `version-gate` as a required status
  check. Without it the gate is advisory.
- A shipped change that genuinely should not roll out needs the `no-bump` label
  on the pull request. A version that goes down fails even with the label.
- Documentation-only paths are exempt, listed as `INERT_PATHS` in the script
  and duplicated in CONTRIBUTING.md. The two lists have to be kept in sync by
  hand.
