# Outcomes of the watch

`SKILL.md` decides when to read this file: the watcher has exited and printed
its result.

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
every attempt*, in `running-agent.md`, so never send it carrying the first token.

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

## Reporting an unacknowledged handoff

For an unacknowledged handoff, say which kind – delivered (or launched) with no
answer, versus never observed delivered at all. Then point the user at where to
look.

**Read `staleAck` before calling any handoff unacknowledged.** It means a
sidecar sits on disk that the cut-off ruled out. Report its decision and its
`at`, name the cut-off from `ackAfter`, and never spend the nudge on a target
that already answered.
