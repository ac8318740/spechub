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

The reason to stop is the quiet marker. This skill's last step writes that
marker, which silences the lead's context-pressure nudge. Inside a child
session `CLAUDE_CODE_SESSION_ID` names the lead, so its marker silences a nudge
the lead still needs.

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

## Naming workspaces and tabs

herdr labels a new tab with a number, such as `1` or `2`. A user with four tabs
open cannot tell which agent works on what.

So every workspace and tab a handoff touches carries a descriptive label.
`label` is the only naming field herdr has. There is no `--name`, no `--title`,
and no `tab update`.

A tab label reads `<topic>-<thread>.<step>`.

- **topic** names the work in one or two words, lower-case and hyphenated, such
  as `auth-bug` or `csv-export`. For a new worktree it is the workspace slug
  already passed to `--label`, or a shortening of it. For a new tab it is the
  subject of the handoff.

- **thread** numbers a line of work inside the workspace. The numbering restarts
  in each workspace. So a handoff into a new worktree labels the receiving tab
  `<topic>-1.0`, and a handoff inside this workspace labels it `<topic>-1.1`.

- **step** counts the handoffs along that line.

    The session that started the line is step 0. The agent it hands to is
    step 1. That agent's own handoff is step 2.

Keep the topic to two words at most, so the whole label fits the tab strip.

| Tab label      | Who holds it                                      |
| -------------- | ------------------------------------------------- |
| `auth-bug-1.0` | the session that started the line of work         |
| `auth-bug-1.1` | the agent that session hands to                   |
| `auth-bug-1.2` | the agent the step 1 agent hands to               |
| `auth-bug-2.0` | a fresh line of work started in the same workspace |

Read the labels already in use before you create a tab, so the new one continues
the numbering instead of colliding with it:

```bash
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
# {"result":{"tabs":[{"tab_id":"w1X:t1","label":"1","number":1}]}}
```

Find this session's own tab in that list. `$HERDR_TAB_ID` names it. herdr sets
that variable in every managed pane, so an empty value means this session sits
in no herdr pane. Skip the rename of this session's tab then, and never fall
back to the focused tab. The focused tab belongs to whichever pane the user is
looking at, which is often another workspace.

A label of digits only is still the herdr default. Rename such a tab before you
create its successor, so the pair reads as a sequence:

```bash
herdr tab rename <tab_id> <topic>-<thread>.0
```

Rename another tab only when its label is digits only. Any other label may be
one the user or another agent set. Leave it alone.

A new worktree gets its workspace label from `herdr worktree create --label
<slug>`. Rename the workspace when that slug is long, or says little to a
reader – one or two words plus the branch intent:

```bash
herdr workspace rename <workspace_id> <label>
```

The first tab of a new workspace is the spare root pane's tab. Rename it to
`<topic>-1.0` after `worktree create`.

Read its tab id from the create JSON, or from
`herdr tab list --workspace <new_ws_id>`. Never hardcode a tab id.

Match the agent name in `herdr agent start <name>` to the tab label. The handle
regex is `[a-z][a-z0-9_-]{0,31}`, which allows no dot. So the agent whose tab is
`auth-bug-1.1` takes the name `auth-bug-1-1`.

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
verbatim, with `<this-file>` replaced by the file's own path:

```text
Acknowledge before any other tool call. Run ~/.claude/spechub/bin/spechub handoff ack accept --file <this-file> "<one-line reason>", or ack decline --file <this-file> "<one-line reason>". The command writes <this-file>.ack, which the sender watches.
```

Both routes acknowledge with the same command, so this line reads the same on
both. The receiving agent may read this file before it decides, so the file is
the second place the requirement lands. The launch prompt is the first.

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

*The command records the decision. The typed word stays a convention.*

Cross-session messaging has no accept-or-decline mechanism. A peer can read a
message and simply ignore it, and nobody tells the sender.

So the receiver acknowledges by running a command.
`spechub handoff ack accept|decline` writes a sidecar file at
`<handoff-file>.ack`, beside the handoff file in the temp directory. The watcher
polls for that path.

The sidecar makes the decision a recorded fact, rather than a phrase the sender
must recognise.

A typed ACCEPT or DECLINE in the transcript still counts. The watcher reports
that fallback as `ack.via: 'text'`. It stays a convention an agent can drift
from.

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

