# Route to an agent already running

`SKILL.md` decides when to read this file: the work goes to a session that is
already running, by message, with no new pane.

Listed is not the same as reachable. Each row carries a `state` field. You
cannot message a row that is not in a live or working state, even though the
listing shows it.

If a session is already working in this worktree or repository, weigh it and
propose it. Ask the user to confirm a target whose working directory sits
outside this repository, unless the user named that target. *Routing to an agent
already running*, below, gives the way to propose the work to such a session.

**Agent already running** – one reached by cross-session message. It runs the
same command.

A `SendMessage` reply is no longer required. A reply that begins ACCEPT or
DECLINE is the recognised fallback:

> Before any other tool call, acknowledge this handoff by running ~/.claude/spechub/bin/spechub handoff ack accept --file <handoff-file> "<one-line reason>", or ack decline --file <handoff-file> "<one-line reason>". You may read <handoff-file> first to judge whether the work suits you, and nothing else until the command has run – the sender watches for the file it writes and cannot report this work as yours until it exists. A SendMessage reply beginning ACCEPT or DECLINE is a recognised fallback, but the command is what this handoff expects. Then continue that work.

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

The nudge in *Nudge once, then watch again*, in `outcomes.md`, is one of those attempts,
and carries a fresh token of its own.
