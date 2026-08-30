#!/usr/bin/env bash
# Lock main so only .github/workflows/promote.yml can move it.
#
# Run this once, by hand, with an admin `gh` login:
#
#   .github/setup-main-protection.sh
#
# WHAT THIS CHANGES:
#   1. Adds promotion-gate to main's required checks. Only promote.yml ever creates that
#      check, so a pull request into main without the promote-to-main label is missing it
#      and cannot merge.
#   2. Turns on enforce_admins, which applies that rule to admins too.
#   3. Creates the promote-to-main label.
#
# WHY THIS BLOCKS PEOPLE AND NOT THE WORKFLOW: required status checks block a merge and a
# push alike. promote.yml posts promotion-gate green on dev's tip immediately before it
# moves the ref, so the workflow's push passes and nothing else does.
#
# WHAT IT DOES NOT DO: an admin can still turn protection off in the repository settings.
# No configuration prevents that, on any plan. This makes merging into main impossible,
# not repository administration.
#
# The script reads the change back and refuses to report success on an unverified write.
# docs/adr/0010-promote-dev-to-main-by-fast-forward.md records the reasoning.

set -euo pipefail

REPO="${REPO:-ac8318740/spechub}"

say() { printf '\n== %s\n' "$*"; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

say "1. Set main's branch protection"
# strict is false on purpose. It means "require the branch to be up to date before
# merging", and merging into main is exactly the path this protection removes.
#
# required_linear_history is absent on purpose. dev collects a merge commit per feature
# pull request, and main inherits all of them on a fast-forward. Requiring linear history
# would describe a shape main never has.
cat > "$tmp" <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["version-gate", "tests", "promotion-gate"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
if ! gh api -X PUT "repos/${REPO}/branches/main/protection" --input "$tmp" >/dev/null 2>&1; then
  echo "GitHub refused the protection update. Check that your gh login has admin on ${REPO}." >&2
  exit 1
fi
echo "Applied."

say "2. Verify it landed"
# Read the write back rather than trusting the PUT, per ADR-0009.
got=$(gh api "repos/${REPO}/branches/main/protection" \
  --jq '"\(.required_status_checks.contexts | sort | join(",")) \(.enforce_admins.enabled)"' 2>/dev/null || echo "")
want="promotion-gate,tests,version-gate true"
if [ "$got" != "$want" ]; then
  echo "main's protection reads '${got}', not '${want}'. Merging into main is not blocked yet." >&2
  exit 1
fi
echo "main requires promotion-gate, tests, and version-gate, and the rules apply to admins."

say "3. Create the promote-to-main label"
if gh label create promote-to-main --repo "$REPO" \
     --color 0E8A16 \
     --description "Fast-forward main to dev. Adding this runs .github/workflows/promote.yml." >/dev/null 2>&1; then
  echo "Created."
else
  echo "Already there."
fi

say "Done"
cat <<'TEXT'
Nothing else to set up. No secret, no App, no token.

To promote: open a pull request from dev into main, review it, and add the
promote-to-main label.
TEXT
