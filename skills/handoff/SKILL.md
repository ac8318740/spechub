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

Run `[ -n "${CLAUDE_CODE_CHILD_SESSION:-}" ]` before anything else. If the
variable holds a value, you are a subagent or a teammate. Stop, and tell whoever
launched you that this skill runs only in the lead session. A subagent or a
teammate reports its state to the lead instead – in its final message, or by
`SendMessage`. The lead then hands off or compacts.

The reason is the quiet marker. This skill's last step writes that marker, which
silences the lead's context-pressure nudge. In a child session
`CLAUDE_CODE_SESSION_ID` names the lead, so a child would write a marker that
only the lead may write.

## First: is this yours to invoke?

If the user asked for a handoff, proceed. If you are invoking it on your own
initiative, read `workflow.handoff.self_invoke` from `spechub/project.yaml`
first. If it is `false`, stop. Tell the user a handoff looks warranted and why.
Ask permission. Unset means `true`.

## Where the work goes

herdr is the terminal workspace manager some sessions run inside. Four terms
carry its vocabulary, defined once here. A **herdr workspace** is a git
worktree. A **herdr tab** is a session working inside one. A **pane** is the
terminal rectangle a session occupies. An **agent** is a named session herdr
supervises.

One rule decides the destination:

| The work is                                  | Goes to                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| a continuation of what this session is doing | a new **tab** in this workspace – same worktree, same files       |
| genuinely separate, or runs in parallel      | a new **worktree**, so a new **workspace**, with its own checkout |
| better suited to an agent already running    | that agent, by message – no new pane at all                      |

Ambiguous cases go to the user. Do not guess. Without herdr there are no tabs
and no workspaces, so this table collapses to two cases – *Without herdr*, below,
gives that variant.

**Consider the agents already running before launching anything.** List live
sessions with `claude agents --json`, which works with no terminal attached.
Listed is not the same as reachable. Each row carries a `state` field. You
cannot message a row that is not in a live or working state, even though the
listing shows it.

If a session is already working in this worktree or repository, weigh it and
propose it. Ask the user to confirm a target whose working directory sits
outside this repository, unless the user named that target. *Routing to an agent
already running*, below, gives the way to propose the work to such a session.

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
verbatim:

```text
Acknowledge first: ACCEPT or DECLINE, the way the message that brought you here told you to, before doing anything else.
```

It stays channel-neutral because both routes read the file, and the two routes
acknowledge differently. The receiving agent may read this file before it
decides, so the file is the second place the requirement lands. The launch
prompt is the first.

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

*A convention, not a protocol.*

Cross-session messaging has no accept-or-decline mechanism. A peer can read a
message and simply ignore it, and nobody tells the sender. Refusal is
ultimately a model-level choice, so the handshake has to live in the prompt text
itself.

So every handoff prompt opens with an acknowledgement instruction. There are
two of them, because the two destinations answer over different channels. Use
the matching one verbatim, and substitute only the handoff file path. Each is a
single line. `herdr agent start` rejects newlines and tabs in its arguments. So
the instruction and the pointer at the handoff file share that one line.

**Fresh agent** – one launched for this handoff, into a new pane, worktree or
tab, or as a `--bg` session. It has no handle to reply on, so its acknowledgement
is simply the first line of its first reply. A tool call is not a reply. Reading
the handoff file, running a command or spawning a subagent all leave the
acknowledgement still owed. The acknowledgement is the first *text* the agent
sends.

> The first line of your first reply must be the single word ACCEPT or DECLINE, followed by a one-line reason. Use plain text, with nothing at all before that word and no bold, heading, quote or code formatting. The sender matches that line literally, and cannot report this work as yours until it sees it. You may read <handoff-file> first to judge whether the work suits you, but reply before doing any other work. Then continue that work.

**Agent already running** – one reached by cross-session message. A reply typed
into its own conversation goes nowhere this session can see. So the
acknowledgement travels back over the same channel it arrived on:

