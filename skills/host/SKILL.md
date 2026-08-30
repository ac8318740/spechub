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

The same repository gets opened on several machines, and those machines differ.
A laptop with a screen can launch a visible browser; a headless build server
cannot. One machine has herdr installed, another has Orca, another has neither.

None of that is a property of the project, so none of it belongs in the
project's config file.

The answers therefore go to the global config of the SpecHub command-line
interface. That is a JSON file at `~/.config/spechub/config.json`, or under
`$XDG_CONFIG_HOME` when you set that environment variable. Run
`~/.claude/spechub/bin/spechub config path` to print the real location.

They do not go in `spechub/project.yaml`.

Project concerns stay in `project.yaml`. In particular
`frontend.browser.mode` stays there as the *project's preference*, while
`host.browser.*` says what this *machine* can actually do. The two are
different questions, and they live in different files.

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

## Step 1: Detect what is already here

Run the detection script that ships beside this file:

```bash
plugin_root=$(dirname "$(dirname "$(dirname "$(readlink -f ~/.claude/spechub/bin/spechub)")")")
bash "$plugin_root/skills/host/detect-host.sh"
```

The path resolution looks odd, so here is why. The plugin's own files live in a
versioned cache directory. Its path changes on every release, so nobody can
hardcode it.

The one invariant path is `~/.claude/spechub/bin/spechub`, a symlink to the CLI
inside the current cache. The SessionStart hook re-points that symlink at the
start of every session, and Claude Code runs that hook.

The command above therefore derives the plugin root from the symlink rather than
from a written-down path.

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
| `orca_topology.serve_unit_active` | A user-level service named exactly `orca` is running, which is the shape of a machine serving Orca to a viewer elsewhere. The name is an assumption: whatever provisions the server picks it, and nothing pins it yet. A unit installed under any other name reads here as "no server". The topology recommendation below then comes out `local` when this machine has Orca, and stays empty when it does not |
| `claude_settings.orca_hooks_present` | `~/.claude/settings.json` mentions Orca somewhere. The match is a loose, case-insensitive search for that word anywhere in the file, so an unrelated path or permission entry containing it counts too – this is evidence that Orca has wired its hooks in, not proof |
| `claude_settings.backup_exists` | `~/.claude/settings.json.bak` exists |
| `project.root`, `project.has_frontend` | The git repository the current directory sits in, and whether its `spechub/project.yaml` configures a frontend |

Several sections also carry a `recommended` field. That is the script's
mechanical reading of the evidence above it and nothing more. It is a starting
point for a question, never an answer.

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

```json
{
  "question": "Is herdr installed on this machine?",
  "header": "herdr",
  "options": [
    {"label": "yes", "description": "herdr is installed here. It owns terminal panes and creates worktrees under ~/.herdr/worktrees. <detected evidence, if any>"},
    {"label": "no", "description": "herdr is not installed here. <detected evidence, if any>"}
  ]
}
```

```json
{
  "question": "Is Orca installed on this machine?",
  "header": "Orca",
  "options": [
    {"label": "yes", "description": "Orca (stablyai/orca) is installed here. It owns panes and creates worktrees under ~/orca/workspaces. <detected evidence, if any>"},
    {"label": "no", "description": "Orca is not installed here. <detected evidence, if any>"}
  ]
}
```

Fill each `<detected evidence, if any>` placeholder from the Step 1 detection
output. Put the evidence into whichever option it supports, so the recommended
answer is the one carrying it. Judge each orchestrator on its own fields only –
herdr from `orchestrator.herdr_binary`, Orca from `orchestrator.orca_binary`,
and both from `orchestrator.hosting_this_session`, which names at most one of
them:

- `orchestrator.hosting_this_session` names this orchestrator – recommend yes:
  "detected: this session is running in a herdr pane", or the same sentence
  about Orca.

- Its binary is present – recommend yes: "detected: installed at `<path>`".
  When the session is also running in its pane, say both facts.

- Neither is true for it – recommend no: "not installed on this machine".

Leave a placeholder out entirely when there is nothing to say about that option.

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
cannot verify in a browser, and Step 4 writes it.

If it comes back selected alongside a real mode, that is a contradiction; take
the named modes as the answer and ignore it.

The no-frontend branch below adds a fifth option, "Decide later". If that comes
back selected alongside "none of these", those two are opposites: one writes all
three axes `false`, the other writes nothing at all. Take "Decide later" as the
answer and write nothing.

An unset axis is recoverable. The next run of this skill asks again, and the
health check says plainly that the axis is missing.

