---
name: record-context
description: Write durable records when a decision lands – an architecture decision record (ADR), a short file stating one decision and why, if the decision is hard to reverse and surprising and a real trade-off; a glossary entry if a term got settled; both, or neither. Invoke after a map node resolves or after an equivalent decision is settled in conversation. Neither is the common case; silence is a valid outcome.
---

# Record durable context

A decision just landed. Two independent tests decide what, if anything, it
leaves behind. Apply both; they share a trigger and nothing else.

## ADR – all three, or no ADR

An ADR is an architecture decision record: a short file that states one
decision and the reasoning behind it. Write one only when the decision is:

1. **Hard to reverse** – undoing it later means real rework, not an edit.
2. **Surprising without context** – a competent newcomer would ask "why on
   earth is it like this?"

3. **A real trade-off** – the decision gives something up. A choice with no
   losing side needs no record.

Most decisions meet none of these. Do not lower the bar – an ADR that records
an obvious choice buries the ones that matter.

### Writing one

- Path: `docs/adr/NNNN-slug.md`. The number is the highest existing number plus
  one, zero-padded to four digits. Create the directory lazily.

    If the file for that number appeared since you scanned (a parallel teammate
    wrote one), renumber to the new highest plus one. In agent teams, ADR
    writing is a shared-file concern – route it through the orchestrator or the
    sequential after-team step, never two teammates at once.

- Body: a `# title` heading, then one to three sentences stating the decision
  and the why. Optional short `## Considered options` and `## Consequences`
  sections when they carry weight the summary cannot.

- Tone: per the `writing` skill.

### Example

`docs/adr/0004-invariant-tool-path.md`:

```markdown
# One invariant path for the command line tool

Every skill calls the command line tool for SpecHub as
`~/.claude/spechub/bin/spechub`. The SessionStart hook repoints that symlink
at the copy inside the current plugin cache. A version bump moves the target.
No skill file changes.

## Considered options

A bare `spechub` command reads the user's shell PATH. A subshell, a fresh
agent context and a continuous integration run each start without that PATH.

## Consequences

A skill that runs before the hook finds no symlink. An absent symlink means
the hook has not run. The fix is to restart Claude Code.
```

### You generate the index

After writing any ADR, rewrite `docs/adr/index.md` in full, with one line
per ADR. Sort the lines by number, ascending. Each line takes its number
and slug from the filename, and its title from the file's first heading:

```markdown
- [0001](0001-one-node-type.md) – One node type for questions and work
```

Generated, never hand-edited – a derived view cannot drift from its source.
If you find hand edits in it, regenerate; the files are the truth.

## Glossary – when a term got settled

If the decision fixed what a word means – picked between competing names,
sharpened a fuzzy term, coined one – record it:

- **Cross-domain terms** go in `CONTEXT.md` at the repo root.
- **Domain terms** go in `spechub/specs/<domain>/CONTEXT.md`, beside that
  domain's `spec.md`. Find the domain in `spechub/domain-map.yaml`.

- Create both files lazily; there is no index file –
  `domain-map.yaml` already lists every domain.

Format: a `# Glossary` heading, then one `**term** – definition` line per
term, alphabetical, one or two sentences each. Each definition follows the
`writing` skill.

Glossary and nothing else – no implementation notes, no specs, no scratch
content. The moment it accepts anything else it becomes another document
competing with the living specs.

**The human wins.** A glossary records the vocabulary humans agreed on.
Nobody rewrites it to match code. If code and glossary disagree, surface the
disagreement to the user; only a human decision changes the entry.

## Neither

If the decision fails the ADR bar and settled no term, write nothing and
say nothing. The durable trail for ordinary decisions is the resolved node
and the living specs.
