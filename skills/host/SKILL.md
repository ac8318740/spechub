---
name: host
description: Declare the dev setup of the machine you are on – which agent orchestrators are installed to host terminal panes and git worktrees, which browser-verification modes work here, and the optional extras. Interviews you for every axis and writes the answers to the SpecHub CLI's global config under host.*. Run it once per machine.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Bash, Glob, Grep
---

# Host Setup

Declare what this machine can do, so the skills that need a browser, a terminal
pane or a git worktree stop guessing.

Three terms, before they get used:

- A **dev setup** is the set of machine-level tools a SpecHub session runs
  inside. It covers which agent orchestrators host the terminal panes and git
  worktrees. It also covers which browser-verification modes work on this
  machine, plus the optional extras, such as publishing the dev server to a
  private network.

- An **orchestrator**, in this skill, means a tool that owns terminal panes and
  git worktrees. There are two of them, `herdr` and `orca`, and they are
  declared separately – one yes-or-no answer each – because a machine can have
  both installed, one, or neither. A machine with neither uses plain git
  worktrees under `.claude/worktrees` in the repository.

- An **axis** is one setting of the dev setup, recorded as one `host.*` key.

## Why this is per machine, not per project

The answers go to the SpecHub CLI's global config, never to
`spechub/project.yaml`. Read [`notes.md`](notes.md) when the user asks why.

## What this skill installs

This skill declares a setup, and it installs two parts of one. It offers to
install Orca when Orca is missing here. It offers to write the managed block
that points herdr at its worktree directory.

Both offers live in Step 5. Each one plans first, shows you the steps, and waits
for your approval.

Linux is the only target both installs support. On macOS, on Windows and on the
Windows Subsystem for Linux, each script says it does not support the install
there, then stops.

This skill does not install a project, and it does not install herdr itself.
Logging in to Tailscale, connecting the Playwriter bridge and pairing a client
to Orca stay with you.

One axis this skill never asks: `host.terminal_workspace`. The `setup` skill
offers the terminal workspace in its last step, because that workspace installs
binaries and the offer belongs after the project works. Leave the key alone
here, and never ask about it.

## Step 1: Detect what is already here

Run the detection script that ships beside this file:

```bash
plugin_root=$(dirname "$(dirname "$(dirname "$(readlink -f ~/.claude/spechub/bin/spechub)")")")
bash "$plugin_root/skills/host/detect-host.sh"
```

Read [`notes.md`](notes.md) when the user asks why the path resolution
above derives the plugin root from a symlink.

If that symlink is missing, the SessionStart hook did not run. Tell the user to
restart Claude Code. If a restart does not fix it, point them at
`TROUBLESHOOTING.md` in the plugin root.

The script is read-only. It prints one JSON object to standard output and exits
0 even when it finds nothing at all. Missing tooling is a finding, not an error,
so a bare machine is a successful run.

Read [`questions.md`](questions.md) before asking anything. It says what
each detection field is evidence for, and holds the exact wording of every
question in Steps 2 and 3.

Then read what this machine already declares:

```bash
~/.claude/spechub/bin/spechub config get host
```

Exit code 0 prints the declared axes. Exit code 2 means this machine declares
nothing yet. The message goes to standard error and names the unset key.

Before asking anything, print a short summary to the user: one line per axis,
naming the current declaration and what the script detected. Re-running this
skill is safe. It re-asks every axis and uses the current answer as the starting
point, so a second run loses nothing.

## Step 2: The required axes – detection never decides them

The rule for this whole step is simple. **Auto-detection may pre-fill the
recommendation, but it never decides a required axis**.

A detected fact belongs in an option's description – "detected: this session is
running in a herdr pane" – and never in a silent write. The user answers, and
the detection only makes the answer easy.

### 2a. Orchestrators

There are two orchestrators, and they are two separate questions rather than one
choice between them. A machine can have both installed, one, or neither, so an
answer about one says nothing about the other.

Ask both in a single AskUserQuestion call, one question per orchestrator. There
is no skip: every machine has an answer to each.

Answering no to both is a real answer. It declares that this machine has no
orchestrator. The worktree skills then fall back to plain git worktrees under
`.claude/worktrees`.

The two questions, and the rules for filling their evidence placeholders,
are in [`questions.md`](questions.md).

### 2b. Browser-verification modes

There are three modes, and they are not alternatives to each other – a machine
can support any combination:

