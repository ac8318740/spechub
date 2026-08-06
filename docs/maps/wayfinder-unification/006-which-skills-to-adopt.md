---
status: resolved
mode: hitl
kind: grilling
answers: 001
blocked-by: []
---

# Which surrounding skills does SpecHub adopt?

## Question

Wayfinder's node kinds delegate to other skills. Which of Matt Pocock's set does
SpecHub need, which does it already have under another name, and which would it
be importing for no reason?

## Adopt

**A grilling primitive.** `/spechub:clarify` already contains the technique: a
sequential loop, exactly one question at a time, a recommended answer with each,
and a stop condition. It is welded to reducing ambiguity in `proposal.md`.
Extract it as a model-invocable primitive any node can reach, then make the
callers thin. Removes duplicated interview prose from four skills.

**An ADR skill.** One to three sentences in `docs/adr/NNNN-slug.md`, created
lazily, offered only when the decision is hard to reverse **and** surprising
without context **and** the result of a real trade-off. This is what durably
holds the why that `design.md` was failing to hold.

**A one-session grilling front door.** The missing tier: too foggy for plan mode,
not foggy enough for three documents. One interview, one session, output is ADRs
and a glossary, no documents at all. Nearly free once the primitive and the ADR
skill exist.

**A mechanical collapse.** See below – adopt the role, not the implementation.

## Do not adopt

**Triage.** Solves an inbound problem: classifying reports other people filed,
chasing missing information from a reporter. Its whole vocabulary presumes a
reporter and a maintainer as different people. Inert on solo projects. Revisit
if others start filing issues.

**A separate to-tickets skill.** It overlaps almost entirely with
`/spechub:tasks`. Its one distinct capability is writing to a tracker rather
than to a file, and once the four tracker operations exist that is a backend for
`/spechub:tasks`, not a new skill. Its own tracker handling also hard-codes two
cases inline, so it is the less extensible of the two patterns on offer.

## Adopt the role of to-spec, not its implementation

`to-spec` collapses a cleared map into something buildable. SpecHub needs that
role. It does not need the skill as written, because the skill does not collapse
anything: it synthesises fresh prose from whatever is already in the context
window, and it never reads a map at all.

That leaves a contradiction. A map exists *because* the effort does not fit one
context window. Its author's routing advice is to keep the whole thing in one
unbroken context window until after ticket breakdown, which cannot hold for a
map by construction. The handoff is left to whatever the human pastes in.

A mechanical walk of the provenance tree fixes exactly this. The tree already
holds every decision in reading order, so packaging is traversal rather than
recall. This is the strongest reason the provenance field earns its place: not
the tidy hierarchy, but that it makes the handoff possible without holding the
whole effort in context.

## Borrowed separately

Matt Pocock's invocation rule, which is more consistent than SpecHub's:
**stage-advancing skills are user-invoked; technique skills are model-invoked.**
The human decides when the work changes phase; the model decides which technique
applies within a phase. SpecHub has eleven of nineteen skills carrying
`disable-model-invocation` with no stated principle. This sorts them.
