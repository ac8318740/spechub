# GitHub tracker

First-class backend. A node is an issue, so the map is visible to the whole
team, survives every device, and needs no sync. Requires `gh` authenticated
against the repo's GitHub remote.

## Mapping

| Node concept | GitHub |
| ------------ | ------ |
| node id      | the issue number |
| map          | label `map:<name>` on every node |
| title, body  | issue title and body |
| `answers`    | native sub-issue link – the parent is the provenance parent |
| `blocked-by` | native issue dependencies (blocked by) |
| `fog`        | open issue, label `fog` |
| `open`       | open issue, no `fog` or `claimed` label |
| `claimed`    | open issue, label `claimed` |
| `resolved`   | closed as completed |
| `out-of-scope` | closed as not planned |
| `mode: afk`  | label `afk` (no label means `hitl`) |
| `kind`       | label `kind:<value>` |
| `pinned`     | label `pinned` |

Create the labels once at materialisation:

```bash
for l in "map:<name>" fog claimed afk pinned; do gh label create "$l" 2>/dev/null || true; done
```

`kind:<value>` labels are free text, so create each one on first use:

```bash
gh label create "kind:<k>" 2>/dev/null || true
```

To enumerate a repo's maps: `gh label list --search "map:" --json name`.

## The four operations

**create**

```bash
gh issue create --title "<title>" --body "<markdown>" --label "map:<name>[,fog][,claimed][,afk][,pinned][,kind:<k>]"
```

Then link the provenance parent (every node except the root has one):

```bash
child_id=$(gh api repos/{owner}/{repo}/issues/<child> --jq .id)
gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=$child_id
```

And each blocking edge:

```bash
blocker_id=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)
gh api -X POST repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by -F issue_id=$blocker_id
```

**read**

```bash
gh issue view <n> --json number,title,body,state,stateReason,labels
gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by --jq '.[].number'
gh api graphql -f query='query { repository(owner:"{owner}", name:"{repo}") { issue(number:<n>) { parent { number } } } }'
```

**update**

- Fields: `gh issue edit <n> --add-label / --remove-label / --title / --body`
- Claim: `gh issue edit <n> --add-label claimed`; release removes it
- Resolve: append the answer to the body, then `gh issue close <n> --reason completed`
- Out of scope: `gh issue close <n> --reason "not planned"`
- Graduate fog: `gh issue edit <n> --remove-label fog`

**list**

```bash
gh issue list --label "map:<name>" --state all --limit 500 --json number,title,state,stateReason,labels
```

`--limit` caps the result and closed issues count toward it, so history alone
can hit the ceiling. If the result count equals the limit, re-query with a
higher one – a truncated list silently corrupts every composed query.

## Composed queries

- **Frontier**: from `list`, keep open issues without `fog` or `claimed`
  labels, then drop any whose `blocked_by` list contains an open issue.
  Order by provenance depth (walk `parent` links up to the root), issue
  number as the final tiebreak.
- **Walk**: start at the root (the map-labelled issue with no parent),
  recurse over sub-issues in number order. Read `pinned` nodes and the root
  in full; for the rest, take the title as the gist and do not open the body.
- Depth is derived from the parent chain, never stored.

## Degraded remotes

A degraded remote is one where GitHub's native link features are off or not
permitted, so the edges between nodes cannot be stored as real links.
Sub-issues and dependencies need a repo where those features are enabled. If
either API returns 404 or 403, fall back to declaring the edge in the issue
body header instead – one line, first in the body:

```
node-links: answers #12 · blocked-by #14, #17
```

Use the same line for reading when the APIs are unavailable. Do not mix
encodings within one map – pick per map at materialisation and note it on the
root node. If the APIs degrade mid-map after native edges already exist,
transcribe the existing edges into body headers before continuing.