**Agent already running** – one reached by cross-session message. It runs the
same command.

A `SendMessage` reply is no longer required. A reply that begins ACCEPT or
DECLINE is the recognised fallback:

> Before any other tool call, acknowledge this handoff by running ~/.claude/spechub/bin/spechub handoff ack accept --file <handoff-file> "<one-line reason>", or ack decline --file <handoff-file> "<one-line reason>". You may read <handoff-file> first to judge whether the work suits you, and nothing else until the command has run – the sender watches for the file it writes and cannot report this work as yours until it exists. A SendMessage reply beginning ACCEPT or DECLINE is a recognised fallback, but the command is what this handoff expects. Then continue that work.

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

# name the workspace's first tab – read its tab id from the JSON, never hardcode
herdr tab rename <root_tab_id> <topic>-1.0

# the quoted prompt is the FRESH AGENT opener defined above – use it verbatim
herdr agent start <handoff-name> --kind claude --pane <root_pane_id> \
  -- "Before any other tool call, acknowledge this handoff by running ~/.claude/spechub/bin/spechub handoff ack accept --file <handoff-file> \"<one-line reason>\", or ack decline --file <handoff-file> \"<one-line reason>\". You may read <handoff-file> first to judge whether the work suits you, and nothing else until the command has run – the sender watches for the file it writes and cannot report this work as yours until it exists. Then continue that work."
```

`--label <slug>` names the workspace, and the rename names its first tab –
*Naming workspaces and tabs*, above, gives the format.

`<base>` is `origin/dev` when that ref exists, otherwise `origin/main` – the same
rule the `new-worktree` skill follows. Local `dev` is often behind. So the fetch
comes first, and the command cuts the branch from the remote ref.

Stop after `worktree create`. It already leaves a spare root shell pane in the
new workspace, and that is the pane the agent goes into.

The `new-worktree` skill's extra pane-move steps exist only because that skill
wants the caller to end up there. A handoff does not.

The agent name is the handle – `[a-z][a-z0-9_-]{0,31}`, unique among live
agents. Every `herdr agent` subcommand accepts it in place of a pane ID, and it
survives a pane move. So always name the agent something short that describes
the work.

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
every later `herdr agent ...` command – they all accept a pane ID.

Use that value as the session id for the acknowledgement watcher.
`agent wait <name>` and `agent get <name>` return `agent_not_found` here. That
is normal, not a second failure.

If it is absent, wait a few seconds. Then check once more. Only then treat the
launch as failed and report it.

Report upstream. If the timeout reproduces, file it against herdr – the launch
succeeded, but herdr never registered the handle.

## Launch: a new tab, for a continuation

Same shape one level down – no new checkout, so no worktree:

```bash
herdr tab list --workspace "$HERDR_WORKSPACE_ID"   # the labels already in use
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label <topic>-<thread>.<step> --no-focus
# read the new tab's root pane ID from .result.root_pane.pane_id – same field the worktree's uses above
```

`--label` sets the tab label at creation – *Naming workspaces and tabs*, above,
gives the format and the numbering.

Then `herdr agent start` into that pane, exactly as above – same fresh-agent
opener, same handoff file path.

## The trust dialog

Handle this, or the launch hangs silently. A new worktree is a new directory, so
the launched session asks the user to trust the directory. It then sits at
`blocked`, while `agent start` has *already* returned success with
`interactive_ready: true`.

Readiness is not proof the prompt is running. So after starting, wait for the
blocked state instead of polling by hand:

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
timed out – see *When `agent start` times out*, above.

Such a launch may already be past the trust dialog. The pane can report
`agent_status: working`, so `herdr agent wait <pane-id> --until blocked` may
simply time out. Read the real state with `herdr agent get <pane-id>`, and carry
on from there.

Never write `hasTrustDialogAccepted` into `~/.claude.json`, and never edit any
security settings file. SpecHub does not touch those.

## Without herdr

Detect herdr with `test "${HERDR_ENV:-}" = 1`. When absent, fall back to a
background session using the command template from `workflow.handoff.agent`
(default `claude`):

```bash
# again the FRESH AGENT opener defined above, verbatim
<agent-template> --bg --name "<name>" "Before any other tool call, acknowledge this handoff by running ~/.claude/spechub/bin/spechub handoff ack accept --file <handoff-file> \"<one-line reason>\", or ack decline --file <handoff-file> \"<one-line reason>\". You may read <handoff-file> first to judge whether the work suits you, and nothing else until the command has run – the sender watches for the file it writes and cannot report this work as yours until it exists. Then continue that work."
```

There are no tabs and no workspaces here, so the destination rule has two cases,
not three.

A continuation – what would have been a new tab – is a plain `--bg` session. It
starts in the CURRENT directory, which is the checkout this session is already
in. That is exactly what a continuation wants.

Genuinely separate or parallel work still needs its own checkout, and `--bg`
will not make one – launched as-is it would quietly share this one. So create
the worktree first with the `new-worktree` skill, which falls back to a plain
git worktree when herdr is absent. Then launch the `--bg` session from inside
that worktree.

Everything else is identical, because both paths produce a real session with a
transcript.

## Routing to an agent already running

Message that session by name. *Propose* the work, and point at the handoff file.
Do not assign it, and do not assume the target accepted it.

Open the message with the **agent already running** variant of the
acknowledgement instruction above. That variant asks for the ack command, and
names a reply beginning ACCEPT or DECLINE as the fallback.

Generate a short token – a random string that appears nowhere else, say
`ack-7f3a91c4` – and include it in the message text. The token still belongs in
the message, even though the acknowledgement no longer travels back over this
channel.

The watcher anchors on it, so counting starts when the target **receives** the
message, not when this session sends it. The target's queue absorbs however long
the target was busy. That is why a single number of turns serves both a running
agent and a fresh launch.

Generate the token fresh for every attempt – at least 8 random characters, and
never reused on a retry. The watcher matches it by substring, and anchors on the
FIRST match.

So a reused token anchors on the ORIGINAL delivery, where the turns have already
elapsed. It then reports an instant silence that never happened.

The nudge in *Nudge once, then watch again*, below, is one of those attempts,
and carries a fresh token of its own.

## Watch for the acknowledgement

Do not eyeball transcripts. The CLI watches for you:

```bash
# --file <handoff-file> names the handoff file. The watcher polls its sidecar,
# at <handoff-file>.ack. Always pass it, as an absolute path.
# --session-id with --cwd locates the target's transcript; --transcript <path>
# does it directly when the path is already known.
# --token anchors on delivery of our message. --turns: workflow.handoff.ack_turns,
# default 5. --poll-interval <ms> (default 1000) is how often the transcript is
# re-read. --timeout <ms> (default 1800000) is the watcher's own deadline –
# its expiry is the source of the `timeout` outcome.
# --nudged marks a restart after the one nudge – see the section below.
# --ack-after <epoch-ms> moves the sidecar cut-off back. Only a token-route
# nudge restart passes it – see the section below. The default is right
# everywhere else.
~/.claude/spechub/bin/spechub handoff watch --file <handoff-file> \
  --session-id <id> --cwd <dir> --token <token> --turns <n>
