# A session's own transcript decides lead or child, not the environment

The `handoff` and `compact-and-continue` skills run only in a **lead session**,
because both write state the lead alone owns. An agent decides which it is by
planting a random mark in its own transcript and then asking which transcript
holds it.

A hit under `~/.claude/projects/<project>/<session>/subagents/` means the agent
is a subagent or a teammate. No environment variable takes part in that
decision.

The first version read `CLAUDE_CODE_CHILD_SESSION` instead. Claude Code sets
that variable to `1` in the environment of every Bash tool subprocess, in every
session. So the check was true unconditionally, and both skills refused to run
everywhere (#146).

The variable marks "spawned by Claude Code", and nothing finer.

## Considered options

- **A different environment variable.** Measured on Claude Code 2.1.241, an
  in-process subagent and an in-process teammate both report the lead's exact
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and `CLAUDE_CODE_ENTRYPOINT`. A child
  runs inside the lead's own process, so no variable separates them. Ruled out
  by measurement, not by preference.

- **Drop the check and let a child run the skills.** Simplest, and wrong. A
  child shares the lead's `CLAUDE_CODE_SESSION_ID`, so a child's quiet marker
  silences a context-pressure nudge the lead still needs, and a child's
  `spechub/HANDOFF.md` overwrites the lead's anchor.

- **Read `taskKind` from the agent's `.meta.json`.** The host does write one
  beside each agent transcript, naming `in_process_teammate` for a teammate and
  omitting `taskKind` for a plain subagent. An agent cannot tell which of those
  files is its own, so the file answers a question nobody can ask.

- **Plant a mark, then find it.** Chosen. The mark is unique per agent, so the
  answer is the agent's own and never a sibling's.

## Consequences

- The command polls for up to ten seconds rather than grepping once. The host
  writes the record carrying a command while that command still runs, roughly
  four seconds in.

    A single grep therefore runs too early, finds nothing and answers
    `lead` for everyone. A lead usually exits in about four seconds, as
    soon as its own record lands.

- The check reads a Claude Code internal layout that no public contract
  describes. A host that renames the `subagents/` directory, or files agent
  transcripts elsewhere, turns every child into a `lead` verdict.

- Absence of evidence reads as `lead`. A host that persists no transcript
  leaves the command empty-handed, and the skill proceeds. Failing closed is
  what produced #146, so the failure now falls on the side that keeps the
  skills runnable.

- The agent transcripts alone decide. An agent's own mark reaches
  `<session>.jsonl` whether it leads or not. So the loop reads that file only
  as an early exit for a lead, never as evidence of a child.

- The nonce placeholder stays angle-bracketed. `n=spechub-whoami-<nonce>` is a
  bash syntax error, so an agent that pastes the block without substituting
  fails loudly. A bare token would run instead. It would match every transcript
  in the session that had already read the skill file, so the command would
  answer `child` to a real lead.

- The agent still chooses the nonce, and a language model samples randomness
  badly. Two agents in one session that pick the same eight characters read
  each other's transcripts. Generating the nonce at runtime cannot fix that.

    The mark has to sit in the command text for the command to find it. A
    value computed at runtime reaches the transcript only after the command
    ends.

- Both skills carry their own copy of the block, rather than calling a shared
  script. `skills/new-worktree/detect-orchestrator.sh` shows the repo has that
  pattern. No home exists for a script two skills share, though.

    The repo also already repeats the context-pressure path expression in
    three places. `tests/test-skill-gates.sh` asserts the two copies match
    byte for byte. That assertion is what makes the duplication safe to keep.

- `tests/test-skill-gates.sh` extracts the command from each `SKILL.md` and
  runs it against fixture transcript layouts. The fixtures encode the layout
  above, so they need revisiting whenever the host changes it.
