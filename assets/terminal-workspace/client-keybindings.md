# Free the keys your terminal emulator swallows

Hand this to a coding agent running **on the machine you type on** – the
Windows, macOS, or Linux desktop you SSH *from*. You cannot do this from the
remote host. The local terminal emulator intercepts the keys before they ever
reach the other end.

## 1. The emulator claims the same alt chords the remote host binds

On the remote host the user runs herdr, a terminal multiplexer. One program
holds many terminal sessions and keeps them running after the user
disconnects. Its setup binds `alt` key combinations, called chords, for panes,
tabs and popups.

Some terminal emulators bind the same chords locally. They swallow the
keypress, or they act on it **and** forward it, so one press does two things.

The known collision is **`alt+shift+d`**, which Windows Terminal binds to
"duplicate pane" by default. Pressing it splits the tab on your own machine
with a new shell, and opens a herdr tab on the remote host.

## 2. Unbind, in the terminal emulator only

Work in the terminal emulator config only. Unbind every chord in the table
below that the emulator currently claims. Change nothing on the remote host,
and do not touch the remote configuration.

| Chord | Used remotely for |
|---|---|
| `alt+d` / `alt+shift+d` | diff viewer, popup and tab |
| `alt+i` / `alt+shift+i` | pull request dashboard, popup and tab |
| `alt+y` / `alt+shift+y` | file manager, popup and tab |
| `alt+h` `alt+j` `alt+k` `alt+l` | move between panes |
| `alt+left` / `alt+right` | previous and next tab |
| `alt+up` / `alt+down` | previous and next workspace |
| `alt+1` ... `alt+9` | jump to an agent |
| `alt+c` `alt+e` `alt+minus` `alt+z` `alt+s` `alt+g` `alt+a` `alt+n` `alt+u` `alt+w` `alt+r` | new tab, splits, zoom, sidebar, goto, last pane, agent and workspace navigation |

A workspace is one herdr container holding tabs and panes.

### Windows Terminal

Settings, then "Open JSON file". Add to the `actions` array:

```json
{ "command": "unbound", "keys": "alt+shift+d" }
```

Windows Terminal binds three more chords from the same family. Check
`alt+shift+plus`, `alt+shift+minus` and `alt+shift+<arrow>` in the same pass.

### Other emulators

- **WezTerm**: `keys` in `.wezterm.lua`, with `action = wezterm.action.DisableDefaultAssignment`
- **iTerm2**: Preferences, Keys, Key Bindings, or the profile's own Keys tab
- **kitty**: `map alt+shift+d no_op` in `kitty.conf`
- **Ghostty**: `keybind = alt+shift+d=ignore` in the config
- **GNOME Terminal / Konsole**: check the shortcut editor for the chord

## 3. What never to change

- **Back up the config before editing**, and show the change before saving.
- Unbind only. Do not remap these chords to something else, and do not touch
  bindings unrelated to the table above.
- Leave a chord alone when the terminal emulator does not bind it locally.

## 4. Confirm exactly one thing happens

Reload or restart the terminal, then SSH in and press `alt+shift+d`. Exactly
one thing should happen. A tab opens on the remote host. A local split, or both
at once, means the unbind did not take.

Report which chords the terminal emulator had bound, what changed, and how to
undo it.
