# Setup: terminal workspace

`SKILL.md` decides when to read this file: every run reaches Step 12, and it runs from here.

## Step 12: Offer the terminal workspace

The terminal workspace runs several coding agents side by side in one terminal,
on a machine the user reaches over the network. It installs herdr and the tools
that read diffs, pull requests and files around it.

SpecHub needs none of it, so this step offers and never assumes.

Read what this machine already decided:

```bash
~/.claude/spechub/bin/spechub config get host.terminal_workspace
```

On exit 0 the user has already answered. Read which way it went:

- On `false`, say nothing and go to Step 13
- On `true`, check whether the workspace on this machine has fallen behind

```bash
PLUGIN=$(dirname "$(dirname "$(dirname "$(readlink -f ~/.claude/spechub/bin/spechub)")")")
SETUP="$PLUGIN/assets/terminal-workspace/setup.sh"
bash "$SETUP" outdated
```

Resolve the script rather than guessing its path. The SessionStart hook
repoints that CLI symlink at every start, so it names the newest installed
version. The `terminal-workspace` skill resolves the same script the same
way.

If the file is not there, say nothing and go to Step 13.

Act on what `outdated` returned:

- **Exit 0** – nothing has moved on. Say nothing and go to Step 13
- **Exit 2** – it cannot tell. Say one line naming why, then go to Step 13
- **Exit 1** – there is something to do. Show the findings verbatim, one per line, then ask once

A user deciding whether to spend two minutes on downloads needs to see what the
findings are.

Exit 1 with no tab-separated row is an older script printing its usage for a
subcommand it does not know. Say nothing and go to Step 13.

The findings decide which question to ask. A `missing` row means this machine
never installed the workspace, and it takes the first question. Everything else
takes the second.

On a `missing` row:

```json
{
  "question": "You said yes but the workspace was never installed here. Install it?",
  "header": "Workspace",
  "options": [
    {"label": "Yes", "description": "You then run /spechub:terminal-workspace, which installs herdr and the tools around it: several agents side by side in one terminal, sessions that survive a disconnect, and diffs, pull requests and files on one key each. Eleven components, every one reversible."},
    {"label": "No", "description": "Leave this machine as it is. Nothing in SpecHub needs the workspace, and the offer comes back next time you run setup."}
  ]
}
```

On **Yes**, print this line and go to Step 13:

```
Run /spechub:terminal-workspace – the installer is reserved for you to start.
```

On any other finding:

```json
{
  "question": "The terminal workspace has updates. Fetch them?",
  "header": "Workspace",
  "options": [
    {"label": "Yes", "description": "You then run /spechub:terminal-workspace upgrade, which reinstalls each stale tool and adds any new component's config block to your file."},
    {"label": "No", "description": "Leave this machine as it is. Everything installed keeps working, and the offer comes back next time you run setup."}
  ]
}
```

On **Yes**, print this line and go to Step 13:

```
Run /spechub:terminal-workspace upgrade – the installer is reserved for you to start.
```

Never run `upgrade` or `apply` yourself. Both install binaries and write the
user's config, which is the work the `terminal-workspace` skill owns. Running
`outdated` here is fine, because it only reads.

On **No**, go straight to Step 13 and record nothing. The next version may add
another component, so a "never ask" flag would silence a question nobody has
asked the user yet.

On any exit other than 0 or 2 the CLI is older than this skill and does not know
the key. Do not ask, and do not try to write the key. Say this instead, then go
to Step 13:

```
The spechub CLI on this machine predates host.terminal_workspace, so I cannot
record an answer. Restart Claude Code to relink the CLI, then run
/spechub:setup again.
```

The SessionStart hook repoints `~/.claude/spechub/bin/spechub` at every start,
so a restart is the whole fix. This only happens when a plugin update lands
mid-session.

On exit 2 nobody has answered yet. Ask once:

```json
{
  "question": "Set up the terminal workspace on this machine?",
  "header": "Workspace",
  "options": [
    {"label": "Yes", "description": "You then run /spechub:terminal-workspace, which installs herdr and the tools around it: several agents side by side in one terminal, sessions that survive a disconnect, and diffs, pull requests and files on one key each. Eleven components, every one reversible."},
    {"label": "No", "description": "Leave this machine as it is. Nothing in SpecHub needs the workspace, and /spechub:terminal-workspace installs it any time later."}
  ]
}
```

Write the answer, whichever way it went:

```bash
~/.claude/spechub/bin/spechub config set host.terminal_workspace true   # or false
```

Write it before doing anything else. The answer is the user's, and an installer
they never get round to running must not bring the question back on the next
project.

On **Yes**, hand the install to the user. The `terminal-workspace` skill sets
`disable-model-invocation: true`, so the Skill tool refuses every attempt to
call it from here. Print this line, then go to Step 13:

```
Recorded. Run /spechub:terminal-workspace to install it – the installer is
reserved for you to start.
```

Never replicate that skill's steps by hand. It installs binaries and writes one
config file, and a second writer of those files collides with it.

On **No**, go straight to Step 13. Name `/spechub:terminal-workspace` once, and
do not ask again.

This step is the only place that asks the axis. The `host` skill owns every
other `host.*` question, and leaves this one here. The workspace installs
binaries, so the offer belongs after the project works.
