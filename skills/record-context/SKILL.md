---
name: record-context
description: Write durable records when a decision lands – an ADR if the decision is hard to reverse and surprising and a real trade-off, a glossary term if a term got pinned down, both, or neither. Invoke after a map node resolves or after an equivalent decision is settled in conversation. Neither is the common case; silence is a valid outcome.
---

# Record durable context

A decision just landed. Two independent tests decide what, if anything, it
leaves behind. Apply both; they share a trigger and nothing else.

## ADR – all three, or no ADR

Write an ADR only when the decision is:

1. **Hard to reverse** – undoing it later means real rework, not an edit.
2. **Surprising without context** – a competent newcomer would ask "why on
   earth is it like this?"
3. **A real trade-off** – something was genuinely given up. A choice with no
   losing side needs no record.

Most decisions meet none of these. Do not lower the bar – an ADR that records
an obvious choice buries the ones that matter.

### Writing one

- Path: `docs/adr/NNNN-slug.md`. Number is the highest existing number plus
  one, zero-padded to four digits. Create the directory lazily. If the file
  for that number appeared since you scanned (a parallel teammate wrote one),
  renumber to the new highest plus one. In agent teams, ADR writing is a
  shared-file concern – route it through the orchestrator or the sequential
  after-team step, never two teammates at once.
- Body: a `# title` heading, then one to three sentences stating the decision
  and the why. Optional short `## Considered options` and `## Consequences`
  sections when they carry weight the summary cannot.
- Tone: plain prose, en dashes, no emoji.

### The index is generated

After writing any ADR, rewrite `docs/adr/index.md` in full: one line per
ADR, sorted by number ascending, number and slug from the filename, title
from the file's first heading:

```markdown
- [0001](0001-one-node-type.md) – One node type for questions and work
```

Generated, never hand-edited – a derived view cannot drift from its source.
If you find hand edits in it, regenerate; the files are the truth.

## Glossary – when a term got pinned down

If the decision fixed what a word means – picked between competing names,
sharpened a fuzzy term, coined one – record it:

- **Cross-domain terms** go in `CONTEXT.md` at the repo root.
- **Domain terms** go in `spechub/specs/<domain>/CONTEXT.md`, beside that
  domain's `spec.md`. Find the domain in `spechub/domain-map.yaml`.
- Both files are created lazily, and there is no index file –
  `domain-map.yaml` already lists every domain.

Format: a `# Glossary` heading, then one `**term** – definition` line per
term, alphabetical, one or two sentences each. Glossary and nothing else – no
implementation notes, no specs, no scratch content. The moment it accepts
anything else it becomes another document competing with the living specs.

**The human wins.** A glossary records the vocabulary humans agreed on, so it
is never rewritten to match code. If code and glossary disagree, surface the
disagreement to the user; only a human decision changes the entry.

## Neither

If the decision fails the ADR bar and pinned down no term, write nothing and
say nothing. The durable trail for ordinary decisions is the resolved node
and the living specs.