A `false` written by mistake is not recoverable in the same way. It reads as a
decision the user made, so nothing asks again and the machine quietly looks
incapable.

When to treat the question as required: the browser axes become required as soon
as *any* project on this machine has a frontend. Nothing available here can see
that.

The detection output's `project.has_frontend` looks only at the git repository
the current directory sits in. So it reports on that one project, and says
nothing about the other checkouts on this machine.

So read it as a floor, not as the whole answer:

- `project.has_frontend` is true – ask with no escape. The modes have to be
  declared.

- It is false, or there is no SpecHub project in the current directory at all –
    still ask. The next project opened on this machine may well have a frontend,
    and this skill runs once per machine.

    Add a "Decide later" option, and state the consequence plainly. The three
    `host.browser.*` axes stay unset. The health check
    `~/.claude/spechub/bin/spechub config check` then fails the first time
    anyone runs it in a project that has a frontend.

## Step 3: The optional axes – with skip

Ask these in one AskUserQuestion call. It carries a third question only when you
answered yes to Orca in Step 2. Otherwise omit that question rather than asking
it and discarding the answer.

1. **Preview publishing** (`host.preview.tailscale_serve`) – whether
    `tailscale serve` can publish this machine's dev server to the user's own
    private network. Another device can then open it. Options: yes, no, skip.

    Detection reports whether this machine has Tailscale
    (`preview.tailscale_binary`). It reports separately whether anyone has
    logged it in (`preview.tailscale_logged_in`). Put both facts in the option
    descriptions, because an installed-but-logged-out Tailscale publishes
    nothing.

2. **Element picker** (`host.element_picker`) – the tool that lets the user
    click an element in the running app. The user then hands that reference to
    an agent. Options: `stagewise`, `orca-design-mode`, `none`, skip.

    Say plainly that the config only records this axis. No skill changes its
    behaviour on it yet, so a wrong answer costs nothing today.

   Note that Orca's Design Mode needs the browser pane to render on the
   developer's own machine. So it is only a real option when Orca runs there.

3. **Orca topology** (`host.orca.topology`) – how Orca runs. Ask it only when
    the user answered yes to Orca in Step 2 above. Gate it on that answer, not
    on a config read, because nothing has written `host.orchestrators.orca` yet.

    Local runs Orca as a desktop application on the developer's own machine.
    Remote runs `orca serve` – Orca's headless server – on another machine, and
    the user views it through a paired client application. Options: local,
    remote, skip.

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

- **A rejected value.** The message names the allowed values for a key the tool
  knows. Re-ask rather than guessing at a different spelling – enum values are
  matched case-sensitively, so it is `stagewise`, never `Stagewise`.

- **An unknown key.** The message reads `Unknown config key "<key>"` and lists
  the host keys the tool does know. That is version skew: the command line tool
  in this plugin cache is older than these skills. `host.orchestrators.herdr`,
  `host.orchestrators.orca` and `host.orca.topology` are the newest axes, so
  they are the ones an old cached tool rejects.

- **Recovering from version skew.** Do not re-ask – the answer is not the
    problem, and re-asking a boolean axis only loops. Tell the user to restart
    Claude Code, so the SessionStart hook re-points
    `~/.claude/spechub/bin/spechub` at the current cache.

    Skip the axis and carry on. Do not report it to the user as their mistake.

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

**Register this repository.** Orca's `worktree create` fails with
`repo_not_found` until you register the repository with Orca. Registration is a
separate step, and it comes after the install rather than inside it. Register it
now:

```bash
orca_bin="<orchestrator.orca_binary from the Step 1 detection output>"
"$orca_bin" repo add --path "$(git rev-parse --show-toplevel)" --json
```

Fill the placeholder in from the detection output's
`orchestrator.orca_binary`, an absolute path. Do not hardcode a name. The Linux
executable is `orca-ide`, with `orca` as an alternative on some installs, so a
hand-written name is right on only some machines.

A `null` in that field means
this machine has no Orca, so nothing needs registering. See "When Orca is not
installed here" below instead.

The command is idempotent, so it is safe to run when the repository is already
registered. All Orca `--json` output is an envelope of the form
`{id, ok, result|error, _meta}` – read `.ok` rather than assuming the command
worked. Tell the user that Orca has no `repo rm` command, so registration only
goes one way.

Skip this step when the current directory is not inside a git repository, and
say why rather than failing silently.

**State the Claude settings rewrite**, whether or not the user asks about it.
Word it plainly:

