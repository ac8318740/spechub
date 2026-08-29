# Terminal workspace keys

The keys worth memorising, and nothing else. Run `/spechub:terminal-workspace` to install what they drive.

Two layers:

- **`alt`** reaches herdr from anywhere, including from inside a running tool
- **`prefix`** is `ctrl+b`, then the key, for what you press rarely

## Move around

| Key | Does |
|---|---|
| `alt+h` `alt+j` `alt+k` `alt+l` | move between panes |
| `alt+1` to `alt+9` | jump to an agent |
| `alt+n` / `alt+u` | next / previous agent |
| `alt+left` / `alt+right` | previous / next tab |
| `alt+up` / `alt+down` | previous / next workspace |
| `alt+a` | last pane |
| `alt+z` | zoom this pane |
| `alt+s` | toggle the sidebar |

## Make things

| Key | Does |
|---|---|
| `alt+e` | split vertical |
| `alt+minus` | split horizontal |
| `alt+c` | new tab |
| `alt+w` | new workspace |
| `alt+r` | new worktree |
| `prefix+t` | go to a pane by name |

## Open a tool

Add `shift` to any of these to open it in a full tab instead of a popup.

| Key | Opens | For |
|---|---|---|
| `alt+f` | diffnav | what changed on this branch |
| `alt+x` | diffnav picker | choose what to compare |
| `alt+g` | lazygit | stage, commit, push |
| `alt+i` | gh-dash | your PRs on GitHub |
| `alt+y` | yazi | find a file |

## Inside each tool

`e` means edit in every tool that has an editor key, except diffnav, which spends `e` on its file tree.

### diffnav (`alt+f`)

| Key | Does |
|---|---|
| `j` / `k` | next / previous file |
| `o` | open the file in `$EDITOR` |
| `s` | toggle side-by-side |
| `e` | toggle the file tree |
| `?` | every key |

### lazygit (`alt+g`)

| Key | Does |
|---|---|
| `space` | stage the file under the cursor |
| `a` | stage everything |
| `c` | commit |
| `A` | amend the last commit |
| `P` | push |
| `?` | every key |

### yazi (`alt+y`)

| Key | Does |
|---|---|
| `e` | edit in `$EDITOR` |
| `o` | open by rule, which for markdown is the reader |
| `b` | open in the browser you are sitting at |
| `D` | send the file to your laptop over Taildrop |

### tuicr

| Key | Does |
|---|---|
| `e` | edit the focused file in `$EDITOR` |
| `c` | comment on the line |
| `y` | copy the review to the clipboard |
| `;o` | open the PR on GitHub |
| `x` | filter files out of the tree |
| `?` | every key |

### LazyVim

| Key | Does |
|---|---|
| `space` | show every key, with labels |
| `space` `space` | find a file |
| `space` `/` | grep the project |
| `space` `e` | file tree |
| `space` `g` `g` | lazygit |
| `H` / `L` | previous / next file |
| `:Tutor` | learn vim in 25 minutes |

## When a key does nothing

- Your terminal emulator ate it, and `alt+shift+d` is the known case in Windows Terminal
- Run `cat -v` in any pane and press the key
    - An escape sequence such as `^[Z` means the key arrived, so the problem is the remote config
    - Nothing printed means the key never left your machine
- Fix it with `assets/terminal-workspace/client-keybindings.md`, which you hand to an agent running on your own machine
