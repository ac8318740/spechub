---
name: terminal-workspace
description: "Install and configure the optional terminal workspace: herdr for panes that survive disconnect and worktree-backed workspaces, gh-dash for pull request triage, diffnav and delta for reading diffs. Use when the user asks to set up parallel agents in the terminal, mentions herdr, gh-dash, or diffnav, wants agents that keep running after they close the terminal, or asks to turn any of these on or off. Each component is independently toggleable and every change is reversible."
argument-hint: "[status | apply | disable <component> | uninstall]"
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

## What this skill does

Sets up an optional terminal workspace for running several coding agents at once. It is **machine-level, not per-project**: it installs binaries and writes keybindings for the user account, so it does not belong in `spechub/project.yaml`.

Nothing here is required to use SpecHub. Offer it, do not assume it.

| Component | Gives the user | Toggle |
|---|---|---|
| herdr | Panes that survive disconnect, per-agent state, worktree workspaces | `herdr.enabled` |
| delta | Syntax-highlighted diffs everywhere | `delta.enabled` |
| diffnav | Diff with a file tree, on one key | `diffnav.enabled` |
| gh-dash | Pull request triage without a browser | `gh_dash.enabled` |
| tuicr | Code review, which gh-dash hands pull requests to | `tuicr.enabled` |
| yazi | File manager, with markdown previewed live by spechub-md | `yazi.enabled` |
| spechub-md | Markdown with mermaid diagrams, as text or in a browser | `markdown.enabled` |
| spechub-clip, spechub-open | Copy and open, on a machine reached over SSH | `remote.enabled` |

Background and full key tables: [docs/terminal-workspace.md](../../docs/terminal-workspace.md).

## Files

- **Config**: `~/.config/spechub/terminal-workspace.yaml`, copied from `assets/terminal-workspace/config.example.yaml`
- **Script**: `assets/terminal-workspace/setup.sh` in this plugin

## Commands

Run the script from the plugin directory. Resolve it rather than guessing the path:

```bash
SETUP="$(dirname "$(find ~/.claude/plugins -path '*spechub*/assets/terminal-workspace/setup.sh' | head -1)")/setup.sh"
```

### `status` (default)

```bash
bash "$SETUP" status
```

Reports which binaries are installed, which components are enabled, and whether the managed block is present in the herdr config. Run this first, always.

### `apply`

```bash
bash "$SETUP" apply
```

Installs any missing binary for an enabled component, writes the helper scripts, applies the herdr keymap, sets delta as the git pager, and writes the gh-dash sections and keybindings. Idempotent: run it again after editing the config and it updates in place.

Before running it the first time:

1. Copy the example config to `~/.config/spechub/terminal-workspace.yaml`
2. Walk the user through the choices below
3. Then apply, and confirm with `status`

### `disable <component>`

```bash
bash "$SETUP" disable herdr     # or delta, diffnav, gh_dash
```

Removes what that component wrote. Then set `<component>.enabled: false` in the config so the next `apply` does not restore it. Binaries are left in place.

### `uninstall`

Removes every managed block and the helper scripts, and leaves the binaries.

## Choices worth walking the user through

- **`herdr.chord_modifier`**: `alt` (default), `ctrl+alt`, or `none`. herdr's own docs recommend `ctrl+alt` because it is free across terminals, but many terminals cannot encode it over SSH. Recommend `alt` for remote work. `none` keeps herdr's prefix-only keymap
- **`herdr.worktrees_directory`**: keep it absolute. A relative value resolves against the herdr session's base directory rather than the repository being branched, so worktrees for a second repository land inside the first
- **`herdr.integration`**: which agent reports its state to herdr. Set it to the agent the user actually runs, or `none`. Without it, herdr infers state by reading the screen
- **`gh_dash.repo_paths`**: map each repo to its local clone. Without it, checkout and any keybinding using `{{.RepoPath}}` fail
- **`markdown.preview_port`**: must match a port the user forwards from their
  laptop, or `spechub-md --serve` is unreachable. Say so rather than assuming