```

The watcher reads two sources. The sidecar `<handoff-file>.ack` holds the
acknowledgement the ack command writes, and the watcher reports it as
`ack.via: 'cli'`. The transcript is the fallback, reported as `ack.via: 'text'`
– a SendMessage beginning ACCEPT or DECLINE, or, for a fresh agent, a reply
beginning with it.

The word has to lead there. The watcher does not match a decision buried
mid-sentence.

`--file` must be an absolute path here, the same rule `--cwd` follows, and the
watcher exits 1 on a relative one. The sender types this path against another
session's world, where "relative to here" names a different file. The
receiver's `handoff ack --file` is the lenient half of the pair – it takes a
relative path and resolves it against its own working directory.

The two sources differ in when they count. The transcript stops counting once
the target spends the turn budget, because the watch has resolved by then.

The sidecar needs no anchor at all. The watcher reads it first on every tick, so
a target whose delivery record has not landed yet still acknowledges.

The transcript also shows whether the target is working, which separates
`engaged` from `silence`.

Every watch ignores any sidecar written before a cut-off. So a sidecar from an
earlier round never closes this watch, and nothing has to delete
`<handoff-file>.ack` between attempts. The watcher reports the cut-off it used
as `ackAfter`, and each route picks its own:

| Route     | Cut-off                                             |
| --------- | --------------------------------------------------- |
| `--token` | the moment this watch starts, reported as `startedAt` |
| `--fresh` | the launch, read off the first timestamped line of the target's transcript |

`--fresh` reaches back to the launch because the ack usually lands before the
watch. The sender has to recover the new session id before it can watch, while
the launch prompt tells the target to acknowledge before anything else.

So a well-behaved target answers inside that gap, roughly half a minute wide.

The launch cut-off still keeps an earlier round out. A relaunch after a decline
reuses the handoff file, and the first target's decline sidecar with it. The
relaunched agent's transcript begins after that decline.

`--ack-after <epoch-ms>` overrides both, for a restart that has to reach behind
its own start. Only the token-route nudge restart does – *Nudge once, then
watch again*, below.

An agent launched for this handoff leaves no delivery record. So pass `--fresh`
instead of `--token`, and counting starts at the first line of its transcript.
`claude agents --json` supplies `sessionId` and `cwd` for every live session,
and needs no terminal attached.

For a new worktree, `cwd` identifies the freshly launched session – it is the
new worktree's path.

For a new tab, `cwd` cannot, because this session shares that same cwd. So
snapshot `claude agents --json` before launching. The target is whichever
session id appears afterward and was absent from the snapshot.

The no-herdr `--bg` fallback needs no snapshot at all. This session launched it
with `--name`, so find the row carrying that name in `claude agents --json`, and
take its session id.

When a herdr `agent start` timed out, there is no agent name to look up. The
session id is the `agent_session.value` read from `herdr pane get <pane-id>`.

**Run the watcher in the background.** This session has stopped working on the
task, but it must not lock up. The user can keep talking to it while the handoff
lands, and the harness surfaces the watcher's exit on its own. Never sit in a
foreground wait.

The watcher prints one JSON object and exits with one of four outcomes. The
same object carries `anchored`, and you cannot read one of those outcomes
honestly without it:

| Field                   | Means                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `outcome: acknowledged` | the target acknowledged – `ack.decision` is `accept`, `decline`, or `null` if neither |
| `outcome: engaged`      | no acknowledgement after N turns, but the target read the handoff file or started using work tools |
| `outcome: silence`      | delivered, or launched, then N turns passed with no acknowledgement            |
| `outcome: timeout`      | the watcher's own deadline elapsed first                                        |
| `ack.via`               | `cli` when the sidecar recorded the decision, `text` when only the transcript did |
| `ack.reason`            | the one-line reason the target gave, or `null` when it gave none               |
| `nudged`                | whether this watch ran with `--nudged`, so the one nudge is already spent      |
| `engaged`               | whether the target is working on the handoff, whatever the outcome            |
| `staleAck`              | a sidecar that exists but predates the cut-off – read it before reporting no answer |
| `ackAfter`              | the sidecar cut-off this watch applied, in epoch milliseconds; `null` means the target's transcript had not begun |
| `startedAt`             | epoch milliseconds at which this watch began, and the token route's sidecar cut-off |
| `anchored`              | whether the watcher ever saw the thing it counts from – our message arriving in the target's transcript, or a fresh agent's transcript beginning. `false` means delivery was never observed at all |

## Nudge once, then watch again

An unacknowledged target gets exactly one nudge. The watcher returns `silence`
or `engaged`, and `nudged` is `false`.

Send one message to the target saying it has not acknowledged, and that it must
run the ack command now. Quote the command with the handoff file path in it.

| The target is        | Nudge it with                                            |
| -------------------- | -------------------------------------------------------- |
| in a fresh pane      | `herdr agent prompt <name> "<nudge text>"`               |
| already running      | `SendMessage`                                            |

Then restart the watcher. Keep every argument, add `--nudged`, and re-anchor.

The second watch must not count from where the first one started. It would
report an instant silence off turns that elapsed before the nudge.

Each route re-anchors differently:

| The first watch used | Re-anchor the second one by                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `--token`            | putting a fresh token in the nudge message, and passing that new token    |
| `--fresh`            | passing `--turns` at double `workflow.handoff.ack_turns`                  |

The token route gets a new anchor for free, because the nudge is a fresh
delivery. The nudge counts as an attempt under *Generate the token fresh for
every attempt*, above, so never send it carrying the first token.

The fresh route has no such anchor – `--fresh` counts from record 0 again, over
a transcript that already holds the spent turns. Double the budget covers the
spent turns and a fresh budget on top.

On the token route, pass `--ack-after <startedAt>` too, carrying the
`startedAt` the first watch reported. Without it the restart would throw away
an ack the target wrote in the gap between the first watch ending and this one
starting. The fresh route needs no flag: its cut-off is the launch, which is
already behind both watches.

```bash
# token route – <new-token> is the one in the nudge message
~/.claude/spechub/bin/spechub handoff watch --file <handoff-file> --nudged \
  --session-id <id> --cwd <dir> --token <new-token> --turns <n> \
  --ack-after <startedAt of the first watch>

