# Terminal workspace: herdr, gh-dash, diffnav

Your code lives on a machine you reach over the network, and you drive coding agents on it. A terminal session dies with its connection, and the tools worth reviewing code in assume a desktop: a clipboard, a browser, a display. A dev machine has none of them. So how do you run several agents there, keep them alive, and review their work without leaving the terminal?

Run a herdr server on the dev machine and attach to it from a thin client on your own machine with `herdr --remote`. The server keeps panes alive across disconnects. The local client is what lets your own clipboard and browser reach the session at all, which is the part an SSH shell cannot do.

Run `/spechub:terminal-workspace` to install and configure all of it from a single toggleable config. The rest of this document explains what that sets up and why. Read it if you would rather configure it by hand or change the defaults.

```mermaid
flowchart TD
    subgraph yours["Your machine, where you type"]
        EM["Terminal emulator"]
        CL["herdr client"]
        OUT["Clipboard and browser"]
    end
    subgraph dev["Dev machine, where the code is"]
        SRV["herdr server and its panes"]
        RD["Reading code and markdown"]
        PR["Diffs and pull requests"]
    end
    EM -->|"keys you press"| CL
    CL -->|"SSH"| SRV
    SRV --> RD
    SRV --> PR
    RD -->|"OSC 8, OSC 52"| OUT
    PR -->|"OSC 8, OSC 52"| OUT
```

| Part of the diagram | Section |
| --- | --- |
| herdr client | 2. How you attach |
| herdr server and its panes | 4. The herdr server |
| Terminal emulator | 5. Freeing your emulator's keys |
| Reading code and markdown | 6. Reading code, markdown and diagrams |
| Diffs and pull requests | 7. Diffs and pull requests |
| Clipboard and browser | 8. What crosses back to your machine |

Sections 1 and 3 cover what you get and how to install it. Section 9 is the loop you run daily. Section 10 lists the things that cost real time to find.

## 1. What you get, and its parts

*Three tools cover it: herdr owns the terminals, gh-dash triages pull requests, diffnav reads diffs. Use this when you work on a remote machine, drive more than one agent at a time, and want a keyboard-only workflow.*

Skip it if you work locally in a graphical editor: a desktop tool will serve you better.

- **Agents that survive disconnect.** herdr runs a background server. Closing the terminal, dropping the network, or attaching from another machine never stops an agent mid-task
- **One screen that shows who needs you.** herdr marks every pane working, blocked, idle, or done, so you stop hunting for the stuck one
- **Review without a browser.** Pull request triage, diffs with a file tree, and comments, all from the terminal

