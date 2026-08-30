# The diagram renderer takes nodes in and never calls gh

`spechub node diagram` reads nodes and writes mermaid. It reads them from disk for a named map, or as JSON on stdin. It makes no network call and needs no authentication.

On the GitHub backend the agent runs the pipe itself:

```bash
gh issue list --label "map:<name>" --state all --limit 500 \
  --json number,title,body,state,stateReason,labels,url \
  | spechub node diagram --stdin
```

## Considered options

- Have the CLI run `gh issue list` itself behind a `--tracker github` flag. Rejected: the invocation would then live in both `cli/src/` and `skills/map/trackers/github.md`, and this repository's own rule is that one fact gets one home. It is also nicer for the agent, which is the whole case for it.
- Give the CLI a real GitHub backend that speaks to the API. Rejected: far larger than this effort needs, and it would put authentication inside a renderer.

## Consequences

- The renderer's tests are JSON fixtures. No subprocess, no network, no token, and 59 tests run in the same suite as everything else.
- Both backends reach one rendering path. One line branches on the backend, and the specification demands it: a node id wraps in an anchor when the node carries a URL.
- The agent runs two commands instead of one. `skills/map/trackers/github.md` states the pipe verbatim, so nobody composes it from memory.
- The CLI gained `readStdin`, because `readFileSync(0, 'utf-8')` fails with EAGAIN when a parent process hands over a non-blocking fd 0. An agent harness does exactly that.
