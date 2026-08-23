---
name: host
description: Declare the dev setup of the machine you are on – which agent orchestrator hosts the terminal panes and git worktrees, which browser-verification modes work here, and the optional extras. Interviews you for every axis and writes the answers to the SpecHub CLI's global config under host.*. Run it once per machine.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Bash, Glob, Grep
---

# Host Setup

Declare what this machine can do, so the skills that need a browser, a terminal
pane or a git worktree stop guessing.

Three terms, before they get used:

- A **dev setup** is the set of machine-level tools a SpecHub session runs
  inside: which agent orchestrator hosts the terminal panes and git worktrees,
  which browser-verification modes work on this machine, and optional extras
  such as publishing the dev server to a private network.
- An **orchestrator**, in this skill, means the tool that owns terminal panes
  and git worktrees – `herdr`, `orca`, or `none`, where `none` means plain git
  worktrees under `.claude/worktrees` in the repository.
- An **axis** is one setting of the dev setup, recorded as one `host.*` key.

## Why this is per machine, not per project

The same repository gets opened on several machines, and those machines differ.
A laptop with a screen can launch a visible browser; a headless build server
cannot. One machine has herdr installed, another has Orca, another has neither.
None of that is a property of the project, so none of it belongs in the
project's config file.

The answers therefore go to the SpecHub command-line interface's global config,
a JSON file at `~/.config/spechub/config.json` (or under `$XDG_CONFIG_HOME`
when that environment variable is set – `~/.claude/spechub/bin/spechub config
path` prints the real location). They do not go in `spechub/project.yaml`.

Project concerns stay in `project.yaml`. In particular
`frontend.browser.mode` stays there as the *project's preference*, while
`host.browser.*` says what this *machine* can actually do. The two are
different questions and they are answered in different files.

## What this skill does not do

This skill declares a setup. It does not install one.