| Tool | Role | Why this one |
|---|---|---|
| [herdr](https://herdr.dev) | Terminal workspace manager | Background server, per-pane agent state, git worktree workspaces |
| [gh-dash](https://github.com/dlvhdr/gh-dash) | Pull request dashboard | Saved searches per section, custom actions, `gh` underneath |
| [diffnav](https://github.com/dlvhdr/diffnav) | Diff reader | File tree beside the diff, the blast-radius view a plain pager lacks |
| [delta](https://github.com/dandavison/delta) | Pager | Syntax highlighting for every diff, and gh-dash uses it internally |
| [tuicr](https://github.com/agavra/tuicr) | Code review | Vim keys, and PR review in the same tool gh-dash hands work to |
| [yazi](https://github.com/sxyazi/yazi) | File manager | Live preview per file type, so markdown renders as the cursor moves |
| [mermaid-ascii](https://github.com/AlexanderGrooff/mermaid-ascii) | Diagram renderer | Draws mermaid flowcharts as box-drawing text |
| [glow](https://github.com/charmbracelet/glow) | Markdown pager | Readable markdown in the terminal |

## 2. How you attach

*herdr is a background server plus a terminal client. Where you put the client decides what the setup can do, so choose before you configure anything else.*

The server owns the panes and keeps them running whatever happens to your connection. The client draws them. Those are two separate machines in this setup, and which one runs the client is the single decision the rest of this document depends on.

### 2.1. From your own machine, with `herdr --remote`

*The recommended path. The client runs beside your clipboard and browser, so both can reach the session.*

Install herdr on the machine you type on as well as on the dev machine, then attach:

```bash
herdr --remote dev-box --remote-keybindings server
```

The client connects over SSH, starts or attaches the server on the dev machine, and streams the session back. Panes and agents still run on the dev machine. Only the drawing happens locally.

Four things are worth setting up once.

**An SSH host block**, so the target is a name rather than an address. Anything you put in it carries through, port forwards included, because herdr builds its own SSH config by including yours first:

```text
Host dev-box
  HostName 203.0.113.10
  User you
  LocalForward 6419 localhost:6419
```

**Key authentication through an agent.** herdr's connection reuse is Unix-only, so a Windows client authenticates more than once while it sets the session up. With no key loaded that is a password prompt each time. Load it once per boot with `ssh-add`.

**`--remote-keybindings server`.** By default chords resolve from the *client's* config, so herdr ignores the keymap on the dev machine and every chord looks broken. This flag keeps the server config as the single source of truth. Section 2.3 covers why that matters more than it sounds.

**A shortcut, because you will type this many times a day.** On Windows use a PowerShell function rather than an alias or a symlink. Both of those map one name to another. The target then arrives as an argument to herdr itself, and herdr rejects it.

```powershell
function herdr-dev {
  & "$env:LOCALAPPDATA\Programs\Herdr\bin\herdr.exe" `
    --remote dev-box --remote-keybindings server @args
}
```

A hyphenated name tab-completes, where the second word of a two-word command never will. On macOS or Linux the same thing is a shell function in your profile. Add `--handoff` if you like. It asks a running server to pass its live panes to a replacement rather than restarting them. That matters the next time you upgrade herdr and your client meets an older server. It does nothing on an ordinary attach, so it is safe to leave in the shortcut.

### 2.2. By SSH first

*The fallback. Simpler, works from a phone, and gives up the local clipboard bridge.*

```bash
ssh you@dev-box
herdr
```

Everything runs on the dev machine now, the client included. This is the tmux-shaped path: detach with `prefix+q`, disconnect, SSH back, run `herdr` again. Use it from a phone SSH app, where there is no local herdr to run. Keep it as the fallback for when a remote attach misbehaves. Both paths attach to the same server, so you can move between them freely.

### 2.3. What differs, and why it decides your keymap

*Each attach path can carry a different set of chords, so bind the family that survives both.*

| | `herdr --remote` | `ssh`, then `herdr` |
| --- | --- | --- |
| Where the client runs | your machine | the dev machine |
| Clipboard image paste into an agent | yes | no |
| Which config supplies chords | the client's, unless `--remote-keybindings server` | the server's |
| `alt+<key>` | works | works |
| `ctrl+alt+<key>` | dead | works |
| `ctrl+<digit>` | works | dead |
| Works from a phone SSH app | no | yes |
| Windows as the dev machine | not supported | not applicable |

We measured the three key rows on herdr 0.8.2 with a Windows client rather than inferring them. They are the reason this document binds plain `alt` throughout.

The two paths deliver keys by different routes. Over SSH the emulator encodes a chord as an escape sequence, and herdr decodes it on the far side. Under `herdr --remote` the local client reads native key events instead, and the two routes do not carry the same set. The `ctrl+alt` family survives the escape-sequence route and dies on the native one, and `ctrl+<digit>` does the opposite. Either way herdr accepts the binding and then never sees the key. A chord that does not cross is therefore silently dead, and herdr reports no error.

`alt+<key>` is the only family that crossed both. If you only ever attach one way, test the wider family and use it. If you use both, or expect to, bind `alt` and do not spend the time.

This affects only herdr's own chords. Both gh-dash and diffnav read their own configs on the dev machine, where they run, so their keys behave the same however you attached.

## 3. Install

*None of these need root. All land in `~/.local/bin`, which must be on your `PATH`.*

None of these need root. All land in `~/.local/bin`, which must be on your `PATH`.

```bash
# herdr
curl -fsSL https://herdr.dev/install.sh | sh

# delta and diffnav: download the Linux x86_64 release tarballs, extract the
# binary into ~/.local/bin, and chmod +x. Both are single static binaries.

# gh-dash, as a gh extension
gh extension install dlvhdr/gh-dash
```

Then let herdr report agent state precisely rather than by reading the screen:

```bash
herdr integration install claude    # also: codex, opencode, copilot, and others
```

Check what is available with `herdr integration status`. The hook applies to sessions that start after you install it.

Then let herdr report agent state precisely rather than by reading the screen:

```bash
herdr integration install claude    # also: codex, opencode, copilot, and others
```

Check what is available with `herdr integration status`. The hook applies to sessions that start after you install it.

## 4. The herdr server

*One config file, one keymap, and a numbering quirk that bites once you use worktrees.*

### 4.1. Configure

`~/.config/herdr/config.toml`. Validate with `herdr config check`, apply without restarting with `herdr server reload-config`, and undo with `herdr config reset-keys`.

```toml
[keys]
# Jump straight to an agent by its sidebar row.
focus_agent = "alt+1..9"

# Panes: same vim letters as the prefix bindings.
focus_pane_left  = ["prefix+h", "alt+h"]
focus_pane_down  = ["prefix+j", "alt+j"]
focus_pane_up    = ["prefix+k", "alt+k"]
focus_pane_right = ["prefix+l", "alt+l"]

# Agents, tabs, workspaces.
next_agent = "alt+n"
previous_agent = "alt+u"
next_tab = ["prefix+n", "alt+right"]
previous_tab = ["prefix+p", "alt+left"]
next_workspace = ["alt+.", "alt+down"]
previous_workspace = ["alt+,", "alt+up"]

# By number. herdr leaves switch_workspace unbound and puts switch_tab on
# prefix+1..9, so without these there is no way to reach a workspace by number.
switch_workspace = "prefix+1..9"
switch_tab = "prefix+alt+1..9"

# Overlays and movement.
toggle_sidebar = ["prefix+b", "alt+s"]
goto = ["prefix+g", "alt+g"]
zoom = ["prefix+z", "alt+z"]
last_pane = "alt+a"

# Creating things. Closing stays on the prefix so a mistyped chord cannot
# kill a pane with an agent running in it.
new_tab = ["prefix+c", "alt+c"]
new_workspace = ["prefix+shift+n", "alt+w"]
new_worktree = ["prefix+shift+g", "alt+r"]
split_vertical = ["prefix+v", "alt+e"]
split_horizontal = ["prefix+minus", "alt+minus"]

# Review popups. Both float over the layout and return you where you were.
[[keys.command]]
key = "alt+d"
type = "popup"
command = "spechub-diff"
description = "diff (diffnav)"
width = "90%"
height = "90%"

[[keys.command]]
key = "alt+i"
type = "popup"
command = "spechub-dash"
description = "PR dashboard"
width = "95%"
height = "95%"

[worktrees]
directory = "~/.herdr/worktrees"
```

Two choices worth explaining.

**Plain `alt` chords, not `ctrl+alt`.** herdr's docs recommend `ctrl+alt` because it is free across most terminals. Do not follow that advice here unless you attach exactly one way and have tested it.

Measured on herdr 0.8.2, the two attach paths disagree. The `ctrl+alt` family reaches herdr when you SSH in and run it on the remote host. A Windows client attaching with `herdr --remote` never delivers it. Instead herdr accepts the binding and then never sees the key, so the chord is silently dead and nothing reports an error. The `alt+<key>` family works on both, so `alt` is the only safe family if you use both paths. That is the reverse of what herdr's own keyboard page suggests, so test your own path before committing to a family.

**Absolute `worktrees.directory`.** A relative value resolves against the herdr session's base directory, not the repository you point at. Worktrees for a second repository then land inside the first. Use an absolute path unless you only ever work in one repository.

### 4.2. Keys

Each tool has its own help: `prefix+?` in herdr (press `/` to filter), `?` in gh-dash, and diffnav's footer.

Prefix is `ctrl+b`. Chords without it are direct and need no prefix.

| Key | Action |
|---|---|
| `alt+1`..`alt+9` | Focus agent by row |
| `prefix+1`..`prefix+9` | Switch workspace by row |
| `prefix+alt+1`..`prefix+alt+9` | Switch tab by position |
| `alt+n` / `alt+u` | Next / previous agent |
| `alt+left` / `alt+right` | Previous / next tab |
| `alt+up` / `alt+down` | Previous / next workspace |
| `alt+h` `alt+j` `alt+k` `alt+l` | Move between panes |
| `alt+a` | Back to the last pane |
| `alt+s` | Toggle sidebar |
| `alt+g` | Goto picker |
| `alt+z` | Zoom pane |
| `alt+c` | New tab |
| `alt+w` | New workspace |
| `alt+r` | New worktree workspace |
| `alt+e` / `alt+minus` | Split right / down |
| `alt+d` | Diff popup |
| `alt+i` | Dashboard popup |
| `prefix+q` | Detach, leaving everything running |
| `prefix+x` / `prefix+shift+x` / `prefix+shift+d` | Close pane / tab / workspace |
| `prefix+[` | Copy mode |
| `prefix+w` | Navigate mode, a persistent movement surface |

Three separate lists answer to `1..9`, and they are not the same list. `alt+N`
walks agents, `prefix+N` walks workspaces, `prefix+alt+N` walks the tabs of the
workspace you are in. An agent row and a workspace row that share a number are
a coincidence.

The `ctrl` and `shift` modifiers are not options for a fourth list, and which
one fails depends on how you attached. A `shift+<digit>` chord arrives as
punctuation on both paths. A `ctrl+<digit>` chord reaches herdr under
`herdr --remote` but not over SSH, so a binding you make on one path is silently
dead on the other. Section 2.3 has the table. These three are what both paths
carry.

### 4.3. When the sidebar numbers stop matching

Collapse the sidebar with `alt+s` and each workspace shows a number. That number
is its position in herdr's stored list. The `prefix+N` chord uses something else,
the row's position in the grouped sidebar, where worktrees sit indented under
their parent repo.

They agree until you touch a worktree. A new one appends to the end of the
stored list but appears mid-sidebar under its parent. Everything below it
shifts, so the number you read stops being the number you press.

```bash
spechub-herdr-renumber
```

The `spechub-herdr-` prefix is the convention for a helper that only works under
herdr. Plain `spechub-` helpers such as `spechub-diff` and `spechub-md` run in
any terminal, so the name tells you up front what a command depends on. Both
forms are reachable through the CLI, which dispatches an unknown subcommand to
`spechub-<name>` on your PATH.

That rewrites the stored order to match the grouped order, so both agree again.
Run it after creating or tearing down a worktree. It prints the result and is
safe to run repeatedly.

Two things it cannot fix. Only rows 1 to 9 are reachable, so a tenth workspace
needs `alt+g` or `alt+up`/`alt+down`. And `prefix+N` stays positional: it is a
row, not a name, so it still moves when the rows move.

## 5. Freeing your emulator's keys

*You bind the keymap on the dev machine, but the emulator on the machine you type at intercepts the chords. Fix that where the emulator runs.*

Windows Terminal binds `alt+shift+d` to "duplicate pane" by default, so pressing it splits your local tab *and* opens a tab on the dev machine. Other emulators claim other chords. This is true on both attach paths. A local herdr client does not rescue you from it, because the emulator sees the key first either way.

[assets/terminal-workspace/client-keybindings.md](../assets/terminal-workspace/client-keybindings.md)
lists every chord this workspace uses and how to unbind them in the common
emulators. Follow it yourself, or hand it to an agent running on that machine.

Never try to edit a client-side emulator config from the dev machine. Never paste your local config onto the dev machine so that something there can rewrite it.

## 6. Reading code, markdown and diagrams

*A file tree with live preview, and markdown that draws its mermaid diagrams as text.*

### 6.1. The file tree

| Key | What |
|---|---|
| `alt+y` | yazi in a popup. Floats, leaves the tab layout alone |
| `alt+shift+y` | yazi in a new tab |

Every popup works this way: `alt+d` / `alt+shift+d` for diffnav, `alt+i` /
`alt+shift+i` for gh-dash. A popup is right for a glance; a tab is right for
something you will come back to. Both come from the same command, and the tab
variant goes through `spechub-herdr-tab`. That helper creates the tab in the
workspace and directory you pressed the key in. Then it sends the command with
`herdr pane run`.
Outside herdr it simply runs the command.

This workspace leaves `alt+t` alone on purpose, because it is Claude Code's thinking toggle.

One collision to know about. herdr hosts a `type = "shell"` command in a real
pane for as long as the process runs. So `spechub-herdr-tab` creates the tab and
then hands the wait to a detached child. It returns in about 100ms rather than
three and a half seconds. Without that a stray pane sits in the current tab.

The other collision is your terminal emulator claiming the same chords, and you
fix that where the emulator runs. See section 5.

yazi previews each file type with its own command, and it routes markdown to
`spechub-md`. A document therefore renders **as the cursor moves over it** rather
than needing a keypress. The `Enter` key opens the same renderer full width,
where more of a wide diagram fits than the preview pane allows. The `~` and `F1`
keys both open yazi's help.

Icons come from a Nerd Font. Without one they render as tofu; install any Nerd
Font and select it in your terminal.

tuicr was the file tree before yazi. yazi took that job, and tuicr kept the
one it is better at: reading diffs and reviewing pull requests. gh-dash hands
it work on the `D` key, which runs `tuicr pr <number>` in the local clone. The
command `tuicr --file .` still browses a tree if you want it.

### 6.2. The fork build is temporary

Two upstream pull requests are still open:

- [agavra/tuicr#607](https://github.com/agavra/tuicr/pull/607) by
  [antonio2368](https://github.com/antonio2368) - configurable per-file
  `+added -removed` counts in the tree, and the `show_file_line_stats` key
- [agavra/tuicr#633](https://github.com/agavra/tuicr/pull/633) - move the file
  list boundary with `<leader>L` / `<leader>H`, and the `file_list_width` key

The fork also carries a third change with no upstream PR yet: a fix for blank
`+N -N` counts in PR review mode (`tuicr pr <N>`). tuicr's PR mode has no local
version-control backend of its own, so it borrowed the `File` version-control system (VCS) type - the
one `--file <path>` uses - as a stand-in. The fork's whole-file gate hides
counts for `--file` and `--all-files`, since every line there counts as added,
and that gate matched PR sessions too, so the counts stayed blank in PR review
even with `show_file_line_stats` on. The fix gives PR sessions their own
`PullRequest` VCS type so the gate no longer matches them.

The default, `build_from_fork: false`, installs the stock release and skips both
config keys, so tuicr does not warn about unknown keys. Setting
`build_from_fork: true` clones the fork, builds `local/daily` with cargo, and
writes the two keys plus `no_update_check = true`, so `tuicr update` cannot
replace the build.

`setup.sh status` reports the state of both pull requests. After both pull
requests merge, check whether the PR-mode counts fix above has been submitted
upstream too before you set `build_from_fork: false` - stock tuicr 0.23.0 has
no counts feature at all, so it never had this bug or the fix. Switching to
the stock build before that fix lands upstream brings the blank counts back
in PR review. Re-run `apply` once you do switch, and check the merged key
names first - review can rename them.

### 6.3. Reading markdown and mermaid

These helpers are their own executables rather than subcommands of the
`spechub` CLI. That matters because the `spechub-md --preview` command runs on
every cursor move in the file manager, and Node's startup would roughly double
it. The CLI dispatches to them anyway, the way git does: `spechub md` runs
`spechub-md`, so either form works and configs can keep the fast one.

```bash
spechub-md NOTES.md              # terminal, diagrams drawn as text
spechub-md --numbered NOTES.md   # the source instead, with its line numbers
spechub-md --diagram 2 NOTES.md  # one diagram alone, scrollable sideways
spechub-md --serve NOTES.md      # browser, prints a clickable link
spechub-md --browser NOTES.md    # the browser you are sitting at, wherever that is
spechub-md --html NOTES.md       # that same page, as one document on stdout
```

`--numbered` answers the one question a rendering cannot: which line of the
file this is. A review comment names a line number, and a rendered heading has
none, so `--numbered` prints the source with a right-aligned gutter instead.
The gutter is as wide as the largest number in it, so the source stays on one
column however long the file. It pages through `less -S`, which chops rather
than wraps: the arrow keys pan across a long line, and the gutter keeps its
column. `b` opens the browser from there too, on the rendered page, and `#`
switches back to it.

While you are reading, `b` opens the page in the browser you are sitting at and
returns you to where you came from. It works by the routes in 6.5, so it is the
same key whether you attached over `herdr --remote`, over SSH, or locally.

`#` works while you are reading too, and means the same thing it means in the
file tree: it switches the document you are in between the rendered view and
its source with line numbers, and switches it back. That is the moment you
usually want a line number, so you do not have to quit back to the tree to ask
for one. `SPECHUB_MD_LINE_NUMBERS_KEY` moves it.

`b` is back-a-page in `less`. `Ctrl-B` and `PageUp` both still do that, so the
binding costs nothing; `SPECHUB_MD_BROWSER_KEY` moves it if you would rather
have `b` back. The mechanism behind both keys is a `lesskey` binding whose
`quit` action carries an exit status, which `spechub-md` reads and acts on. The
`less` pager has no action that runs a fixed command. Its one shell escape would
hand over the rendered temporary copy rather than the file you asked for. It
needs `less` 582 or newer; older versions ignore the bindings and leave both
keys alone.

The `#` binding is written `\#` in the `lesskey` file. `lesskey` reads a line
starting with `#` as a comment, so written bare the binding is dropped without a
word. The key then does nothing but ring the terminal bell. Only a leading `#`
needs the escape. A backslash means something of its own to `lesskey`, and `\b`
would bind backspace rather than the letter.

A diagram's width comes from its node labels, so nothing can shrink a wide one
into a narrow pane, and wrapping box-drawing art destroys it. So `spechub-md`
replaces anything wider than the terminal with a note. The note gives
its size and the two ways to see it, rather than a badly drawn diagram. The
`--diagram N` flag prints that one diagram unwrapped through `less -S`, where the
arrow keys scroll sideways.

`SPECHUB_MD_PAD` tunes the spacing passed to `mermaid-ascii` (default
`-x 2 -y 2`). Tighter padding buys roughly a third of the height back and very
little width.

Wide diagrams still appear in place. glow wraps whatever it renders, so
`spechub-md` holds the drawing back. It runs glow on the prose, then splices the
full-width art into the output. The pager is `less -S`. Because glow already
wrapped the prose to the pane, only the diagram lines chop, and the arrow keys
pan across them.

### 6.4. Reading markdown from the file tree

The file tree is yazi, and it draws markdown twice over. Moving the cursor onto
a `.md` file renders it straight into the preview pane, through the piper plugin
running `spechub-md --preview`. The pane is narrow, so a wide diagram shows a
placeholder there rather than a chopped drawing.

`Enter` on the same file opens `spechub-md` full width, where the diagrams fit.
An opener rule puts that ahead of the editor, so reading is the default. `O`
opens the same menu to choose from instead: **Read (spechub-md)**, **Read with
line numbers**, then **Edit**. Nothing shims `$EDITOR`, and nothing changes your
shell environment.

The opener templates say `%s` rather than `"$@"`. yazi runs a template as
`sh -c '<template>'` with nothing after it, so `$0` is `sh` and `$@` is empty. A
template written with `"$@"` hands the helper no file at all. `%s` is the
placeholder yazi substitutes, already quoted. Measured on yazi 26.8.15.

`b` on a file hands it to the browser you are sitting at, by the routes in 6.5.
The key is free in yazi's file list. Its only default binding is a word motion
while you are typing into a prompt, which this does not touch. Move it with
`yazi.browser_key`.

`#` switches the preview pane between the rendered markdown and the source with
line numbers, and switches it back. Press it when you are about to quote a line
in a review. The pane redraws as `spechub-md --numbered` would print it, numbers
down the left, and every later `.md` file you move onto previews the same way
until you press `#` again. The key is unbound in yazi's file list. Move it with
`yazi.line_numbers_key`.

The same key does the same job one level in, while you are reading a document
full width after `Enter`. That is the more common moment to want it, and the two
are deliberately the same key, so there is nothing to remember about which of
the two places you are standing in. Section 6.3 describes the reader's half. It
is a `lesskey` binding rather than this one, and `yazi.line_numbers_key` does
not move it.

The choice lives in a file, `$XDG_STATE_HOME/spechub/md-line-numbers`
(`~/.local/state/spechub/md-line-numbers` when that is unset), because the key
and the preview are two processes that never meet. Its presence is the whole
setting. `spechub-md --toggle-line-numbers` creates and removes it, and that is
what the key runs. Only the pane reads it. Every other route was asked for a
rendered document by name, and the full-width read has **Read with line
numbers** as its own entry under `O`. The `--diagram N` flag outranks it too,
since asking for one drawing is a different question from which view the pane
is on.

If you already write your own `yazi.toml`, setup reads it first and leaves alone
anything you have set: your `mgr` settings, your markdown opener, your
`plugin.prepend_previewers`, your `open.prepend_rules`. Whichever
of the four it skipped, it says so. Declaring any of them a second time would
make yazi reject the whole config and fall back to presets, so it concedes them
instead. What it cannot read is a `yazi.toml` that does not parse. In that
case yazi is already ignoring the file in favour of presets, so fix the error and
re-run setup. Add `spechub-md` to your own opener to read markdown with it, and
`show_hidden = true` to your own `mgr` if you want hidden files shown.

The `b` and `#` bindings live in `keymap.toml`, not `yazi.toml`, and setup
writes them as `[[mgr.prepend_keymap]]`. That spelling is an array of tables, so
it stacks with bindings you have already written the same way. The one spelling
it cannot sit beside is the inline `prepend_keymap = [...]` under `[mgr]`. That
is a single key, and TOML forbids declaring it twice. Setup detects that form
and gives the bindings up rather than cost you the whole keymap, and says so.

`#` runs two actions, not one: it flips the flag, then forces yazi to draw the
pane again. Without the redraw the pane keeps showing whatever it drew before
the key was pressed, and the switch looks broken until you move the cursor. The
flip blocks, though it has nothing to say, because a detached one races the
redraw and loses about half the time.

So: `alt+y` for the tree, cursor onto a markdown file to preview it, `#` to see
its source with line numbers, `Enter` to read it full width with its diagrams
drawn, `q` back to the tree.

Terminal mode replaces each mermaid fence with a box-drawing rendering.
`mermaid-ascii` handles `graph`, `flowchart`, and `sequenceDiagram`; anything
else keeps its source visible with a note rather than disappearing.

Two things it normalises first, because `mermaid-ascii` handles neither:

- `style`, `classDef`, `class`, `linkStyle` and `click` lines, which it would
  otherwise draw as if each were a node
- node shapes other than `[square]` - `{decision}`, `((circle))`, `([stadium])`,
  `[(database)]`, `{{hexagon}}` - whose syntax would otherwise leak into the label

Serve mode renders the file with python-markdown and draws diagrams with a
**locally vendored** mermaid.js, so the page fetches nothing from a CDN. It
binds `127.0.0.1` only, re-reads the file on every request, and prints an
OSC 8 hyperlink. Then herdr rebuilds OSC 8 into the frame it sends the client.
So ctrl+click opens the page in the browser on your own machine, as long as your
SSH config forwards `preview_port` from there. The bare URL prints underneath for
terminals without OSC 8.

Only one server can hold `preview_port` at a time. A second `--serve` names the
process holding it and the command to stop it:

```
port 6419 is busy: [Errno 98] Address already in use
  held by pid 680666: spechub-md-serve - /path/to/NOTES.md 6419 serve
  stop it with:  kill 680666
```

Use that pid rather than `pkill -f spechub-md-serve`, which also matches any
shell whose own command line mentions the name, including the one you type it in.

### 6.5. Getting the page to the browser you are sitting at

`--browser` is the one to reach for. It works out where your browser actually
is and picks a delivery that reaches it, so the same key works however you
attached. It asks `spechub-open --why` rather than deciding that a second time.

| Where the browser is | What `--browser` does |
| --- | --- |
| Behind the opener on your laptop | Posts the whole document to it; the opener stores it, serves it, and opens your default browser |
| A desktop on this machine, or WSL | Serves it and opens it |
| The far end of the Playwriter bridge, with no opener | Hands the whole document down the CDP link, into the tab the extension is armed on |
| Anywhere else, over SSH | Serves it and prints a clickable link |

The opener is the route you want, and section 8.6 covers what it is and how it
gets installed. What matters here is what it changes: nothing to arm, and no
extension. The browser it reaches is your default one rather than a
dedicated Chrome profile. Read one document after another and each simply
appears. Re-render a file you are already looking at, and the tab you have open
updates in place, scroll position kept. No second tab joins the first.

The page itself decides that last part, rather than the opener remembering it.
Every page the opener serves polls it for its own version, so a tab that is
still open says so by asking. Re-render that file and the opener sees a live
tab and lets it reload itself. Close the tab and the asking stops, so the next
render opens a fresh one. Remembering that it once opened something would get
the closed-tab case wrong every time.

The bridge case is the fallback, and it is the one that needs explaining. Under `herdr --remote` the
tunnel to your laptop runs the *other way*. Nothing on the laptop can open a
port on the dev machine. A link to `localhost:6419` names the laptop's own
localhost, where nothing is listening. So there is no link to hand over - only
a document. That is what `--html` is for.

`--html` prints the page `--serve` would have served, once, to stdout, and
starts nothing. A document you can capture in a variable travels; a port does
not. The `--browser` flag is `--html` plus the delivery, and the two share one
renderer, so the page cannot differ between them.

They differ in exactly one place. `--serve` answers for `/mermaid.js` off the
vendored copy, so its page fetches nothing from a CDN. A document standing on
its own has no server behind it, so `--html` names the CDN instead. The
vendored file is 3.5MB, and inlining it would make the page offline-proof and
far too big to hand anywhere. A document bound for the opener is the third
case. Here `--browser` hands it over once, like `--html`. But the document does
end up behind a server, the opener's, so it asks for `/mermaid.js` too.

The 3.5MB goes up once, the first time the opener admits it has no copy. Every
document after that draws its diagrams without reaching a CDN at all. Measured:
this document, 39KB of markdown, renders to 50KB of HTML in under 200ms. It
reaches a laptop browser, diagram drawn, in about two seconds.

On the bridge the page replaces what is in the armed tab, and the helper opens
no new tab. That is deliberate, and it is the second thing we measured rather
than assumed. CDP creates a tab in the **background**, and nothing on the dev
machine can bring it to the front. The document lands in it, the helper reports
success, and you never see it. Arming the extension is how you nominate the tab
this may take over, so that is the tab it takes over.

Success is likewise not an exit status. The pushed script ends with the page
title, so the browser answers with what it is now holding. The `--browser` flag
only reports success when that answer is the file you asked for. A command that
exited 0 is not a page that arrived.

When the bridge is the route and the push fails, `--browser` says so and stops
rather than falling back to serving. A link the laptop resolves to its own
localhost is a wrong answer dressed as a working one.

### 6.6. Why text and not inline images

herdr embeds libghostty and emits the **kitty graphics protocol**. It contains
no sixel at all. Windows Terminal renders sixel and has never supported kitty
([microsoft/terminal#8389](https://github.com/microsoft/terminal/issues/8389) is
still open), and no Google Play terminal supports either protocol. The
intersection is empty, so an inline image never arrives no matter which terminal
you pick. Text also suits e-ink, where the fast refresh modes an interactive
terminal needs are the ones that discard the greyscale depth an image needs.

`chafa` is worth adding by hand (`apt install chafa`) if you want images drawn
as text. It ships source-only, so the setup script does not install it.

## 7. Diffs and pull requests

*Diffs with a file tree, pull request triage with saved searches, and the two helpers that make one key always show something useful.*

### 7.1. Git and delta

```bash
git config --global core.pager delta
git config --global interactive.diffFilter "delta --color-only"
git config --global delta.navigate true
git config --global delta.line-numbers true
git config --global merge.conflictstyle zdiff3
```

Agents see no difference. git only pages to a terminal, so a command whose caller pipes or captures the output still gets plain text.

### 7.2. gh-dash

`~/.config/gh-dash/config.yml`.

```yaml
prSections:
  - title: Mine
    filters: is:open author:@me
  - title: Needs review
    filters: is:open review-requested:@me
  - title: Failing
    filters: is:open author:@me status:failure

issuesSections:
  - title: Mine
    filters: is:open author:@me
  - title: Assigned
    filters: is:open assignee:@me

# Local clones. Required for checkout and for {{.RepoPath}} in keybindings.
repoPaths:
  <you>/<repo>: ~/code/<repo>

keybindings:
  prs:
    - key: D
      name: review (tuicr)
      command: >
        cd {{.RepoPath}} && tuicr pr {{.PrNumber}}
    - key: S
      name: agent review
      command: >
        cd {{.RepoPath}} && claude "/code-review {{.PrNumber}}"
```

Any GitHub search string works as a section filter, so anything you can type into GitHub's search box becomes a tab. Avoid binding `R`: it is the built-in refresh-all.

### 7.3. The diff and dashboard helpers

`spechub-diff` picks the most relevant diff, so one key always shows something useful. It also resolves the case where a pane sits in herdr's `<root>/<repo>/` grouping directory rather than in a checkout, which happens often:

```bash
#!/usr/bin/env bash
set -uo pipefail
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repo: $PWD"; read -rsn1; exit 0
fi
if ! git diff --quiet; then
  git diff | diffnav
elif ! git diff --cached --quiet; then
  git diff --cached | diffnav
else
  git show HEAD | diffnav
fi
```

`spechub-dash` adds a section for whichever repository you are standing in, then hands a generated config to gh-dash:

```bash
#!/usr/bin/env bash
set -uo pipefail
BASE="$HOME/.config/gh-dash/config.yml"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
[ -z "$REPO" ] && exec gh dash "$@"
GEN="$(mktemp)"; trap 'rm -f "$GEN"' EXIT
REPO="$REPO" python3 - "$BASE" "$GEN" <<'PY'
import os, sys, yaml
cfg = yaml.safe_load(open(sys.argv[1])) or {}
repo = os.environ["REPO"]; short = repo.split("/")[-1]
s = [x for x in cfg.get("prSections", []) if x.get("title") != short]
s.insert(0, {"title": short, "filters": f"repo:{repo} is:open"})
cfg["prSections"] = s
yaml.safe_dump(cfg, open(sys.argv[2], "w"), sort_keys=False)
PY
gh dash --config "$GEN" "$@"
```

Because herdr popups inherit the focused pane's directory, `alt+i` from an agent's worktree opens the dashboard already scoped to that repository.

### 7.4. spechub-gh: why an action failed

gh-dash shells out to `gh` for everything it does to a pull request, and throws the command's stderr away. GitHub refusing one therefore arrives as `exit status 1` in the footer, for two seconds. Approving your own pull request is the case you meet daily, because GitHub always refuses that. The input box closes, nothing else happens, and the dashboard looks like it ignored the key.

`spechub-dash` answers that without patching gh-dash. It links `spechub-gh` into a directory of its own at the front of `$PATH` under the name `gh`, so gh-dash finds it before the real one. The real `gh` still does the work and still decides the exit code. The only thing added is a notification carrying gh's own words when a `pr` or `issue` action fails:

```
gh pr review failed
Can not approve your own pull request.
```

`spechub-gh` passes `gh dash` itself straight through, and every subcommand that is not an action, `repo view` and `api` among them. Those fail for reasons a notification cannot help with.

### 7.5. gh-dash keys

| Key | Action |
|---|---|
| `j` / `k` | Move between rows |
| `h` / `l` | Previous / next section |
| `p` | Toggle the preview pane |
| `[` / `]` | Previous / next preview tab: Overview, Activity, Commits, Checks, Files Changed |
| `PageDown` / `PageUp` | Scroll the preview |
| `ctrl+d` / `ctrl+u` | Scroll the preview, vim style |
| `e` | Expand the description |
| `d` | Built-in diff |
| `D` | Open the pull request in tuicr and review it there |
| `S` | Hand the pull request to an agent |
| `C` or `space` | Check the branch out locally |
| `w` | Watch checks |
| `c` / `v` / `m` | Comment / approve / merge |
| `y` / `Y` | Copy number / URL |
| `r` / `R` | Refresh section / all |
| `/` · `?` · `q` | Search · help · quit |

### 7.6. diffnav keys

| Key | Action |
|---|---|
| `j` / `k` | Move in the file tree |
| `n` / `N` | Next / previous file |
| `ctrl+d` / `ctrl+u` | Scroll the diff half a page |
| `ctrl+e` / `ctrl+y` | Scroll the diff one line |
| `Tab` | Switch focus between tree and diff |
| `t` | Search and jump to a file |
| `e` | Toggle the file tree |
| `s` | Side-by-side or unified |
| `o` | Open the file in `$EDITOR` |
| `q` | Quit |

## 8. What crosses back to your machine

*A dev machine has no display and no clipboard of its own, so two helpers carry each one back across the link.*

A dev VM has no display and no clipboard of its own. Two gh-dash keys land on that fact:

- `o`, open on GitHub, fails with `exit status 1`. gh-dash opens URLs through `$BROWSER`, falling back to `xdg-open`, and `xdg-open` with no `$DISPLAY` exits 1
- `y` and `Y`, copy the URL and the number, fail with `Failed copying to clipboard`. The gh-dash tool copies through a Go library that shells out to `xclip`, `xsel`, `wl-copy` or `termux-clipboard-set`. A bare VM has none of them installed, and an install would not make them work

Neither is a gh-dash bug. The clipboard and the browser are on the machine you are typing at, several hops away. Two helpers carry each one back across.

### 8.1. spechub-clip: the clipboard

OSC 52 is the escape sequence that asks a terminal to put text on its own clipboard. It is bytes in the terminal stream, so it crosses SSH for free. herdr forwards it from a pane to whatever terminal hosts it. Windows Terminal, iTerm2, kitty and Ghostty all act on it.

```bash
spechub-clip "some text"      # copy the arguments
git rev-parse HEAD | spechub-clip
spechub-clip --out            # print what was copied last
```

Reading back is not symmetrical. Windows Terminal refuses OSC 52 clipboard *reads* on purpose, because a program that can read your clipboard without asking is a security hole. So `--out` replays a local cache, not the real clipboard.

To reach programs that only know how to shell out, `apply` also writes an `xclip` onto `$PATH` backed by `spechub-clip`. That is what makes gh-dash's `y` and `Y` work unchanged, with no rebinding and no flicker. Setup skips it on any machine that has a real `xclip` or a display for one to talk to, and `setup.sh uninstall` removes it.

### 8.2. spechub-open: the browser

`o` is a gh-dash keybinding rather than a `$BROWSER` setting, and that is deliberate. The dashboard is still on screen when gh-dash runs `$BROWSER`, and it discards that command's output. A route that needs to say anything, or to hand you a link to click, therefore has nowhere to put it. As a keybinding gh-dash steps aside and gives `spechub-open` the terminal.

It tries, in order:

1. `$SPECHUB_OPEN_CMD`, if you set one. The escape hatch
2. `xdg-open`, when this machine has a display after all
3. `wslview` or `explorer.exe`, when the Windows half of the machine holds the browser
4. The opener on your laptop, which puts the page in your default browser with nothing to click. See 8.6
5. Chrome on your laptop through the [Playwriter bridge](../skills/bridge/SKILL.md), but only after it proves the browser is really reachable that way. See below
6. A link you can click: the URL as an OSC 8 hyperlink. The terminal you are sitting at draws it, so ctrl+click reaches your own browser with nothing installed in between. The link text is the URL. A terminal that ignores OSC 8 still shows something its own URL detection can catch. The URL goes on your clipboard either way
7. With no terminal to draw on either, the URL still goes on the clipboard, but the command reports failure. Silent success is what left gh-dash claiming it had opened a page that never opened

The opener sits ahead of the bridge because the two are not competing for the same job. The bridge exists so an *agent* can drive a browser. It attaches one tab at a time, only after somebody clicks the extension icon, and it does so in a dedicated Chrome profile. The opener exists so it can show a *person* a page, needs no click at all, and reaches the browser you actually use. Both can be up at once, and each keeps its own job.

`setup.sh status` prints which route a machine will take, and the last line of `~/.cache/spechub/open.log` says what the last press actually did.

### 8.3. Why the bridge has to prove itself

`agent-browser` launches a headless Chrome on the local machine when it cannot attach to the endpoint you gave it. That Chrome navigates perfectly happily, reports success, and shows nobody anything. The page opens on the VM, several hops from the screen you are looking at.

Nothing about the relay answering on port 19988 rules that out either. Ours answered `/json/version` while refusing every CDP connection with `Multiple extensions connected. Specify extensionId.`, so every open landed in a headless Chrome for hours without one error message.

So the bridge route asks the relay's `/json/list` what is on the far end, and takes the route only when something answers. The Playwriter extension attaches per tab, and `/json/list` is its own answer to that question. An empty `[]` means nobody has armed it on a tab, so there is no browser to drive however healthy the tunnel underneath looks.

This used to gate on an `agent-browser` socket existing first, on the reasoning that probing starts a browser as a side effect. It does not - `curl` starts nothing. What that gate did do was make a perfectly healthy bridge unreachable. Nothing creates that socket until an `agent-browser` session is already running, so every press fell through to the link route. Asking the relay is both safer and correct.

The opener proves itself the same way and for the same reason. The `spechub-open` helper asks it for `/health`, carrying the shared token, and takes the route only if the opener answers. A token sitting on disk proves nothing about a service being up. A service being up proves nothing without the token it is going to demand.

### 8.4. Under `herdr --remote`

*We wrote both helpers for this shape; they need no change. The clipboard crosses; the browser falls to the link route, which is the one built for it.*

`herdr --remote <target>` runs the server, and therefore every pane process, on
the dev machine. The client is a thin attach: it sends input and draws what the
server sends back.

`spechub-clip` works, and we measured that rather than inferring it. A pane's
OSC 52 write reaches the clipboard on the machine you attached from, so
`spechub-clip "some text"` on the dev machine pastes on your own. Nothing in
herdr's own documentation promises this: it mentions OSC 7 and OSC 8, never
OSC 52. We tested it on herdr 0.8.2 and it crossed.

Clipboard *images* travel the other way, and only on this path. Copy a
screenshot on your machine, focus an agent pane, and herdr stages the image on
the dev machine and pastes its path. An SSH shell cannot do that at all, which
is the single strongest reason to prefer a remote attach.

`spechub-open` runs on the dev machine, which is the honest answer for routes 1
to 5. An override, a display, WSL, the opener or a bridge tunnel all have to be
reachable *from there*. The opener and the bridge are reachable, because the
laptop opens reverse tunnels that carry them back. So on a machine set up for
either, that is the route it takes. With neither, it falls to the link route,
which is the one built for this.

In that route herdr tracks hyperlinks per cell and re-emits them when it renders.
The client therefore draws the link rather than shipping raw bytes, and
ctrl+click opens the browser on the machine you attached from.

The link route also degrades further than the others. Even with no OSC 8 and no OSC 52
at all, the URL is on screen as plain text, which drag-select copies. That is
why the link is its own text rather than a label over it.

One trap belongs to your SSH config rather than to herdr. The
`spechub-md --serve` command prints the URL it is listening on, and that is the
port *on the dev machine*. If your host block forwards it to a different local
port, the printed link is wrong from where you are sitting. You want the local
number instead. Forwarding `6419` to `6419` avoids the question entirely.

### 8.5. On a machine with none of this

The link route needs only a terminal, so it is the one that always works: over SSH, through herdr, and under `herdr --remote`. If you want a real one-key open instead, give `spechub-open` something that can do it:

```bash
export SPECHUB_OPEN_CMD="ssh laptop open"   # or any command taking a URL
```

### 8.6. The opener: a page in your own browser, with nothing to click

*A small service on your laptop. It takes a page from the dev machine, stores it, serves it back, and opens your default browser on it.*

The dev machine has no browser and no way to reach yours. The bridge solved that for agents, but not for reading. It needs a tab armed by hand before every session. The tab it drives lives in a dedicated Chrome profile rather than your default browser. The opener is the answer for reading, and it is a separate service on purpose - see [ADR 0006](adr/0006-document-opener-service.md).

What it does is deliberately small:

| The dev machine sends | The opener does |
| --- | --- |
| A URL | Hands it to your default browser |
| A rendered document | Stores it, serves it at `http://127.0.0.1:19989/doc/<id>`, opens that |
| A vendored `mermaid.min.js`, once | Keeps it, and answers `/mermaid.js` off it from then on |
| A request to restart the relay or the tunnel | Restarts that scheduled task |

It rides the same machinery as the bridge: a scheduled task from `register-tasks.ps1`, and a supervisor that restarts it. The `sync.ps1` script reconciles the deployment on every Claude Code launch, and your laptop opens a reverse SSH tunnel. It gets its **own** tunnel task rather than a second forward on the bridge's connection. That is because ssh runs with `ExitOnForwardFailure=yes`, so one wedged port fails the whole connection. Sharing one connection would let a stuck opener port take the bridge down with it.

Installing it is the same command that registers the bridge, which now registers the opener too:

```powershell
cd $env:USERPROFILE\playwriter-bridge
.\register-tasks.ps1 -VMs @("vm1.example.com")
```

That generates a shared secret, stores it at `%LOCALAPPDATA%\playwriter-bridge\opener.token`, and copies it to each VM at `~/.config/spechub/opener.token` over the same ssh the tunnel uses. Every request from the dev machine carries it. Loopback binding alone would not be enough. The reverse tunnel makes the port reachable by anything running on the VM, and this is a service that puts pages on your screen.

Restarting the relay and restarting the tunnel are the two recovery actions the dev machine could never perform. They now go through the opener instead of arriving as a block for you to paste into PowerShell. Arming the extension is still yours. It is a click inside a third-party extension, and nothing on either machine can press it.

Documents outlive the session that rendered them, which is what lets a page still work after the dev machine has gone away. The opener prunes them after a week.

## 9. The daily loop

*Dispatch, monitor, review, ship, tear down. One key each.*

1. **Dispatch.** `alt+r` creates a worktree workspace, or ask an agent for one and the `new-worktree` skill registers it with herdr for you
2. **Monitor.** `alt+s` shows the sidebar. Blocked needs an answer, done finished and you have not looked, working means leave it alone
3. **Review locally.** `alt+d` shows what the agent changed. Run the `pre-commit-review` skill in the agent's own pane for a deeper pass
4. **Ship.** The agent commits, pushes, and opens the pull request from its worktree
5. **Review the pull request.** `alt+i`, then `p` and `]` to reach Files Changed, `D` to review it in tuicr, `S` to hand it to an agent
6. **Tear down.** `herdr worktree remove --workspace <id>`, then delete the branch

## 10. Traps

*Each of these cost real time to find.*

Each of these cost real time to find.

- **`ctrl+b` is both herdr's prefix and Claude Code's "background this task".** Press it twice inside a Claude pane to reach Claude, or rebind herdr's prefix
- **Never submit a prompt to a blocked agent.** A blocked agent waits on a permission prompt. Injected text answers that prompt instead of giving an instruction. Wait for idle
- **`--cwd` for `herdr worktree create` must be the main checkout**, never a nested worktree. herdr stores it as the workspace's repository root. It also groups worktree workspaces under it in the sidebar
- **Read the created path from the command output.** Never assume where a worktree landed, because the configured root decides
- **Worktree workspaces nest, plain workspaces do not.** A workspace made with `alt+w` always sits at the top level, whatever directory it points at
- **Sidebar actions act on the selected workspace**, not the focused pane. Open the sidebar and select before creating a worktree or closing a workspace
- **In-process teammates are invisible to herdr.** A Claude teammate shares its parent's pane and session, so it never appears as its own agent. Two agents in one worktree means two real sessions
- **gh-dash never says why an action failed.** It discards gh's stderr, so a refusal shows as `exit status 1` for two seconds. `spechub-gh`, which `spechub-dash` puts on `$PATH` as `gh`, turns that into a notification quoting gh. Approving your own pull request is the one you will hit
- **A remote machine has no clipboard and no browser.** The `o`, `y` and `Y` keys in gh-dash all fail on a bare VM until `apply` installs `spechub-clip` and `spechub-open`. The `setup.sh status` command says which one a machine ended up with
