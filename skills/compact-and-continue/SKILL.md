---
name: compact-and-continue
description: Anchor the session's load-bearing state so it survives an imminent context compaction, then hand the user a /compact line steered at the work. Writes only what nothing on disk holds – the next action, decisions already made, blockers, file ownership – and references everything else. Invoke before compacting a long session, when the context window is filling and the work must stay in THIS session rather than move to another agent. Model-invocable, because the agent is the only party that can see its own context filling.
argument-hint: "[focus note – what must not be lost]"
---

## User input

```text
$ARGUMENTS
```

Treat the argument as the focus for the session after compaction – the thing
that must survive above all else.

# Compact and continue

Compaction replaces the conversation with a summary. The summary carries the
narrative better than any template, but it is lossy.

A handful of items are too load-bearing to risk losing. This skill writes
those items to an anchor file. A SessionStart hook re-injects the file the
moment the session resumes, so the work continues here rather than moving to
a fresh agent.

## Only the lead session runs this

An agent that another agent launched stops here. One Bash call tells you
whether you are one. Replace `<nonce>` with eight random hex characters, picked
fresh, and never with a value already used in this session:

<!-- lead-check: tests/test-skill-gates.sh extracts and runs the block below -->

```bash
n=spechub-whoami-<nonce>
s="${CLAUDE_CODE_SESSION_ID:-none}"
p="$HOME/.claude/projects"
for _ in $(seq 1 20); do
  m=$(grep -lF "$n" "$p"/*/"$s"/subagents/agent-*.jsonl 2>/dev/null </dev/null | head -1)
  [ -n "$m" ] && { echo "child: $m"; exit 0; }
  grep -qF "$n" "$p"/*/"$s".jsonl 2>/dev/null </dev/null && { echo "lead"; exit 0; }
  sleep 0.5
done
echo "lead"
```

`lead` means carry on. `child: <path>` means stop, and tell whoever launched
you that this skill runs only in the lead session. Report your state upward
instead – in your final message, or by `SendMessage`. The lead then hands off
or compacts.

A child session would write the lead's quiet marker and the shared
`spechub/HANDOFF.md` anchor. Both belong to the lead alone.

Five facts sit behind that command, measured on Claude Code 2.1.241. Each one
names a way the command has already been got wrong:

- **No environment variable answers this.** `CLAUDE_CODE_CHILD_SESSION` holds
  `1` in every Bash subprocess, lead or child. It marks "spawned by Claude
  Code", nothing more. An in-process child session shares the lead's
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and `CLAUDE_CODE_ENTRYPOINT`.

- **The command hunts for its own record, so it waits.** The host writes that
  record while the command runs, roughly four seconds in. One grep with no loop
  runs too early, finds nothing and answers `lead` for everyone. Never flatten
  the loop.

- **The nonce must be yours alone.** Reuse one, or take one from a prompt, and
  another agent's transcript answers for you. The angle brackets make an
  unsubstituted copy a bash syntax error. That beats a silent match on whatever
  agent read this file before you, so never soften `<nonce>` to a bare word.

- **`<session>.jsonl` can only ever say `lead`.** Your own mark lands there
  whether you are the lead or not. So the loop reads the agent transcripts
  first, and treats that file as an early exit rather than evidence of a child.

