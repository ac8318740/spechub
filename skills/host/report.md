# Host report

Read this file at Step 6, once you have written every answer and run every follow-up.

Close with a block in this shape – aligned labels, one line per axis, skipped
axes shown as `(unset – skipped)`:

```
## Host Declared

Orchestrators: herdr [true|false], orca [true|false]
Browser:       remote [true|false], headless [true|false], local [true|false]
Preview:       [true | false | (unset – skipped)]
Picker:        [stagewise | orca-design-mode | none | (unset – skipped)]
Orca topology: [local | remote | (unset – skipped) | not applicable]
Config:        [the path `spechub config path` printed]

Not automated yet: [what still has to be done by hand – logging in to Tailscale,
connecting the Playwriter bridge, pairing a client to Orca, turning on "Show in
worktree list" – or "nothing".]

Next: [run /spechub:setup in a project, or `~/.claude/spechub/bin/spechub config
check` to health-check what was just declared against this machine and against
the project in the current directory.]
```

The last item on that list is easy to miss. "Show in worktree list" is a
per-repository setting in the Orca desktop application.

Turning it on is what puts herdr checkouts on a phone. The user turns it on once
for each repository.

Get the `Config:` line by running the command, not by writing the usual path in:

```bash
~/.claude/spechub/bin/spechub config path
```

`~/.config/spechub/config.json` is only where the file lands by default. Setting
the `XDG_CONFIG_HOME` environment variable moves it. On a machine that sets that
variable, a hardcoded path in the report would point at a file that does not
exist.