> The first time Orca starts, it rewrites `~/.claude/settings.json`. It adds its
> agent hook to 11 hook events: SessionStart, UserPromptSubmit, Stop,
> StopFailure, SubagentStart, SubagentStop, TeammateIdle, PreToolUse,
> PostToolUse, PostToolUseFailure and PermissionRequest. The hook does nothing
> unless the `ORCA_PANE_KEY` environment variable holds a value, so it is inert
> outside an Orca terminal. Orca keeps your original file at
> `~/.claude/settings.json.bak`. Orca also writes `~/.orca/agent-hooks/` and
> `~/.config/orca/`.

Use the detection output to say whether this looks to have happened on this
machine already (`claude_settings.orca_hooks_present`) and whether the backup
exists (`claude_settings.backup_exists`). Word the first as evidence rather than
as a finding. The check is a loose text search for the word "orca" anywhere in
the settings file, so something unrelated can set it.

Call out the combination worth a look: a settings file that mentions Orca with
no `~/.claude/settings.json.bak` beside it may mean the original settings were
never preserved. Tell the user to open the file and check before trusting it.
Do not tell them they lost their settings – the evidence does not carry that.

**When Orca is not installed here** – `orchestrator.orca_binary` is `null` –
say that Orca is missing, and offer to install it.

The installer is `install-orca.sh`, beside this file. Resolve its path the way
Step 1 resolves `detect-host.sh`, through `plugin_root`.

Ask two things before you plan anything, in one AskUserQuestion call:

1. The port the server listens on. Default it to 6768.
2. The address a client pairs to. Pre-fill it from `tailscale ip -4` when Step 1
   found Tailscale installed and logged in.

Say where a pre-filled address came from, so the user can recognise it. Leave
the pairing address out when Tailscale is missing or logged out.

Then plan the install. Build one option list here and use it twice:

```bash
bash "$plugin_root/skills/host/install-orca.sh" --plan \
  --port <port> --pairing-address <address> --mobile-pairing
```

`--mobile-pairing` gets a mobile-scoped pairing offer, which is what a phone
needs. Run the plan and the apply with the same options.

The script builds the unit text from the options. Three steps read their status
from that text.

A flag added after the plan therefore changes what runs. The plan is what the
user approved.

`--plan` writes nothing. It prints one numbered line per step, and each line
ends in `[todo]` or `[skip: <reason>]`. Show that list to the user verbatim,
every line of it.

Then state the Claude settings rewrite, before the user approves anything.
Orca's first start rewrites `~/.claude/settings.json` and keeps the original at
`~/.claude/settings.json.bak`. Use the wording in the "State the Claude settings
rewrite" block above, rather than a second version of it.

Now put the whole step list in front of the user with AskUserQuestion, and let
them decline. Declining is a real answer. Nothing runs, and this skill carries
on to the report in Step 6.

On approval, run the identical command with `--apply` in place of `--plan`:

```bash
bash "$plugin_root/skills/host/install-orca.sh" --apply \
  --port <port> --pairing-address <address> --mobile-pairing
```

An apply line ends in `[done]` or `[skipped: <reason>]`. Every step is
idempotent, so a second run repeats nothing it already did.

What the install puts on the machine:

- the AppImage – a single-file Linux application bundle – under
  `~/.local/opt/orca/`

- `orca-ide` and `orca` symlinks in `~/.local/bin`, so either name works
- a systemd user unit at `~/.config/systemd/user/orca.service`, meaning a
  background service owned by the user rather than by the system

- `ORCA_TELEMETRY_DISABLED=1`, set in that unit

The unit wraps the server in `/usr/bin/script -qec "..." /dev/null`. That is how
the readiness JSON the server prints reaches the system journal. The install
needs no root access for any of it.

Two options cover a machine that cannot reach the default download.
`--appimage-url URL` replaces that URL, which is
`https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage`.
`--appimage-path PATH` takes a local file instead.

The last step of the apply reads the journal itself and prints the pairing URL.
The pairing URL is the link a client uses to connect to this Orca server. Give
it to the user.

That step skips in three cases.

It skips when the apply neither started nor restarted the server, because an
untouched server keeps the pairing URL it already had. It skips when the journal
holds no readiness line yet, which happens when the server has started and has
not printed its block. It skips when `journalctl` is missing, and prints this
command instead.

Run it yourself whenever a skip leaves the pairing URL unknown:

```bash
journalctl --user -u orca.service -n 100 --no-pager
```

