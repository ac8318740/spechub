# Watch for the acknowledgement – detail

Read this file before any launch, and before you run the watcher. It holds the full flag reference and where each flag's value comes from.

## Why a command, not a word

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

The handoff file's first line, set out in `SKILL.md`, repeats the
acknowledgement requirement.

Both routes acknowledge with the same command, so this line reads the same on
both. The receiving agent may read this file before it decides, so the file is
the second place the requirement lands. The launch prompt is the first.

## The flags

```bash
# --file <handoff-file> names the handoff file. The watcher polls its sidecar,
# at <handoff-file>.ack. Always pass it, as an absolute path.
# --session-id with --cwd locates the target's transcript; --transcript <path>
# does it directly when the path is already known.
# --token anchors on delivery of our message. --turns: workflow.handoff.ack_turns,
# default 5. --poll-interval <ms> (default 1000) is how often the transcript is
# re-read. --timeout <ms> (default 1800000) is the watcher's own deadline –
# its expiry is the source of the `timeout` outcome.
# --nudged marks a restart after the one nudge – see outcomes.md.
# --ack-after <epoch-ms> moves the sidecar cut-off back. Only a token-route
# nudge restart passes it – see outcomes.md. The default is right
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
watch again*, in `outcomes.md`.

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
