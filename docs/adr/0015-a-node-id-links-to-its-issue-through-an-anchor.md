# A node id links to its issue through an anchor

A generated diagram wraps each node id in an HTML anchor pointing at its
issue. A reader clicks the id and lands on the node.

The mermaid `click` directive does the same job and does not work here.
GitHub renders at `securityLevel: strict`, and its Content Security Policy
blocks the `frame-src` that directive needs.

## Considered options

Shipping the id as plain text works in every renderer and costs a reader one
copy and one search per node.

The `click` directive is the documented way to link a node. GitHub's Content
Security Policy stops it.

## Consequences

GitHub documents none of this behaviour. A community thread reports it
working since March 2024, and GitHub has broken it once already. A second
break renders the label as literal `<a href=...>` text rather than plain
text.

The anchor wraps the id alone, never the whole label, so a link reads as a
link.

Its `href` takes single quotes, since the mermaid label is already
double-quoted. Mermaid rewrites anything matching `#<word>;` into a
private sentinel. So a quote inside a url becomes `&apos;` and never the
numeric `&#39;`, and `escapeLabel` turns every `#` a label carries into
`&num;`.

The GitHub renderer needs `url` in the `gh issue list --json` field list. It
has no other way to build the address, so that field is not optional.

The files backend draws plain ids. A node on disk has no address to link to.