> Before anything else, send an acknowledgement back to me with SendMessage, copying this message's from field as your to field. That message must begin with the single word ACCEPT or DECLINE, followed by a one-line reason. Use plain text, with nothing at all before that word and no bold, heading, quote or code formatting, because the sender matches it literally. This session never sees a reply you type only into your own conversation, and cannot report this work as yours until that message arrives. You may read <handoff-file> first to judge whether the work suits you, but send the acknowledgement before doing any other work. Then continue that work.

The agent may investigate before it decides. Acknowledgement comes first, work
second. Never start the work and acknowledge later – by then the sender has
already had to guess.

## Launch: a new worktree, for separate work

```bash
cd <main-repo-root> && git fetch origin --quiet && \
herdr worktree create --cwd "<main-repo-root>" --branch <branch> --base <base> \
  --label <slug> --no-focus
# read .result.root_pane.pane_id from the JSON – never hardcode
# .result.worktree.path confirms where the checkout landed, for the report at the end

# the quoted prompt is the FRESH AGENT opener defined above – use it verbatim
herdr agent start <handoff-name> --kind claude --pane <root_pane_id> \
  -- "The first line of your first reply must be the single word ACCEPT or DECLINE, followed by a one-line reason. Use plain text, with nothing at all before that word and no bold, heading, quote or code formatting. The sender matches that line literally, and cannot report this work as yours until it sees it. You may read <handoff-file> first to judge whether the work suits you, but reply before doing any other work. Then continue that work."
```

`<base>` is `origin/dev` when that ref exists, otherwise `origin/main` – the same
rule the `new-worktree` skill follows. Local `dev` is often behind. So the fetch
comes first, and the command cuts the branch from the remote ref.

Stop after `worktree create`. It already leaves a spare root shell pane in the
new workspace, and that is the pane the agent goes into. The `new-worktree`
skill's extra pane-move steps exist only because that skill wants the caller to
end up there. A handoff does not.

The agent name is the handle – `[a-z][a-z0-9_-]{0,31}`, unique among live agents.
Every `herdr agent` subcommand accepts it in place of a pane ID, and it survives
a pane move. So always name the agent something short that describes the work.
Pass `--no-focus` on every create, so the user's view never jumps.

### When `agent start` times out

`agent start` can return `{"error":{"code":"timeout"}}` when the launch actually
worked. A timeout means the outcome is unknown, not failed, so check the pane
before concluding anything:

```bash
herdr pane get <pane-id>   # read .result.pane.agent_session.value
```

If `agent_session.value` is present, the launch succeeded. herdr never
registered the named handle. So use the pane ID in place of the agent name for
every later `herdr agent ...` command – they all accept a pane ID. Use that
value as the session id for the acknowledgement watcher. `agent wait <name>` and
`agent get <name>` return `agent_not_found` here. That is normal, not a second
failure.

If it is absent, wait a few seconds. Then check once more. Only then treat the
launch as failed and report it.

Report upstream. If the timeout reproduces, file it against herdr – the launch
succeeded, but herdr never registered the handle.

## Launch: a new tab, for a continuation