- **`tuicr.build_from_fork`**: leave `false` unless the user wants the two unmerged
  upstream pull requests (#607 stats, #633 resize). `true` needs cargo and takes a
  few minutes to build. Tell them it is temporary and that `status` tracks both PRs
- **`gh_dash.keybindings.agent_review`**: hands the selected pull request to an agent. Leave empty if the user does not want that key. Avoid `R`, which is gh-dash's built-in refresh-all
- **`remote.clipboard_shim`**: leave `true` on any machine reached over SSH. It puts an `xclip` on `$PATH` backed by `spechub-clip`, which is the only reason gh-dash's `y` and `Y` work there. It is skipped automatically when the machine has a real `xclip` or a display

## Copy and open, on a machine reached over SSH

A dev VM has no display and no clipboard. Three gh-dash keys land on that:
`o` fails with `exit status 1` because `xdg-open` has no display, and `y` and
`Y` fail with `Failed copying to clipboard` because gh-dash shells out to
`xclip`, `xsel` or `wl-copy` and none is installed.

`apply` fixes both. Setting a second machine up needs nothing extra:

```bash
bash "$SETUP" apply
bash "$SETUP" status     # read the last lines
```

`y` and `Y` keep gh-dash's own behaviour, backed by an `xclip` stand-in that
copies over OSC 52. `o` becomes a keybinding running `spechub-open`, because
gh-dash runs `$BROWSER` with its output discarded and the dashboard still
drawn, which leaves a route that needs to hand you a link nowhere to draw it.

The last lines of `status` say where a copy and an open will actually land on
**this** machine:

```
clipboard: xclip stand-in, copying to your terminal over OSC 52
browser: none - o hands you a ctrl+clickable link and copies it
last open: 2026-08-21T03:23:07+00:00 link: https://github.com/owner/repo/pull/30
```

Read them before debugging anything else. What each means:

| Line | What happened | What to do |
|---|---|---|
| `clipboard: xclip stand-in` | Copy reaches your terminal over OSC 52 | Nothing |
| `clipboard: this machine has a display` | It has a real clipboard | Nothing |
| `clipboard: none` | `apply` has not run, or `remote.clipboard_shim` is false | Run `apply` |
| `browser: Chrome on your laptop` | The bridge is up and proven attached | Nothing |
| `browser: none - o hands you a link` | The normal case over SSH. ctrl+click it | Nothing |
| `browser: none, and no terminal either` | `o` copies and reports failure | Below |

`browser: none` is not a fault. Nothing on that machine can open a page, so
`o` hands the terminal a link instead, which is the one route that works over
any number of SSH hops. To make it a real one-key open, give it a command
that can:

```bash
export SPECHUB_OPEN_CMD="ssh laptop open"   # any command taking a URL
```

Do not suggest installing a browser or an X server on the VM to fix this. The
browser belongs on the machine the user is sitting at.

Under `herdr --remote`, panes run on the remote host, so `spechub-open` looks
for a browser there and normally finds none. That is fine and needs no
configuration: herdr carries clipboard writes and hyperlinks across the link,
so the copy and the clickable link both arrive at the terminal you attached
from. Do not add per-host browser configuration to make it "work" - it already
does.

### When o claims it opened something nobody saw

`agent-browser` launches a headless Chrome on the local machine when it cannot
attach to the CDP endpoint it was given. That Chrome navigates, reports
success, and shows nobody anything. A bridge relay answering on its HTTP port
does not rule this out: ours answered `/json/version` while refusing every CDP
connection with `Multiple extensions connected. Specify extensionId.`

Diagnose it by asking what is really on the other end, never by trusting a
successful open:

```bash
agent-browser get cdp-url          # the endpoint actually attached to
curl -s 127.0.0.1:9555/json/list   # a headless Chrome on the VM holds the tabs
```

`spechub-open` runs that check itself before taking the bridge route. If you
find a stray headless Chrome holding pages, say so - it is a leftover, and
killing it is the user's call, not yours.

Detail, and why OSC 52 rather than a clipboard daemon:
[docs/terminal-workspace.md](../../docs/terminal-workspace.md).

## Free the client's keys

The keymap is bound on **this** machine, but the chords are intercepted by the
terminal emulator on the machine the user types on. Windows Terminal binds
`alt+shift+d` to "duplicate pane" by default, so it splits the local tab *and*
opens a tab here. Other emulators claim other chords.

After `apply`, work out which case you are in.

**Running on the user's own desktop** (macOS, or Linux with a desktop session):
the terminal emulator is right here. Read
[assets/terminal-workspace/client-keybindings.md](../../assets/terminal-workspace/client-keybindings.md)
and do it yourself: find the emulator's config, back it up, unbind only the
chords that are actually bound, show the diff, and verify.

**Running on a remote or headless host** (no `DISPLAY`, or an `SSH_CONNECTION`
in the environment): you cannot reach the emulator from here. Ask first:

> Do you SSH into this machine from a Windows, macOS, or Linux desktop? If so
> I can give you a prompt to hand to an agent there, which frees the keys their
> terminal is swallowing.

Only if they say yes, print the contents of `client-keybindings.md` verbatim
for them to paste. Do not summarise it and do not rewrite it for their
emulator: it already covers the common ones, and the agent on that machine can
see which is actually installed.

If they say no, or the terminal is on this machine, say nothing further about
it. A user on a plain Linux console has nothing to fix.

**Never** try to edit a client-side terminal config from a remote host, and
never ask the user to paste their local config here so you can rewrite it.

## Safety

- Every edit sits between `# >>> spechub terminal-workspace >>>` markers. Hand-written config around them survives, and re-applying replaces only the managed region
- The gh-dash config is merged, not overwritten: existing sections, themes, and keybindings the user added are preserved
- Never edit the user's herdr or gh-dash config outside the managed markers
- After applying, `herdr config check` must print `config: ok`. If it does not, report the error and stop rather than reloading

## Verify

```bash
bash "$SETUP" status          # components installed and enabled
herdr config check            # config: ok
```

Then tell the user to open a herdr session and press `prefix+?` for the keymap, `?` inside gh-dash, and that diffnav lists its keys in its footer.
