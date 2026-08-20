# Free the workspace keys in your terminal emulator

Hand this to a coding agent running **on the machine you type on**: the
Windows, macOS, or Linux desktop you SSH *from*. It cannot be done from the
remote host: the keys are intercepted locally, before they ever reach the
other end.

## The problem

A terminal workspace on the remote host binds `alt` chords. Some terminal
emulators bind the same chords locally and swallow them, or act on them **and**
forward them, so one keypress does two things.

The known collision is **`alt+shift+d`**, which Windows Terminal binds to
"duplicate pane" by default. Pressing it splits the local tab with a new shell
*and* opens a tab on the remote host.

## What to do

Unbind, in the terminal emulator only, any chord below that it currently claims.
Change nothing on the remote host, and do not touch the remote configuration.

| Chord | Used remotely for |
|---|---|
| `alt+d` / `alt+shift+d` | diff viewer, popup and tab |
| `alt+i` / `alt+shift+i` | pull request dashboard, popup and tab |
| `alt+y` / `alt+shift+y` | file tree, popup and tab |
| `alt+h` `alt+j` `alt+k` `alt+l` | move between panes |
| `alt+left` / `alt+right` | previous and next tab |
| `alt+up` / `alt+down` | previous and next workspace |
| `alt+1` … `alt+9` | jump to an agent |
| `alt+c` `alt+e` `alt+minus` `alt+z` `alt+s` `alt+g` `alt+a` `alt+n` `alt+u` `alt+w` `alt+r` | new tab, splits, zoom, sidebar, goto, last pane, agent and workspace navigation |

### Windows Terminal

Settings, then "Open JSON file". Add to the `actions` array:

```json
{ "command": "unbound", "keys": "alt+shift+d" }
```

Its other defaults worth checking in the same pass, because they are the same
family and collide with the pane and split chords above:
`alt+shift+plus`, `alt+shift+minus`, and `alt+shift+<arrow>`.

### Other emulators

- **WezTerm**: `keys` in `.wezterm.lua`, with `action = wezterm.action.DisableDefaultAssignment`
- **iTerm2**: Preferences, Keys, Key Bindings, or the profile's own Keys tab
- **kitty**: `map alt+shift+d no_op` in `kitty.conf`
- **Ghostty**: `keybind = alt+shift+d=ignore` in the config
- **GNOME Terminal / Konsole**: check the shortcut editor for the chord

## Rules

- **Back up the config before editing**, and show the change before saving.
- Unbind only. Do not remap these chords to something else, and do not touch
  bindings unrelated to the table above.
- If a chord in the table is not bound locally, leave it alone. Absence of a
  binding is the desired state.

## Verify

Reload or restart the terminal, then SSH in and press `alt+shift+d`. Exactly
one thing should happen: a tab opens on the remote host. A local split, or both
at once, means the unbind did not take.

Report which chords were bound, what changed, and how to undo it.