# fresh route – <n> doubled, because --fresh re-counts the spent turns
~/.claude/spechub/bin/spechub handoff watch --file <handoff-file> --nudged \
  --session-id <id> --cwd <dir> --fresh --turns <2n>
```

The `--nudged` flag tells the second watch that the target has had its nudge,
so never omit it. Never nudge twice. A watcher that returns `nudged: true` has
had its one nudge – act on the outcome and report.

## What each outcome means

**ACCEPT** – the target owns the work now. Report that, and stop.

**DECLINE – read the reason before doing anything.** Two very different refusals
wear the same word:

| The reason is about                                            | Do                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| **fit** – busy, wrong scope, owns files this would conflict with | launch a fresh agent, as the handoff intended in the first place |
| **the merits** – the work looks wrong or unsafe                  | stop and report to the user; do not shop the work around     |

Treating the two identically throws away the useful half of the answer.

A relaunch after a decline on fit reuses the same handoff file, and needs no
cleanup. The new watch ignores the decline sidecar the first target wrote,
because that sidecar predates the new agent's launch.

Never pass `--ack-after` on such a relaunch. It aims at a new agent, so the
launch cut-off is the one that keeps the old decline out.

**Acknowledged, but `ack.decision` is null** – the target replied with something
that is neither ACCEPT nor DECLINE, such as a clarifying question. This is not
acceptance.

Report the reply verbatim and stop. Never treat it as ownership.

This outcome only appears when the watch ran without `--file`. With `--file` the
watcher never reports a null decision. The sidecar records one word or the
other, and a keyword-free SendMessage is not an acknowledgement.

**`ack.via: text`** – report it as an acknowledgement, and say the target typed
the decision rather than recording it. The sidecar does not exist, so nothing on
disk holds the decision.

A target that cannot write the sidecar gets that instruction from the failing
ack command itself. A read-only temp directory is one such case. The command
tells the target to reply with a message beginning ACCEPT or DECLINE.

Everything else about the outcome reads the same.

**Engaged** – the target is doing the work without acknowledging it. On
`nudged: false`, nudge once and watch again. On `nudged: true`, report
"proceeding, unacknowledged", name the target, and stop.

**Never relaunch the work elsewhere.** Two agents on the same files is the
failure file ownership exists to prevent. A second launch causes exactly it.

**Silence** – a first-class outcome, not an error. The watcher saw the message
land, or saw the agent launch, and N turns then passed with nothing back.

Nudge once, then watch again. After the nudge, report exactly that.

Name the target so the user can go and look. Then stop.

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

On `engaged: true`, report "proceeding, unacknowledged", whatever the outcome.
The field rides on every result, so a timeout can carry it too. Never relaunch
the handoff elsewhere while the target works on it.

Nothing in any of these reports may imply anyone owns the work.

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

The hook clears the marker when the session compacts, because it resets its
state on `SessionStart` with `source: compact`. So the nudge can return once the
context grows again.

## Report

Always name the target, the handoff file path, and the next action the receiving
agent would take. The target is an agent name with its pane or workspace, or the
existing session.

For a launched agent, also name the workspace label and the tab label. Those are
what the user reads off the tab strip to find the pane.

Then say where the handoff stands, in the terms of the outcome above.

- accepted
- declined on fit, and relaunched elsewhere
- declined on the merits, with the objection in enough of its own words to act on
- proceeding, unacknowledged – the target engaged, and you spent the nudge
- unacknowledged

For an unacknowledged handoff, say which kind – delivered (or launched) with no
answer, versus never observed delivered at all. Then point the user at where to
look.

**Read `staleAck` before calling any handoff unacknowledged.** It means a
sidecar sits on disk that the cut-off ruled out. Report its decision and its
`at`, name the cut-off from `ackAfter`, and never spend the nudge on a target
that already answered.

Never describe the work as owned by the target until the target has accepted it.