`--mobile-pairing` stays in the unit. The script never removes it, so the server
offers mobile pairing on every restart. Removing it is the user's own step, and
it means editing the unit and restarting it:

```bash
${EDITOR:-nano} ~/.config/systemd/user/orca.service
systemctl --user restart orca
```

### When you declared herdr installed

**Write the managed block.** herdr keeps its config at
`~/.config/herdr/config.toml`. SpecHub needs one setting in that file: the
directory herdr creates worktrees under. Offer to write it.

The installer is `install-herdr-block.sh`, beside this file, and Step 1 above
resolves the same `plugin_root`.

Plan it first:

```bash
bash "$plugin_root/skills/host/install-herdr-block.sh" --plan
```

Two options change the defaults. `--config PATH` points at a config file
elsewhere, and `--worktree-dir PATH` changes the directory. The defaults are
`~/.config/herdr/config.toml` and `~/.herdr/worktrees`.

Show the printed step list verbatim, then ask with AskUserQuestion. Declining is
a real answer, and nothing runs. On approval, run the same command with
`--apply`.

This is the block it writes, and it writes nothing else:

```
# >>> spechub terminal-workspace >>>
[worktrees]
directory = "~/.herdr/worktrees"
# <<< spechub terminal-workspace <<<
```

It creates the file when the file is absent. It appends the block when the block
is absent. It replaces the block in place when the block is there and differs.

It refuses and changes nothing whenever the config file is not in a state it can
safely edit. Editing one of these would corrupt the file, or throw away
somebody's config:

- a path that exists and is not a regular file
- a file that already holds more than one block with those markers
- a start marker count and an end marker count that differ
- a start marker that the file never closes
- a `[worktrees]` table defined outside any managed block
- a block between the markers that defines a table besides `[worktrees]`

It exits 4 and says which case it hit. Tell the user to fix the config by hand,
then run the plan again.

**What this skill ships, and what is personal taste.** This skill ships the
managed block and nothing else. The block tells herdr to put worktrees under
`~/.herdr/worktrees`. The worktree skills read that path, so it is the one
setting they depend on.

The rest of a herdr setup is personal taste. This skill installs none of it: the
keymap, the popup key bindings, the `spechub.herdr-numbers` plugin, and the
`spechub-*` helper binaries in `~/.local/bin`.

Copy your own if you want them. Nothing in SpecHub needs any of them.

**The terminal-workspace skill writes the same block, wider.**
`assets/terminal-workspace/setup.sh apply` fences `[keys]`, one
`[[keys.command]]` per binding, and `[worktrees]` between these same two
markers. It takes the directory from `herdr.worktrees_directory` in
`~/.config/spechub/terminal-workspace.yaml`. A machine that has run it needs
nothing from this installer.

The installer therefore leaves that block alone. It reports the step as skipped
when the directory already agrees. It refuses with exit 4 when it does not.

Change the directory in `terminal-workspace.yaml` and run `setup.sh apply`
again, never this script.

### When you declared neither installed

There is nothing to provision. The worktree skills fall back to plain git
worktrees under `.claude/worktrees` in the repository.

## Step 6: Report

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

## Notes

**Declared means installed.** Each of the two declarations says that this
machine has that orchestrator installed. They are independent, so both can be
true at once. Neither says that the orchestrator is hosting the current
session.

At worktree time, `/spechub:new-worktree` and `/spechub:teardown-worktree` run
the same detector. It reads the environment markers an orchestrator sets in the
terminals it opens, and those markers name the orchestrator hosting this
session. The markers are `HERDR_ENV` or `HERDR_PANE_ID` for herdr, and
`ORCA_PANE_KEY` for Orca.

When no marker holds a value, those skills use plain
git worktrees and say so. An environment variable for an orchestrator that was
never declared is worth a warning, not a refusal.

**The host declares, the project prefers.** `host.browser.*` says what this
machine can do. `frontend.browser.mode` in `spechub/project.yaml` says what the
project would like.

Today the only thing that compares the two is the SpecHub command-line
interface's own health check, `~/.claude/spechub/bin/spechub config check`.

It passes when the host declares the project's preferred mode available. It
passes with a note when the host does not. The note names the first mode the
host does declare, in the order remote, headless, local, as the one that would
stand in.

It fails when the host declares none of the three. That is a report about the
setup, not a choice made on the verifier's behalf.

Nothing under `agents/` or `skills/browser-verify/` reads `host.browser.*` yet,
so the frontend verifier still takes `frontend.browser.mode` at its word.
Teaching it to resolve the project's preference against the host, in the order
the check already uses, is still to come.
