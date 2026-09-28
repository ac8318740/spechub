---
name: handoff
description: Hand the current work to a visible agent – a new one running in its own pane, or one already running. Writes only what nothing on disk holds – the next action, decisions already made, blockers, file ownership – and references everything else. Invoke when the user asks to hand work over or to spin the work out to another agent, or when context pressure makes continuing in this session unwise. Keeping the work in this session across a context compaction is the compact-and-continue skill's job.
argument-hint: "[focus note – what the receiving agent must not lose]"
---

## User input

```text
$ARGUMENTS
```

Treat the argument as the focus for the receiving agent.

# Hand the work over

A handoff moves the current work to an agent a human can see – a named session
in a visible pane, or a session already running. To keep the work in THIS
session across a context compaction instead, use `compact-and-continue`.

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

Read [`lead-check.md`](lead-check.md) before you change that command, or when
its answer looks wrong. It says why a child must stop, and what it checks.

## First: is this yours to invoke?

If the user asked for a handoff, proceed. If you are invoking it on your own
initiative, read `workflow.handoff.self_invoke` from `spechub/project.yaml`
first.

If it is `false`, stop. Tell the user a handoff looks warranted and why. Ask
permission.

Unset means `true`.

## Where the work goes

herdr is the terminal workspace manager some sessions run inside. Four terms
carry its vocabulary, defined once here.

A **herdr workspace** is a git worktree. A **herdr tab** is a session working
inside one.

A **pane** is the terminal rectangle a session occupies. An **agent** is a named
session herdr supervises.

One rule decides the destination:

| The work is                                  | Goes to                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| a continuation of what this session is doing | a new **tab** in this workspace – same worktree, same files       |
| genuinely separate, or runs in parallel      | a new **worktree**, so a new **workspace**, with its own checkout |
| better suited to an agent already running    | that agent, by message – no new pane at all                      |

Ambiguous cases go to the user. Do not guess. Without herdr there are no tabs
and no workspaces, so this table collapses to two cases – *Without herdr*, in
[`launch-without-herdr.md`](launch-without-herdr.md), gives that variant.

**Consider the agents already running before launching anything.** List live
sessions with `claude agents --json`, which works with no terminal attached.

Read [`running-agent.md`](running-agent.md) when the listing shows a live session.

## The rule that governs the handoff

*Reference state. Never copy it.*

A handoff that restates the repo is a second copy of the repo, correct only at
the moment you write it. Anything the receiving agent can run a command to learn,
it should run the command.

| Do not write it down        | The receiving agent gets it from                                                  |
| --------------------------- | --------------------------------------------------------------------------------- |
| Map state and reading order | `~/.claude/spechub/bin/spechub node walk --map <name>` (reading order of the map)  |
| What can be worked next     | `~/.claude/spechub/bin/spechub node frontier --map <name>` (what is workable now)  |
| Files in flight             | `git status --short` and `git diff`                                                |
| Test baseline, last result  | `.test-baseline`, then run the suite                                               |
| What the code does          | the living specs in `spechub/specs/`                                               |

On GitHub, `--map` refuses – pipe `gh issue list` into `--stdin` per the
map skill's `trackers/github.md`.

The same applies to specs, architecture decision records, issues and commits.
Reference them by path or URL.

**You do not search the codebase for this.** Build the handoff from what is already
in context. If you are about to search source files, stop – the conversation holds it.

## What only a handoff can carry

*Five things. Nothing on disk records them, so what you leave out disappears.*

1. **Next action** – the single concrete thing to do first
2. **Decisions made** – so nobody reopens and re-argues them
3. **Open questions and blockers** – including anything waiting on the user
4. **Agent-team file ownership** – each scope, its teammate, its non-overlapping
   file set. Also name any shared file to touch only after the team finishes.
   Nothing else records this

5. **Suggested skills** – which skills the receiving agent should invoke, by name

Omit any that do not apply. Do not pad.

Prose follows the `writing` skill.

## Redaction

*The handoff leaves the conversation and becomes another agent's prompt.*

Strip credentials, tokens, API keys, connection strings and personal data before
writing. Reference where a secret lives rather than its value. This is not
optional.

## Write the handoff file

Write the handoff to the OS temporary directory, never the workspace – it is
conversation content, not project state, and must not be committable. Name it
`$TMPDIR/spechub-handoff-<slug>-<timestamp>.md` (`/tmp` when `$TMPDIR` holds
nothing), where `<slug>` names the work and `<timestamp>` stops two handoffs
colliding.