Same shape one level down – no new checkout, so no worktree:

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --no-focus
# read the new tab's root pane ID from .result.root_pane.pane_id – same field the worktree's uses above
```

Then `herdr agent start` into that pane, exactly as above – same fresh-agent
opener, same handoff file path.

## The trust dialog

Handle this, or the launch hangs silently. A new worktree is a new directory, so
the launched session asks the user to trust the directory. It then sits at
`blocked`, while `agent start` has *already* returned success with
`interactive_ready: true`. Readiness is not proof the prompt is running. So after
starting, wait for the blocked state instead of polling by hand:

```bash
herdr agent wait <name> --until blocked --timeout <ms>
```

On `blocked`, accept the dialog with `herdr agent send-keys <name> enter`. Then
re-check by waiting for the session to start working:

```bash
herdr agent wait <name> --until working --timeout <ms>
```

If either wait times out, read the agent's current state directly with
`herdr agent get <name>` rather than guessing.

Throughout this section `<name>` is the pane ID instead, whenever the launch
timed out – see *When `agent start` times out*, above. Such a launch may already
be past the trust dialog. The pane can report `agent_status: working`, so
`herdr agent wait <pane-id> --until blocked` may simply time out. Read the
real state with `herdr agent get <pane-id>`, and carry on from there.

Never write `hasTrustDialogAccepted` into `~/.claude.json`, and never edit any
security settings file. SpecHub does not touch those.

## Without herdr

Detect herdr with `test "${HERDR_ENV:-}" = 1`. When absent, fall back to a
background session using the command template from `workflow.handoff.agent`
(default `claude`):

```bash
# again the FRESH AGENT opener defined above, verbatim
<agent-template> --bg --name "<name>" "The first line of your first reply must be the single word ACCEPT or DECLINE, followed by a one-line reason. Use plain text, with nothing at all before that word and no bold, heading, quote or code formatting. The sender matches that line literally, and cannot report this work as yours until it sees it. You may read <handoff-file> first to judge whether the work suits you, but reply before doing any other work. Then continue that work."
```

There are no tabs and no workspaces here, so the destination rule has two cases,
not three. A continuation – what would have been a new tab – is a plain `--bg`
session. It starts in the CURRENT directory, which is the checkout this session
is already in. That is exactly what a continuation wants.

Genuinely separate or parallel work still needs its own checkout, and `--bg`
will not make one – launched as-is it would quietly share this one. So create
the worktree first with the `new-worktree` skill, which falls back to a plain
git worktree when herdr is absent. Then launch the `--bg` session from inside
that worktree.

Everything else is identical, because both paths produce a real session with a
transcript.

## Routing to an agent already running

Message that session by name. *Propose* the work, and point at the handoff file.
Do not assign it, and do not assume the target accepted it. Open the message
with the **agent already running** variant of the acknowledgement instruction
above. That variant asks for a SendMessage reply whose first word is ACCEPT or
DECLINE. That reply is the only form of acknowledgement the watcher can see on
this channel.

Generate a short token – a random string that appears nowhere else, say
`ack-7f3a91c4` – and include it in the message text. The watcher anchors on it,
so counting starts when the target **receives** the message, not when this
session sends it. The target's queue absorbs however long the target was busy.
That is why a single number of turns serves both a running agent and a fresh
launch.

Generate the token fresh for every attempt – at least 8 random characters, and
never reused on a retry. The watcher matches it by substring, and anchors on the
FIRST match. So a reused token anchors on the ORIGINAL delivery, where the turns
have already elapsed. It then reports an instant silence that never happened.

## Watch for the acknowledgement

Do not eyeball transcripts. The CLI watches for you:

```bash
# --session-id with --cwd locates the target's transcript; --transcript <path>
# does it directly when the path is already known.
# --token anchors on delivery of our message. --turns: workflow.handoff.ack_turns,
# default 5. --poll-interval <ms> (default 1000) is how often the transcript is
# re-read. --timeout <ms> (default 1800000) is the watcher's own deadline –
# its expiry is the source of the `timeout` outcome.
~/.claude/spechub/bin/spechub handoff watch \
  --session-id <id> --cwd <dir> --token <token> --turns <n>