- **No evidence means lead.** The old gate read a variable that is always set.
  It answered `child` in every session, and neither skill could run (#146).

    Ten seconds with no matching transcript answers `lead` instead. A teammate
    running as its own top-level session lands here, and rightly: it owns its
    own marker.

## The rule that governs the anchor

*Reference state. Never copy it.*

An anchor that restates the repository is a second copy of the repository,
correct only at the instant you wrote it. If the resumed session can learn
something by running a command, it should run the command.

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

*Five things. Nothing on disk records them, so the resumed session loses
anything you leave out.*

1. **Next action** – the single concrete thing to do first
2. **Decisions made** – so the resumed session does not reopen and re-argue them
3. **Open questions and blockers** – including anything waiting on the user
4. **Agent-team file ownership** – each scope, its agent, and its
   non-overlapping files. Name any shared file to touch only after the team
   finishes. Nothing derives it

5. **Suggested skills** – which skills the resumed session should invoke, by name

Omit any that do not apply. Do not pad.

A session that no longer has this conversation reads the anchor. Prose follows
the `writing` skill.

## Redaction

*The anchor lands in the working tree.*

Strip credentials, tokens, API keys, connection strings and personal data
before writing. Reference where a secret lives rather than its value. This is
not optional.

## Write the anchor

Write `spechub/HANDOFF.md`. The frontmatter is **mandatory and machine-read**.
The hook ignores any file without the marker, so it never touches a user's own
unrelated `HANDOFF.md`.

Set `map` to the name of the active map, or to `ad-hoc` when none is active.
Set `created` to the current time, in ISO 8601 UTC. The title repeats the
`map` value.

**Example** – the anchor for a session working the `tracker-backend` map:

```markdown
---
spechub_handoff: 1
map: tracker-backend
created: 2026-08-22T14:05:00Z
---
# SpecHub handoff – tracker-backend

## Next action
Fix the two `node frontier` cases in `cli/src/lib/frontier.test.ts` that fail
on a map with no resolved nodes.

## Decisions made
- The files backend ships first. It needs no network, so a fresh clone works
  offline.
- One node type covers both questions and work. Node 14 holds the reasoning.

## Open questions / blockers
- Node 21 waits on the user. Does a resolved node keep its `blocked-by` links?

## Agent-team plan
- Scope A – cli-nodes-opus – files: `cli/src/lib/frontier.ts`, `cli/src/lib/frontier.test.ts`
- Scope B – hooks-sonnet – files: `hooks/session-start-handoff.sh`
- After team (shared files, sequential): `cli/src/index.ts`, `README.md`

## Suggested skills
- implement – the frontier holds three work nodes an agent can settle alone
- record-context – node 14 settled a term the glossary does not hold yet

## References
- Map state: `~/.claude/spechub/bin/spechub node walk` and `~/.claude/spechub/bin/spechub node frontier`
- Files in flight: `git status --short`
```

## Silence the context-pressure nudge

With the anchor written, write the quiet marker. The context-pressure Stop hook
reads the marker and stays silent for the rest of this session. You have
already arranged the compaction, so the hook has nothing left to nudge about:

```bash
d="${SPECHUB_CONTEXT_PRESSURE_DIR:-${TMPDIR:-/tmp}/spechub-context-pressure}"
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && mkdir -p "$d" && : > "$d/${CLAUDE_CODE_SESSION_ID}.quiet" || true
```

`CLAUDE_CODE_SESSION_ID` is this session's own id, so the marker lands exactly
where the hook looks for it. The lead check at the top ruled out the child
sessions, where the variable names the lead instead.

If the variable is unset, skip this step. Tell the user that the hook keeps
nudging, which is noisy but harmless.

The hook clears the marker when the session compacts. It resets its state on
`SessionStart` with `source: compact`, so the nudge returns once the context grows
again.

## Hand over the compact line

A skill cannot run `/compact` itself. Write the user a `/compact` line steered
at this work. Name the next action, and anything they flagged in the focus
note.

Tell them to run that `/compact` line, then to type `continue`. The hook
re-injects the anchor and retires it, so the anchor never loads twice.

`spechub/HANDOFF.md` is transient working state. If `.gitignore` does not cover
it, say so. The file holds conversation content, so nobody should commit it.

## Notes

- **The reload fires only when the session start source is `compact`**. It
  does not fire on a fresh start, on resuming an earlier session, or after
  clearing the context.

    A stale anchor therefore never leaks into unrelated work. The `handoff`
    skill moves the work to a genuinely new session

- **Consume-once.** The hook retires the anchor as it injects it, moving it to
  `spechub/handoffs/<map>/<created>.md` (legacy
  `spechub/changes/<name>/handoffs/` when that directory still exists).
  Collisions get a `-2` suffix

- **Subagents and teammates have isolated context.** This protects the
  orchestrator's coordination state, which is the long-lived part. Per-scope
  work does not need it

- The best defence against the compaction wall is delegating aggressively so
  the orchestrator's context window stays lean. This is the backstop