Its first line, above every heading, repeats the acknowledgement requirement
verbatim, with `<this-file>` replaced by the file's own path:

```text
Acknowledge before any other tool call. Run ~/.claude/spechub/bin/spechub handoff ack accept --file <this-file> "<one-line reason>", or ack decline --file <this-file> "<one-line reason>". The command writes <this-file>.ack, which the sender watches.
```

This temp file is not `spechub/HANDOFF.md`, the `compact-and-continue` anchor.
Never put this line into that anchor, which has to start with `---` frontmatter.

Head the rest with the same skeleton the `compact-and-continue` anchor uses. The
headings are Next action, Decisions made, Open questions and blockers,
Agent-team plan, Suggested skills, References. That skeleton is the five carried
items above, plus the commands from the reference table instead of copied state.

Drop any heading with nothing under it.

The launch prompt is a **single-line pointer at that file**, never the handoff
text itself. `herdr agent start` rejects newlines and tabs in its arguments.

## Every prompt opens with an acknowledgement

Every handoff prompt asks for the command.

There are two prompts, because the two destinations differ in what else they
must say. Use the matching one verbatim, and substitute only the handoff file
path.

Each one is a single line. `herdr agent start` rejects newlines and tabs in its
arguments. So the instruction and the pointer at the handoff file share that one
line.

**Fresh agent** – one launched for this handoff, into a new pane, worktree or
tab, or as a `--bg` session. Reading the handoff file is the one tool call
allowed before the ack command. Every other tool call – a command, an edit, a
subagent – leaves the acknowledgement still owed.

> Before any other tool call, acknowledge this handoff by running ~/.claude/spechub/bin/spechub handoff ack accept --file <handoff-file> "<one-line reason>", or ack decline --file <handoff-file> "<one-line reason>". You may read <handoff-file> first to judge whether the work suits you, and nothing else until the command has run – the sender watches for the file it writes and cannot report this work as yours until it exists. Then continue that work.

**Agent already running** – one reached by cross-session message. Its variant
of the opener is in [`running-agent.md`](running-agent.md).

The agent may investigate before it decides. Acknowledgement comes first, work
second. Never start the work and acknowledge later – by then the sender has
already had to guess.

## Launch

Read [`watch.md`](watch.md) first, for the pre-launch snapshot, then one of:

- [`launch-herdr.md`](launch-herdr.md) – `HERDR_ENV` is `1`, a new worktree or tab
- [`launch-without-herdr.md`](launch-without-herdr.md) – `HERDR_ENV` is not `1`
- [`running-agent.md`](running-agent.md) – an agent already running

## Watch for the acknowledgement

Do not eyeball transcripts. The CLI watches for you:

```bash
~/.claude/spechub/bin/spechub handoff watch --file <handoff-file> \
  --session-id <id> --cwd <dir> --token <token> --turns <n>
```

**Run the watcher in the background.** This session has stopped working on the
task, but it must not lock up. The user can keep talking to it while the handoff
lands, and the harness surfaces the watcher's exit on its own. Never sit in a
foreground wait.

[`watch.md`](watch.md) gives every flag, `--fresh` among them. When the watcher
exits, read [`outcomes.md`](outcomes.md) for what its result means.

## Silence the context-pressure nudge

Once you finish the handoff, write the quiet marker. The context-pressure Stop
hook reads it and stays silent for the rest of this session. The work has
already moved on, so there is nothing left to nudge about:

```bash
d="${SPECHUB_CONTEXT_PRESSURE_DIR:-${TMPDIR:-/tmp}/spechub-context-pressure}"
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && mkdir -p "$d" && : > "$d/${CLAUDE_CODE_SESSION_ID}.quiet" || true
```

`CLAUDE_CODE_SESSION_ID` is this session's own id. The lead check at the top
ruled out the child sessions, where it names the lead instead. So the marker lands
exactly where the hook looks for it.

If the variable holds nothing, skip this step and say so in the report. The hook
then keeps nudging, which is noisy but harmless.

## Report

Always name the target, the handoff file path, and the next action the receiving
agent would take. The target is an agent name with its pane or workspace, or the
existing session.

Then say where the handoff stands, in the terms of [`outcomes.md`](outcomes.md).

- accepted
- declined on fit, and relaunched elsewhere
- declined on the merits, with the objection in enough of its own words to act on
- proceeding, unacknowledged – the target engaged, and you spent the nudge
- unacknowledged – read `outcomes.md` for `staleAck` before you report this

Never describe the work as owned by the target until the target has accepted it.
