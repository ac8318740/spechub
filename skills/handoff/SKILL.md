---
name: handoff
description: Hand the current work to a fresh agent session, or anchor it so this session survives compaction. Writes only what cannot be derived from the repo – the next action, decisions already made, blockers, file ownership – and references everything else. Use when you want another session to pick up the work, before /compact on a long orchestration, or when the context window is filling.
argument-hint: "[compact] [focus note – what the next session must not lose]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

Treat the argument as the focus for the next session. If it begins with `compact`,
use destination B below; otherwise use destination A. Everything after that word is
the focus note.

## The rule that governs both destinations

*Reference state. Never copy it.*

A handoff that restates the repo is a second copy of the repo, correct only at the
instant it was written. Anything the next session can run a command to learn, it
should run the command.

| Do not write it down       | The next session gets it from            |
| -------------------------- | ---------------------------------------- |
| Map state and reading order | `~/.claude/spechub/bin/spechub node walk --map <name>` (reading order of the map) |
| What can be worked next    | `~/.claude/spechub/bin/spechub node frontier --map <name>` (what is workable now) |
| Files in flight            | `git status --short` and `git diff`       |
| Test baseline, last result | `.test-baseline`, then run the suite      |
| What the code does         | the living specs in `spechub/specs/`      |

The same applies to specs, ADRs, issues and commits. Reference them by path or URL.

**You do not search the codebase for this.** Build the handoff from what is already
in context. If you are about to grep source, stop – the conversation holds it.

## What only a handoff can carry

*Five things. Nothing on disk records them, so if they are not written they are lost.*

1. **Next action** – the single concrete thing to do first
2. **Decisions made** – so they are not reopened and re-argued
3. **Open questions and blockers** – including anything waiting on the user
4. **Agent-team file ownership** – each scope, its teammate, its non-overlapping file
   set, and any shared file to touch only after the team finishes. Not derivable from
   anything
5. **Suggested skills** – which skills the next session should invoke, by name

Omit any that do not apply. Do not pad.

The handoff is read by a session with none of this conversation – plain language,
no unexplained shorthand.

## Redaction

*The handoff leaves the conversation and may become another agent's prompt.*

Strip credentials, tokens, API keys, connection strings and personal data before
writing. Reference where a secret lives rather than its value. This is not optional
in either destination – in A the text becomes a prompt, and in B the file lands in
the working tree.

## Destination A: a fresh session

*Default. Writes outside the repository, then starts the session for you.*

1. Write the handoff to the OS temporary directory, never the workspace. It is not
   project state and must not be committable
2. Launch a background agent seeded with it:

```bash
claude --bg --name "<short descriptive name>" "$(cat <path-to-handoff>)"
```

Always pass a name – it appears in the job list, session picker and terminal title.
The agent starts in the current working directory and returns immediately. The user
manages it with `claude agents`.

Report the agent name, the handoff path, and the next action.

## Destination B: this session, across compaction

*For surviving `/compact` rather than moving to a new session.*

Compaction summarises better than any template, but it is lossy, and the five items
above are too load-bearing to risk. This destination writes them to an anchor the
SessionStart hook re-injects automatically.

Write `spechub/HANDOFF.md`. The frontmatter is **mandatory and machine-read** – the
hook ignores any file without the marker, so a user's own `HANDOFF.md` is never
touched:

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
- Scope A – <teammate> – files: <non-overlapping set>
- After team (shared files, sequential): <list>

## Suggested skills
- <skill name> – <why>

## References
- Map state: `spechub node walk` and `spechub node frontier`
- Files in flight: `git status --short`
```

Then hand the user a `/compact` line steered at this work, naming the next action
and anything they flagged. A skill cannot run `/compact` itself.

Tell them: run the `/compact` line, then type `continue`. The hook re-injects the
anchor and retires it, so it can never load twice.

`spechub/HANDOFF.md` is transient working state. If `.gitignore` does not cover it,
say so – it holds conversation content and should not be committed.

## Notes

- **Destination B's reload fires only when the start source is `compact`.** Not on a
  fresh start, `--resume` or `/clear`, so a stale anchor never leaks into unrelated
  work. Handing off to a genuinely new session is destination A's job
- **Consume-once.** The hook retires the anchor as it injects it, moving it to
  `spechub/handoffs/<map>/<created>.md` (legacy `spechub/changes/<name>/handoffs/`
  when that directory still exists). Collisions get a `-2` suffix
- **Subagents and teammates have isolated context.** This protects the
  orchestrator's coordination state, which is the long-lived part. Per-scope work
  does not need it
- The best defence against the compaction wall is delegating aggressively so the
  orchestrator's window stays lean. This is the backstop
