---
name: compact-and-continue
description: Anchor the session's load-bearing state so it survives an imminent context compaction, then hand the user a /compact line steered at the work. Writes only what nothing on disk holds – the next action, decisions already made, blockers, file ownership – and references everything else. Invoke before compacting a long session, when the context window is filling and the work must stay in THIS session rather than move to another agent. Model-invocable, because the agent is the only party that can see its own context filling.
argument-hint: "[focus note – what must not be lost]"
---

## User Input

```text
$ARGUMENTS
```

Treat the argument as the focus for the session after compaction – the thing
that must survive above all else.

# Compact and continue

Compaction replaces the conversation with a summary. The summary is better
than any template at carrying narrative, but it is lossy, and a handful of
items are too load-bearing to risk losing. This skill writes those items to an
anchor file that a SessionStart hook re-injects the moment the session resumes,
so the work continues here rather than moving to a fresh agent.

## Only the lead session runs this

Run `[ -n "${CLAUDE_CODE_CHILD_SESSION:-}" ]` before anything else. If it is
set, you are a subagent or a teammate: stop, and tell whoever launched you that
this skill runs only in the lead session, and that a subagent or teammate should
report its state to the lead instead – in its final message, or by
`SendMessage` – and let the lead hand off or compact. The reason: a child
session would write the lead's quiet marker and the shared `spechub/HANDOFF.md`
anchor, both of which belong to the lead alone.

## The rule that governs the anchor

*Reference state. Never copy it.*

An anchor that restates the repository is a second copy of the repository,
correct only at the instant it was written. Anything the resumed session can
run a command to learn, it should run the command.

| Do not write it down        | The resumed session gets it from                                                 |
| --------------------------- | -------------------------------------------------------------------------------- |
| Map state and reading order | `~/.claude/spechub/bin/spechub node walk --map <name>` (reading order of the map) |
| What can be worked next     | `~/.claude/spechub/bin/spechub node frontier --map <name>` (what is workable now) |
| Files in flight             | `git status --short` and `git diff`                                               |
| Test baseline, last result  | `.test-baseline`, then run the suite                                              |
| What the code does          | the living specs in `spechub/specs/`                                              |

The same applies to specs, architecture decision records, issues and commits.
Reference them by path or URL.

**You do not search the codebase for this.** Build the anchor from what is
already in context. If you are about to search source files, stop – the
conversation holds it.

## What only an anchor can carry

*Five things. Nothing on disk records them, so if they are not written they are
lost.*

1. **Next action** – the single concrete thing to do first
2. **Decisions made** – so they are not reopened and re-argued
3. **Open questions and blockers** – including anything waiting on the user
4. **Agent-team file ownership** – each scope, its agent, its non-overlapping
   file set, and any shared file to touch only after the team finishes. Not
   derivable from anything
5. **Suggested skills** – which skills the resumed session should invoke, by name

Omit any that do not apply. Do not pad.

The anchor is read by a session that no longer has this conversation – plain
language, no unexplained shorthand.

## Redaction

*The anchor lands in the working tree.*

Strip credentials, tokens, API keys, connection strings and personal data
before writing. Reference where a secret lives rather than its value. This is
not optional.

## Write the anchor

Write `spechub/HANDOFF.md`. The frontmatter is **mandatory and machine-read** –
the hook ignores any file without the marker, so a user's own unrelated
`HANDOFF.md` is never touched:

```markdown
---
spechub_handoff: 1
map: <map name, or "ad-hoc" when none is active>
created: <ISO 8601 UTC>
---
# SpecHub handoff – <map name or "ad-hoc">

## Next action
<the single concrete next step>

## Decisions made
- <decision, so it is not reopened>

## Open questions / blockers
- <...>

## Agent-team plan
- Scope A – <agent> – files: <non-overlapping set>
- After team (shared files, sequential): <list>

## Suggested skills
- <skill name> – <why>

## References
- Map state: `~/.claude/spechub/bin/spechub node walk` and `~/.claude/spechub/bin/spechub node frontier`
- Files in flight: `git status --short`
```

## Silence the context-pressure nudge

With the anchor written, write the quiet marker. The context-pressure Stop hook
reads it and stays silent for the rest of this session – the compaction is
already arranged, so there is nothing left to nudge about:

```bash
d="${SPECHUB_CONTEXT_PRESSURE_DIR:-${TMPDIR:-/tmp}/spechub-context-pressure}"
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && mkdir -p "$d" && : > "$d/${CLAUDE_CODE_SESSION_ID}.quiet" || true
```

`CLAUDE_CODE_SESSION_ID` is this session's own id – the gate at the top ruled
out the child sessions where it would name the parent instead – so the marker
lands exactly where the hook looks for it. If the variable is unset, skip this
step and tell the user: the hook will keep nudging, which is noisy but harmless.
The marker is cleared automatically when the session compacts, because the hook
resets its state on `SessionStart` with `source: compact`, so the nudge can
return once the context grows again.

## Hand over the compact line

A skill cannot run `/compact` itself, so write the user a `/compact` line
steered at this work – naming the next action and anything they flagged in the
focus note.

Tell them: run that `/compact` line, then type `continue`. The hook re-injects
the anchor and retires it, so it can never load twice.

`spechub/HANDOFF.md` is transient working state. If `.gitignore` does not cover
it, say so – it holds conversation content and should not be committed.

## Notes

- **The reload fires only when the session start source is `compact`.** Not on
  a fresh start, on resuming an earlier session, or after clearing the context,
  so a stale anchor never leaks into unrelated work. Moving the work to a
  genuinely new session is the `handoff` skill's job
- **Consume-once.** The hook retires the anchor as it injects it, moving it to
  `spechub/handoffs/<map>/<created>.md` (legacy
  `spechub/changes/<name>/handoffs/` when that directory still exists).
  Collisions get a `-2` suffix
- **Subagents and teammates have isolated context.** This protects the
  orchestrator's coordination state, which is the long-lived part. Per-scope
  work does not need it
- The best defence against the compaction wall is delegating aggressively so
  the orchestrator's context window stays lean. This is the backstop
