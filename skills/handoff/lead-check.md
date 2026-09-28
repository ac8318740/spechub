# The lead check and the quiet marker

`SKILL.md` decides when to read this file: before you change the lead-check
command in *Only the lead session runs this*, or when its answer looks wrong.
That command is the one these facts describe.

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

## When the quiet marker clears

The hook clears the marker when the session compacts, because it resets its
state on `SessionStart` with `source: compact`. So the nudge can return once the
context grows again.
