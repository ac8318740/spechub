# GitHub tracker

First-class backend. A node is an issue. The map is visible to the whole
team, survives every device, and needs no sync. It requires `gh` authenticated
against the repo's GitHub remote.

## Mapping

| Node concept | GitHub |
| ------------ | ------ |
| node id      | the issue number |
| map          | issue label `map:<name>` on every node |
| title, body  | issue title and body |
| `answers`    | the `answers:` field of the body header, mirrored as a native sub-issue link |
| `blocked-by` | the `blocked-by:` field of the body header, mirrored as a native issue dependency |
| `fog`        | open issue, issue label `fog` |
| `open`       | open issue, no `fog` or `claimed` issue label |
| `claimed`    | open issue, issue label `claimed` |
| `resolved`   | closed as completed |
| `out-of-scope` | closed as not planned |
| `mode: afk`  | issue label `afk` (its absence means `hitl`) |
| `kind`       | issue label `kind:<value>` |
| `pinned`     | issue label `pinned` |
| the root     | issue label `root-node` |
| node `label` | the `label:` field of the body header |

Create the labels once at materialisation:

```bash
for l in "map:<name>" fog claimed afk pinned root-node; do gh label create "$l" 2>/dev/null || true; done
```

The `root-node` label is how a reader and a query find the entry point.
Without it, finding the root means walking `parent` links until one is
missing, at one GraphQL call per hop.

`kind` is a closed set of five, so create all five at materialisation too:

```bash
for k in destination notes decision research work; do gh label create "kind:$k" 2>/dev/null || true; done
```

To enumerate a repo's maps: `gh label list --search "map:" --json name`.

## The four operations

**create**

```bash
gh issue create --title "<title>" --body "<markdown>" --label "map:<name>[,fog][,claimed][,afk][,pinned][,root-node][,kind:<k>]"
```

**Every body opens with the header line**, which is the first line of the
markdown and carries the node's whole place in the map:

```
map: <name> · root: #12 · answers: #19 · blocked-by: #14, #17 · label: Nodes in git?
```

- The root writes `root: this` and omits `answers`
- A node with no blockers omits `blocked-by`
- `label` is the node's short name, at most four words and thirty characters,
  never the full title

The header does two jobs. A reader landing on the issue from a notification
sees which map it belongs to and what sits above it. Every composed query
below reads its edges from the header, in one `list` call.

Then mirror the edges as native links. Nothing in this workflow reads them
back, because every query below reads the header. They exist so GitHub's own
sub-issue and dependency interface renders the map.

First the provenance parent, which every node except the root has:

```bash
child_id=$(gh api repos/{owner}/{repo}/issues/<child> --jq .id)
gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=$child_id
```

And each blocking edge, in the same step that wrote the header. One write
that skips the other leaves the two copies out of step.

```bash
blocker_id=$(gh api repos/{owner}/{repo}/issues/<blocker> --jq .id)
gh api -X POST repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by -F issue_id=$blocker_id
```

**read**

```bash
gh issue view <n> --json number,title,body,state,stateReason,labels,url
```

One call. The edges come from the body header, so the tracker calls neither
the dependencies API nor a GraphQL parent query.

**update**

- Fields: `gh issue edit <n> --add-label / --remove-label / --title / --body`
- Claim: `gh issue edit <n> --add-label claimed`. Release removes it.
- Resolve: append the answer to the body. Then run `gh issue close <n> --reason completed`
- Out of scope: `gh issue close <n> --reason "not planned"`
- Graduate fog: `gh issue edit <n> --remove-label fog`
- Change an edge: rewrite the header line **and** change the matching native
  link in the same step. Editing one copy alone leaves the two out of step.
- Remove a blocker: drop it from the header, then
  `gh api -X DELETE repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by/<blocker_id>`

**list**

```bash
gh issue list --label "map:<name>" --state all --limit 500 \
  --json number,title,body,state,stateReason,labels,url
```

`body` carries the edges and the node's `label`. `url` is the address a node
id links to in a generated diagram, which `visuals.md` will specify. Neither
field is optional.

`--limit` caps the result. Closed issues count toward it, so history alone
can hit the ceiling. If the result count equals the limit, re-query with a
higher one – a truncated list silently corrupts every composed query.

## Composed queries

Read every edge from the body header, never from the native links. One
`list` call returns the whole graph, because `body` is one of its fields.
Reading the native links instead costs a GraphQL query for the parent and a
REST call for the blockers, per issue, on every round.

- **Frontier**: from `list`, keep open issues without `fog` or `claimed`
  labels. Drop any whose header `blocked-by` names an open issue.
  Order by provenance depth (follow header `answers` up to the root), issue
  number as the final tiebreak.
- **Walk**: start at the issue labelled `root-node`, then recurse over the
  nodes whose header `answers` names it, in number order. Read the root and
  every `pinned` node in full, and take the title alone as the gist for the
  rest.
- The tracker derives depth from the header chain and never stores it.

## Degraded remotes

A degraded remote is one where GitHub's native link features are off or not
permitted. Sub-issues and dependencies need a repo with those features
enabled, and either API can return 404 or 403.

Nothing breaks. The body header already carries every edge and every query
already reads it, so a degraded remote loses only GitHub's own link interface.

Skip the failing API call and carry on. Note on the root node that the map
has no native links, so a later session does not retry them on every create.