- **remote** drives a real browser on the developer's own machine, over the
  Playwriter bridge. That bridge forwards the browser's debugging port to this
  machine on port 19988.

- **headless** launches headless Chromium on this machine, meaning a browser
  with no visible window.

- **local** launches a visible browser on this machine, which needs a graphical
  display.

Ask them as one multi-select question – [`questions.md`](questions.md) holds
the wording, the "none of these" and "Decide later" rules, and when you
must ask it.

## Step 3: The optional axes – with skip

Ask these in one AskUserQuestion call. It carries a third question only when you
answered yes to Orca in Step 2. Otherwise omit that question rather than asking
it and discarding the answer.

The three questions – preview publishing, element picker and Orca topology –
are in [`questions.md`](questions.md).

A skipped axis and an axis answered `none` or `false` are different things, and
the difference matters:

- **Skipped** means unset. This skill writes nothing for that axis. Note what
    that costs at the command line.

    Run `spechub config get` on an unset axis. It writes its message to standard
    error and exits 2 for required and optional axes alike. Only the
    `(required)` or `(optional)` qualifier inside that message tells the two
    apart.

  The difference that actually matters belongs to `spechub config check`, the
  health check. It lists an unset optional axis as informational, and fails only
  on an unset required one.

- **`none` and `false`** are real declarations – the user has said this machine
  does not have the thing.

Never write a value to represent a skip. If the user skips, write nothing for
that axis.

## Step 4: Write the answers

One `config set` call per answered axis:

```bash
~/.claude/spechub/bin/spechub config set host.orchestrators.herdr <true|false>
~/.claude/spechub/bin/spechub config set host.orchestrators.orca <true|false>
~/.claude/spechub/bin/spechub config set host.browser.remote <true|false>
~/.claude/spechub/bin/spechub config set host.browser.headless <true|false>
~/.claude/spechub/bin/spechub config set host.browser.local <true|false>
~/.claude/spechub/bin/spechub config set host.preview.tailscale_serve <true|false>
~/.claude/spechub/bin/spechub config set host.element_picker <stagewise|orca-design-mode|none>
~/.claude/spechub/bin/spechub config set host.orca.topology <local|remote>
```

The rules for this step:

- Write nothing for a skipped axis.
- A success prints `Set <key> = <value>`, with the value rendered as JSON rather
  than bare – so a string axis comes back quoted, `Set host.element_picker =
  "stagewise"`, and a boolean comes back unquoted, `Set host.browser.local =
  true`. A non-zero exit has two causes, and the message tells them apart.

- On a non-zero exit, read [`notes.md`](notes.md) – it covers both causes
  and how to recover from each

- Setting `host.orca.topology` while `host.orchestrators.orca` is not true is
  accepted, and the CLI warns that nothing reads it, so do not write it in that
  case at all.

## Step 5: Follow-up for each orchestrator declared installed

Run the follow-up for every orchestrator answered yes in Step 2. Two yes answers
means both follow-ups run, in either order. Two no answers means neither runs,
and the last section applies instead.

### What both installers share

Both scripts take `--plan`, `--apply` and `--help`. `--help` prints the usage
and the options.

| Exit code | Meaning |
| --- | --- |
| 0 | the run succeeded |
| 1 | a step failed, or the write failed |
| 3 | the script does not support this platform, and it changed nothing |
| 4 | the script cannot safely edit the config file (`install-herdr-block.sh` only) |
| 64 | the script rejected an argument |

`install-orca.sh` checks `--pairing-address` when it parses the arguments. It
takes a plain host name or address, and rejects anything else with exit 64. A
value holding a space or a slash never reaches the unit.

### When you declared Orca installed

Read [`orca.md`](orca.md) when the user declared Orca installed in Step 2.
It registers this repository, states the Claude settings rewrite, and
offers to install Orca when it is missing.

### When you declared herdr installed

Read [`herdr.md`](herdr.md) when the user declared herdr installed in
Step 2. It offers to write the managed block in herdr's config.

### When you declared neither installed

There is nothing to provision. The worktree skills fall back to plain git
worktrees under `.claude/worktrees` in the repository.

## Step 6: Report

Close with the report in [`report.md`](report.md). Read it once every answer is
written and every follow-up has run.

## Notes

Read [`notes.md`](notes.md) when a question comes up about what a
declaration means, or how `host.browser.*` relates to
`frontend.browser.mode`.
