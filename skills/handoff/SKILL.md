---
name: handoff
description: Checkpoint a long session before compaction. Writes a structured handoff anchor (task ledger, next action, agent-team plan, blockers) and hands you a tailored /compact instruction, so work continues cleanly across the compaction boundary. Use before /compact on a long-running orchestration, when the context window is filling during multi-task or agent-team work, or whenever you want a clean resume point.
argument-hint: "[focus note – what the next session must not lose]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). Treat it as extra emphasis for what the post-compaction session must preserve.

## Purpose

Make a long session survive compaction without losing the thread.

Compaction is good – Anthropic's summarizer distills the whole conversation better than any template. But it is lossy, and a few things are too load-bearing to risk: the exact next action, the task ledger, who owns which files in a parallel run, and open blockers. This skill writes those to a durable anchor file, then hands you a `/compact` instruction steered at the current work. The two work together – the summary carries the narrative, the anchor carries the state.

On the next session start after compaction, a SessionStart hook re-injects the anchor automatically – you never re-paste it. Interactive Claude Code hands control back to you after any compaction (manual or automatic), so type `continue` to resume. The resumed session picks up from the anchor's Next action and asks before guessing on anything the summary left unclear.

**You do not search the codebase for this.** Build the handoff from what is already in context plus SpecHub's own state (`spechub status`, the active change, the task list, `git status`). If you find yourself about to grep source, stop – the conversation already holds what you need.

## Step 1: Gather state

Collect, in order of importance:

1. **SpecHub change state** – run `~/.claude/spechub/bin/spechub status`. Note the active change id, workflow phase, and task list. If no change is active, say so.
2. **The single next action** – the one concrete thing the resumed session should do first.
3. **Task ledger** – done / in-progress / pending, in dependency order. Pull from the change's task list if one exists; otherwise reconstruct from the conversation.
4. **Agent-team plan** (only if parallel work is underway or planned) – each scope, its owning teammate, and its non-overlapping file set. Note any shared/sequential files to touch only after the team finishes.
5. **Files in flight** – `git status --short`, plus a one-line note per file on what is incomplete.
6. **Test and build state** – the baseline count (`.test-baseline` if present), last run result, anything outstanding.
7. **Decisions and blockers** – decisions already made (so they are not relitigated) and open questions or blockers.

## Step 2: Write the anchor

Write `spechub/HANDOFF.md` using this schema. Keep it tight – this is an anchor, not a transcript. Omit sections that do not apply rather than padding them.

The frontmatter is **mandatory and machine-read** by the reload hook:

- `spechub_handoff: 1` – the marker. Without it the hook ignores the file, so never omit it.
- `change` – the active change id from `spechub status`, or `ad-hoc` when no change is active. This routes where the consumed handoff is archived.
- `created` – an ISO 8601 UTC timestamp. Becomes the archived filename.

```markdown
---
spechub_handoff: 1
change: <change-id or "ad-hoc">
created: <ISO 8601 UTC, e.g. 2026-05-25T14:30:00Z>
---
# SpecHub Handoff — <change-id or "ad-hoc"> — <created>

## Objective
<one paragraph: what we are accomplishing overall>

## Workflow position
- Path: <quick | full pipeline>
- Phase: <propose | clarify | design | tasks | implement | archive>
- Active change: <id from `spechub status`, or "none">

## Next action (do this first on resume)
<the single concrete next step>

## Task ledger
- [x] <done>
- [~] <in progress>
- [ ] <pending, dependency-ordered>

## Agent-team plan
- Scope A — <teammate> — files: <non-overlapping set>
- Scope B — <teammate> — files: <non-overlapping set>
- After team (sequential, shared files): <list>

## Files in flight
- <path> — <what changed / what is incomplete>

## Test + build state
- Baseline: <N>
- Last run: <pass/fail + which suite>
- Outstanding: <...>

## Decisions made
- <decision — so it is not reopened>

## Open questions / blockers
- <...>

## Spec sync
- Domains touched: <...>
- Pending spec updates: <...>
```

`spechub/HANDOFF.md` is the active, pending handoff – transient working state. If the project's `.gitignore` does not already cover it, mention that the user may want to add it. Do not commit it as part of feature work. Consumed handoffs are a different thing (see Notes) – they are a per-change history and may be worth keeping.

## Step 3: Hand the user a tailored /compact line

A skill cannot run `/compact` itself. Compose a focus instruction steered at this session's work and print it for the user to run verbatim. Fold in the user's `$ARGUMENTS` focus note if given. For example:

```
/compact Preserve the auth-refactor plan and the agent-team file ownership. We are mid-implement on change AUTH-12, executor finished scope A, scope B pending. Keep the test-baseline number and the open RLS decision.
```

Keep it specific to the actual work – name the change, the phase, the in-progress scope, and anything the user flagged.

## Step 4: Tell the user what happens next

Report concisely:

```
Handoff written: spechub/HANDOFF.md

Next:
  1. Run the /compact line above.
  2. When compaction finishes, type: continue
  3. The handoff re-injects itself (SessionStart, compact). I resume from its
     Next action, and I ask before guessing on anything left unclear.
```

Do not run anything else. The user runs `/compact`, then types `continue`; the hook handles reload.

## Notes

- The auto-reload fires only when the start source is `compact` – the same session continuing after compaction. It does not fire on a fresh start, `--resume`, or `/clear`, so a stale handoff never leaks into an unrelated session.
- **Why you type `continue`.** Interactive Claude Code always returns control to the user after compaction – no hook can force the assistant to take a turn. The anchor is already in context by then, so any short nudge (`continue`) resumes the work; you never re-explain it. The reload preamble tells the resumed session to start from the Next action and to use AskUserQuestion liberally whenever the handoff or summary is ambiguous. Fully automatic resume (no nudge) exists only in headless mode (`claude -p`), which the autonomous path uses.
- **Consume-once.** When the hook injects a handoff it immediately retires it, so it can never be injected twice. A later, unrelated `/compact` in the same project will not resurface an old note.
- **Per-change history.** The retired handoff is moved into the change it belongs to: `spechub/changes/<change>/handoffs/<created>.md` when that change dir exists (so it travels with the change on `/spechub:archive`), or `spechub/handoffs/<change>/<created>.md` for ad-hoc work. Filenames carry a `-2`, `-3` suffix on collision, so a single change accumulates many handoffs over its life. Writing a fresh `spechub/HANDOFF.md` before the previous one is consumed simply supersedes it.
- Subagents and teammates have isolated context and do not share the orchestrator's window. This handoff protects the **orchestrator's** coordination state – the long-lived part. Ephemeral per-scope work does not need it.
- The strongest defense against hitting the compaction wall is delegating aggressively, so the orchestrator's window stays lean. This skill is the backstop for when coordination state grows long anyway.