Installing missing tooling on a fresh machine is a separate provisioning step
that has not been built yet (tracked as SpecHub issue #64). Until it exists,
when a tool is missing this skill says so plainly and names what that later step
will do, so the user can do it by hand if they want to. It installs nothing
itself.

## Step 1: Detect what is already here

Run the detection script that ships beside this file:

```bash
plugin_root=$(dirname "$(dirname "$(dirname "$(readlink -f ~/.claude/spechub/bin/spechub)")")")
bash "$plugin_root/skills/host/detect-host.sh"
```

The path resolution looks odd, so here is why. The plugin's own files live in a
versioned cache directory whose path changes on every release, so it cannot be
hardcoded. `~/.claude/spechub/bin/spechub` is the one invariant path – a symlink
that the SessionStart hook, which Claude Code runs at the start of every
session, re-points at the current cache – so the plugin root is derived from it
rather than written down.

If that symlink is missing, the SessionStart hook did not run. Tell the user to
restart Claude Code. If a restart does not fix it, point them at
`TROUBLESHOOTING.md` in the plugin root.

The script is read-only. It prints one JSON object to standard output and exits
0 even when it finds nothing at all. Missing tooling is a finding, not an error,
so a bare machine is a successful run.

What it reports, and what each field is evidence for:

| Field | Evidence for |
| --- | --- |
| `orchestrator.herdr_binary` | herdr is installed here (absolute path, or `null`) |
| `orchestrator.orca_binary` | Orca is installed here – the executable is `orca-ide`, with `orca` as an alternative on some installs |
| `orchestrator.hosting_this_session` | Which orchestrator's terminal pane this very session is running in, read from the variable each one exports: `ORCA_PANE_KEY` for Orca, `HERDR_ENV` for herdr |
| `browser.agent_browser_binary` | The `agent-browser` command-line tool, which is what drives a browser during verification |
| `browser.bridge_port_answers` | Something answered on local port 19988, which is where the Playwriter bridge – a reverse-SSH setup that lets an agent on this machine drive a real Chrome browser on the developer's own machine – forwards that browser's debugging port |
| `browser.chromium_binaries` | Chromium-family browsers found on this machine, which is what headless verification launches |
| `browser.display` | A graphical session exists (`DISPLAY` or `WAYLAND_DISPLAY` is set), without which nobody can watch a visible browser |
| `preview.tailscale_binary`, `preview.tailscale_logged_in` | Tailscale is installed, and separately whether anyone has logged it in – an installed but logged-out Tailscale publishes nothing |
| `element_picker.stagewise_binary` | `stagewise` is installed – an element picker, meaning a tool that lets the user click an element in the running app and hand the reference to an agent |
| `orca_topology.serve_unit_active` | A user-level service named exactly `orca` is running, which is the shape of a machine serving Orca to a viewer elsewhere. The name is an assumption: whatever provisions the server picks it, and nothing pins it yet, so a unit installed under any other name reads here as "no server" and the topology recommendation below silently comes out `local` |
| `claude_settings.orca_hooks_present` | `~/.claude/settings.json` mentions Orca somewhere. The match is a loose, case-insensitive search for that word anywhere in the file, so an unrelated path or permission entry containing it counts too – this is evidence that Orca has wired its hooks in, not proof |
| `claude_settings.backup_exists` | `~/.claude/settings.json.bak` exists |
| `project.root`, `project.has_frontend` | The git repository the current directory sits in, and whether its `spechub/project.yaml` configures a frontend |

Several sections also carry a `recommended` field. That is the script's
mechanical reading of the evidence above it and nothing more. It is a starting
point for a question, never an answer.

Then read what is already declared on this machine:

```bash
~/.claude/spechub/bin/spechub config get host
```

Exit code 0 prints the declared axes. Exit code 2 means nothing is declared on
this machine yet; the message goes to standard error and names the key that is
unset.

Before asking anything, print a short summary to the user: one line per axis,
saying what is currently declared and what was detected. Re-running this skill
is safe. It re-asks every axis and uses the current answer as the starting
point, so nothing is lost by running it again.

## Step 2: The required axes – detection never decides them

The rule for this whole step: **auto-detection may pre-fill the recommendation
but never decides a required axis.** A detected fact belongs in an option's
description – "detected: this session is running in a herdr pane" – and never in
a silent write. The user answers; the detection only makes the answer easy.

### 2a. Orchestrator

Ask with a single AskUserQuestion call. There is no skip option: every machine
has an answer, and `none` is a real one.

```json
{
  "question": "Which agent orchestrator hosts terminal panes and git worktrees on this machine?",
  "header": "Orchestrator",
  "options": [
    {"label": "herdr", "description": "Owns terminal panes and creates worktrees under ~/.herdr/worktrees. <detected evidence, if any>"},
    {"label": "orca", "description": "Orca (stablyai/orca) owns panes and creates worktrees under ~/orca/workspaces. <detected evidence, if any>"},
    {"label": "none", "description": "No orchestrator – plain git worktrees under .claude/worktrees in the repository. <detected evidence, if any>"}
  ]
}
```

Fill each `<detected evidence, if any>` placeholder from the detection output,
putting the evidence into whichever option it supports:

- `orchestrator.hosting_this_session` is `herdr` – "detected: this session is
  running in a herdr pane" goes on the herdr option.
- `orchestrator.hosting_this_session` is `orca` – the same sentence, about Orca,
  goes on the Orca option.
- The binary is present but is not hosting this session – "detected: installed
  at `<path>`, but not hosting this session".
- The binary is absent – "not installed on this machine".

Leave a placeholder out entirely when there is nothing to say about that option.

### 2b. Browser-verification modes

There are three modes, and they are not alternatives to each other – a machine
can support any combination:

- **remote** drives a real browser on the developer's own machine, over the
  Playwriter bridge, which forwards that browser's debugging port to this
  machine on port 19988.
- **headless** launches headless Chromium on this machine, meaning a browser
  with no visible window.
- **local** launches a visible browser on this machine, which needs a graphical
  display.

Ask them as one multi-select question:

```json
{
  "question": "Which browser-verification modes work on this machine?",
  "header": "Browser",
  "multiSelect": true,
  "options": [
    {"label": "remote", "description": "Drive a real browser on your own machine over the Playwriter bridge. <detected: something answers on port 19988 | nothing is answering on port 19988>"},
    {"label": "headless", "description": "Launch headless Chromium here – no window, no display needed. <detected: Chromium found at <path> | no Chromium-family browser found>"},
    {"label": "local", "description": "Launch a visible browser here – needs a graphical display. <detected: browser and display both present | no graphical display>"},
    {"label": "none of these", "description": "No browser verification works on this machine at all. This is an answer, not a skip: it declares all three modes false."}
  ]
}
```

A selected mode is `true`. An unselected mode is `false`.

The fourth option exists because a multi-select gives the user no way to press
"nothing". Choosing "none of these" writes all three axes –
`host.browser.remote`, `host.browser.headless` and `host.browser.local` – as
`false`. That is a declaration, not a skip: the user has said this machine
cannot verify in a browser, and Step 4 writes it. If it comes back selected
alongside a real mode, that is a contradiction; take the named modes as the
answer and ignore it.

The no-frontend branch below adds a fifth option, "Decide later". If that comes
back selected alongside "none of these", those two are opposites: one writes all
three axes `false`, the other writes nothing at all. Take "Decide later" as the
answer and write nothing. An unset axis is recoverable – the next run of this
skill asks again, and the health check says plainly that it is missing – while a
`false` written by mistake reads as a decision the user made, so nothing asks
again and the machine quietly looks incapable.

When to treat the question as required: the browser axes are required as soon as
*any* project on this machine has a frontend. Nothing available here can see
that. The detection output's `project.has_frontend` looks only at the git
repository the current directory sits in, so it reports on that one project and
says nothing about the other checkouts on this machine.

So read it as a floor, not as the whole answer:

- `project.has_frontend` is true – ask with no escape. The modes have to be
  declared.
- It is false, or there is no SpecHub project in the current directory at all –
  still ask, because the next project opened on this machine may well have a
  frontend and this skill runs once per machine. Add a "Decide later" option and
  state the consequence plainly: the three `host.browser.*` axes stay unset, and
  the health check `~/.claude/spechub/bin/spechub config check` will fail the
  first time it is run in a project that has a frontend.

## Step 3: The optional axes – with skip

Ask these in one AskUserQuestion call. It carries two questions, or three when
the orchestrator chosen in Step 2 is `orca`. When it is not `orca`, omit the
third question entirely rather than asking it and discarding the answer.

1. **Preview publishing** (`host.preview.tailscale_serve`) – whether
   `tailscale serve` can publish this machine's dev server to the user's own
   private network, so it can be opened from another device. Options: yes, no,
   skip. Detection reports whether Tailscale is installed
   (`preview.tailscale_binary`) and, separately, whether anyone has logged it in
   (`preview.tailscale_logged_in`); put both facts in the option descriptions,
   because an installed-but-logged-out Tailscale publishes nothing.

2. **Element picker** (`host.element_picker`) – the tool that lets the user
   click an element in the running app and hand the reference to an agent.
   Options: `stagewise`, `orca-design-mode`, `none`, skip. Say plainly that this
   axis is recorded only: no skill changes its behaviour on it yet, so a wrong
   answer costs nothing today. Note that Orca's Design Mode needs the browser
   pane to render on the developer's own machine, so it is only a real option
   when Orca runs there.

3. **Orca topology** (`host.orca.topology`), asked only when the orchestrator is
   `orca` – how Orca runs. `local` means Orca runs as a desktop application on
   the developer's own machine. `remote` means a headless `orca serve` – Orca's
   server with no window of its own – running on another machine, viewed through
   a client application that has been paired with it. Options: local, remote,
   skip.

A skipped axis and an axis answered `none` or `false` are different things, and
the difference matters:

- **Skipped** means unset. Nothing is written. Note what that costs at the
  command line: `spechub config get` on an unset axis writes its message to
  standard error and exits 2 whether the axis is required or optional, and only
  the `(required)` or `(optional)` qualifier inside that message tells the two
  apart. The difference that actually matters belongs to `spechub config check`,
  the health check: it lists an unset optional axis as informational and fails
  only on an unset required one.
- **`none` and `false`** are real declarations – the user has said this machine
  does not have the thing.

Never write a value to represent a skip. If the user skips, write nothing for
that axis.

## Step 4: Write the answers

One `config set` call per answered axis:

```bash
~/.claude/spechub/bin/spechub config set host.orchestrator <herdr|orca|none>
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
  than bare – so a string axis comes back quoted, `Set host.orchestrator =
  "herdr"`, and a boolean comes back unquoted, `Set host.browser.local = true`.
  A non-zero exit means the value was rejected, and the message names the
  allowed values. Re-ask rather than guessing at a different spelling – enum
  values are matched case-sensitively, so it is `orca`, never `Orca`.
- `host.orca.topology` is the newest axis. If `config set` rejects it as an
  unknown key, the CLI in this plugin cache predates that axis. Say so, skip the
  axis, and carry on. Do not report it to the user as their mistake.
- Setting `host.orca.topology` while the orchestrator is not `orca` is accepted,
  and the CLI warns that nothing reads it, so do not write it in that case at
  all.

## Step 5: Follow-up for the chosen orchestrator

### When the answer is `orca`

**Register this repository.** Orca's `worktree create` fails with
`repo_not_found` unless the repository has been registered with Orca first, and
repositories are registered after Orca is installed rather than as part of
installing it. Register it now:

```bash
orca_bin="<orchestrator.orca_binary from the Step 1 detection output>"
"$orca_bin" repo add --path "$(git rev-parse --show-toplevel)" --json
```

Fill the placeholder in from the detection output's
`orchestrator.orca_binary` – an absolute path – rather than hardcoding a
name: the Linux executable is `orca-ide`, with `orca` as an alternative on some
installs, so a name written in by hand is right on only some machines. When that
field is `null` Orca is not installed here and there is nothing to register; see
"When Orca is not installed here" below instead.

The command is idempotent, so it is safe to run when the repository is already
registered. All Orca `--json` output is an envelope of the form
`{id, ok, result|error, _meta}` – read `.ok` rather than assuming the command
worked. Tell the user that Orca has no `repo rm` command, so registration only
goes one way.

Skip this step when the current directory is not inside a git repository, and
say why rather than failing silently.

**State the Claude settings rewrite**, whether or not the user asks about it.
Word it plainly:

> The first time Orca starts it rewrites `~/.claude/settings.json`, adding its
> agent hook to 11 hook events: SessionStart, UserPromptSubmit, Stop,
> StopFailure, SubagentStart, SubagentStop, TeammateIdle, PreToolUse,
> PostToolUse, PostToolUseFailure and PermissionRequest. The hook does nothing
> unless the `ORCA_PANE_KEY` environment variable is set, so it is inert outside
> an Orca terminal. Your original file is kept at
> `~/.claude/settings.json.bak`. Orca also writes `~/.orca/agent-hooks/` and
> `~/.config/orca/`.

Use the detection output to say whether this looks to have happened on this
machine already (`claude_settings.orca_hooks_present`) and whether the backup
exists (`claude_settings.backup_exists`). Word the first as evidence rather than
as a finding: it is a loose text search for the word "orca" anywhere in the
settings file, so something unrelated can set it.

Call out the combination worth a look: a settings file that mentions Orca with
no `~/.claude/settings.json.bak` beside it may mean the original settings were
never preserved. Tell the user to open the file and check before trusting it.
Do not tell them their settings were lost – the evidence does not carry that.

**When Orca is not installed here** – `orchestrator.orca_binary` is `null` –
say that Orca is missing, that installing it is not this skill's job yet, and
name what the provisioning step will do, so the user can do it by hand in the
meantime:

- the AppImage – a single-file Linux application bundle – placed under the
  user's home directory
- `orca-ide` and `orca` symlinks on `PATH`, so either name works
- a systemd user unit, meaning a background service owned by the user rather
  than by the system, that wraps the server in the `script` command so the
  readiness JSON the server prints reaches the system journal
- the environment variable `ORCA_TELEMETRY_DISABLED=1`
- a journal command that retrieves the pairing URL, which is the link a client
  uses to connect to this Orca server

No root access is needed for any of it. Do not install anything now.

### When the answer is `herdr`

There is nothing for this skill to provision today.

When the `herdr` binary is missing, say so, and name what the provisioning step
will cover: the managed block in `~/.config/herdr/config.toml`, the
`spechub.herdr-numbers` plugin, and the `spechub-*` helper binaries in
`~/.local/bin`.

### When the answer is `none`

There is nothing to provision. The worktree skills fall back to plain git
worktrees under `.claude/worktrees` in the repository.

## Step 6: Report

Close with a block in this shape – aligned labels, one line per axis, skipped
axes shown as `(unset – skipped)`:

```
## Host Declared

Orchestrator:  [herdr | orca | none]
Browser:       remote [true|false], headless [true|false], local [true|false]
Preview:       [true | false | (unset – skipped)]
Picker:        [stagewise | orca-design-mode | none | (unset – skipped)]
Orca topology: [local | remote | (unset – skipped) | not applicable]
Config:        [the path `spechub config path` printed]

Not automated yet: [what still has to be done by hand – installing a missing
orchestrator, logging in to Tailscale, connecting the Playwriter bridge – or
"nothing".]

Next: [run /spechub:init in a project, or `~/.claude/spechub/bin/spechub config
check` to health-check what was just declared against this machine and against
the project in the current directory.]
```

Get the `Config:` line by running the command, not by writing the usual path in:

```bash
~/.claude/spechub/bin/spechub config path
```

`~/.config/spechub/config.json` is only where the file lands by default. Setting
the `XDG_CONFIG_HOME` environment variable moves it, so on a machine where that
variable is set a hardcoded path in the report would point at a file that does
not exist.

## Notes

**Declared means installed.** A declared orchestrator is one that is installed
on this machine. It does not mean that orchestrator is hosting the current
session. At worktree time `/spechub:new-worktree` and
`/spechub:teardown-worktree` run the same detector, which reads the environment
markers an orchestrator sets in the terminals it opens to see which one is
actually hosting this session – `HERDR_ENV` or `HERDR_PANE_ID` for herdr,
`ORCA_PANE_KEY` for Orca. When none of them is set, those skills use plain git
worktrees and say so. An environment variable for an orchestrator that was never
declared is worth a warning, not a refusal.

**The host declares, the project prefers.** `host.browser.*` says what this
machine can do. `frontend.browser.mode` in `spechub/project.yaml` says what the
project would like.

Today the only thing that compares the two is the SpecHub command-line
interface's own health check, `~/.claude/spechub/bin/spechub config check`. It
passes when the host declares the project's preferred mode available; passes
with a note when it does not, naming the first mode the host does declare in the
order remote, headless, local as the one that would stand in; and fails when the
host declares none of the three. That is a report about the setup, not a choice
made on the verifier's behalf.

Nothing under `agents/` or `skills/browser-verify/` reads `host.browser.*` yet,
so the frontend verifier still takes `frontend.browser.mode` at its word.
Teaching it to resolve the project's preference against the host, in the order
the check already uses, is still to come.
