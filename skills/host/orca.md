# Orca follow-up

Read this file when the user declared Orca installed in Step 2.

- `plugin_root` and the detection output come from Step 1 in `SKILL.md`
- Step 5 in `SKILL.md` lists the exit codes both installers share

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
Step 1 in `SKILL.md` resolves `detect-host.sh`, through `plugin_root`.

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
on to the report in Step 6 of `SKILL.md`.

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
