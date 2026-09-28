# Launch without herdr

`SKILL.md` decides when to read this file: herdr does not host this session.

## Without herdr

Detect herdr with `test "${HERDR_ENV:-}" = 1`. When absent, fall back to a
background session using the command template from `workflow.handoff.agent`
(default `claude`):

```bash
# again the FRESH AGENT opener in SKILL.md, verbatim
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