```

The two modes detect the acknowledgement differently. An existing agent received
a cross-session message. Its acknowledgement is a SendMessage sent back over
that same channel, and that message text must begin with ACCEPT or DECLINE. A
freshly launched agent has no handle for this session to reply on. Its
acknowledgement is the first line of its first reply, again beginning ACCEPT or
DECLINE. In `--fresh` mode the watcher reads that line straight from the
transcript text.

Either way the word has to lead. The watcher does not match a decision buried
mid-sentence. Neither form counts once the turn budget has run out.

An agent launched for this handoff leaves no delivery record. So pass `--fresh`
instead of `--token`, and counting starts at the first line of its transcript.
`claude agents --json` supplies `sessionId` and `cwd` for every live session,
and needs no terminal attached.

For a new worktree, `cwd` identifies the freshly launched session – it is the
new worktree's path. For a new tab, `cwd` cannot, because this session shares
that same cwd. So snapshot `claude agents --json` before launching. The target
is whichever session id appears afterward and was absent from the snapshot. The
no-herdr `--bg` fallback needs no snapshot at all. This session launched it with
`--name`, so find the row carrying that name in `claude agents --json`, and take
its session id.

When a herdr `agent start` timed out, there is no agent name to look up. The
session id is the `agent_session.value` read from `herdr pane get <pane-id>`.

**Run the watcher in the background.** This session has stopped working on the
task, but it must not lock up. The user can keep talking to it while the handoff
lands, and the harness surfaces the watcher's exit on its own. Never sit in a
foreground wait.

The watcher prints one JSON object and exits with one of three outcomes. The
same object carries `anchored`, and you cannot read one of those outcomes
honestly without it:

| Field                   | Means                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `outcome: acknowledged` | the target replied – `ack.decision` is `accept`, `decline`, or `null` if neither |
| `outcome: silence`      | delivered, or launched, then N turns passed with no acknowledgement            |
| `outcome: timeout`      | the watcher's own deadline elapsed first                                        |
| `anchored`              | whether the watcher ever saw the thing it counts from – our message arriving in the target's transcript, or a fresh agent's transcript beginning. `false` means delivery was never observed at all |

## What each outcome means

**ACCEPT** – the target owns the work now. Report that, and stop.

**DECLINE – read the reason before doing anything.** Two very different refusals
wear the same word:

| The reason is about                                            | Do                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| **fit** – busy, wrong scope, owns files this would conflict with | launch a fresh agent, as the handoff intended in the first place |
| **the merits** – the work looks wrong or unsafe                  | stop and report to the user; do not shop the work around     |

Treating the two identically throws away the useful half of the answer.

**Acknowledged, but `ack.decision` is null** – the target replied with something
that is neither ACCEPT nor DECLINE, such as a clarifying question. This is not
acceptance. Report the reply verbatim and stop. Never treat it as ownership.

**Silence** – a first-class outcome, not an error. The watcher saw the message
land, or saw the agent launch, and N turns then passed with nothing back. Report
exactly that. Name the target so the user can go and look. Then stop.

**Timeout – read `anchored` before saying a word about the target.** One outcome
covers two situations. Reporting the second as the first is the one report that
must never be wrong:

| `anchored` | What actually happened                                                                                            | Report it as                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `true`     | the message landed, or the fresh agent's transcript began, and the watcher's own deadline then ran out               | delivered (or launched), no answer yet                                          |
| `false`    | the watcher never saw it land: still queued, wrong session id or cwd, wrong or reused token, unreadable transcript   | **never observed delivered** – a fact about our watcher, not about the target   |

On `anchored: false`, never call the target silent, busy or unresponsive: there
is no evidence about the target at all. Have the user check the target's session
id, its cwd, and the token before concluding anything about it.

Nothing in any of these reports may imply anyone owns the work.

## Silence the context-pressure nudge

Once you finish the handoff, write the quiet marker. The context-pressure Stop
hook reads it and stays silent for the rest of this session. The work has
already moved on, so there is nothing left to nudge about:

```bash
d="${SPECHUB_CONTEXT_PRESSURE_DIR:-${TMPDIR:-/tmp}/spechub-context-pressure}"
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && mkdir -p "$d" && : > "$d/${CLAUDE_CODE_SESSION_ID}.quiet" || true
```

`CLAUDE_CODE_SESSION_ID` is this session's own id. The gate at the top ruled out
the child sessions where it would name the parent instead. So the marker lands
exactly where the hook looks for it.

If the variable holds nothing, skip this step and say so in the report. The hook
then keeps nudging, which is noisy but harmless. The hook clears the marker when
the session compacts, because it resets its state on `SessionStart` with
`source: compact`. So the nudge can return once the context grows again.

## Report

Always name the target, the handoff file path, and the next action the receiving
agent would take. The target is an agent name with its pane or workspace, or the
existing session.

Then say where the handoff actually stands, in the terms of the outcome above.
There are four cases. The target accepted it. The target declined on fit, and
you relaunched elsewhere. The target declined on the merits, and you carry the
objection in enough of its own words to act on. Nobody acknowledged it.

For an unacknowledged handoff, say which kind – delivered (or launched) with no
reply, versus never observed delivered at all. Then point the user at where to
look.

Never describe the work as owned by the target until the target has accepted it.
