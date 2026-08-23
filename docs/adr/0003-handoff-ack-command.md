# Handoff acknowledgement is a CLI command, not a reply

/spechub:handoff hands work to another agent and asks it to reply ACCEPT or DECLINE. The sender's watcher, `spechub handoff watch` (`cli/src/lib/ackwatch.ts`), grepped the receiver's transcript for that keyword, a convention an agent can drift from. The receiver now acknowledges by running `spechub handoff ack accept|decline --file <handoff-file> "<reason>"`. That command writes a sidecar `<handoff-file>.ack` file, which the watcher polls instead of the transcript.

## Considered options

- Wording only – tighten the ACCEPT/DECLINE prompt further. Rejected: it is still a convention, and the model can still drift from it.
- Lenient transcript matching – match more patterns in the transcript. Rejected: it keeps the same drift risk.
- A PreToolUse hook that blocks work until the sidecar exists – the only hard guarantee. Rejected for now: scoping the hook to handoff-launched sessions is separate work. Revisit if this failure recurs.

## Consequences

- The receiver can still read the handoff file first. It must run the ack command before any other tool use.
- The watcher gains an **engaged** outcome. Engaged means no acknowledgement, but a tool call after the anchor read the handoff file or used Agent, Edit, Write, or Bash.
- The sender sends one nudge after `ack_turns` turns, then restarts the watcher.
- A final engaged outcome is reported as "proceeding, unacknowledged." The sender never relaunches the work elsewhere. Two agents on the same files is the one failure file ownership exists to prevent.
- The transcript keyword match stays as a fallback, labelled `via: text`. It never writes the sidecar.
