# Components and reserved keys

Read this file when the user asks what a component does, which key turns it on, or why a key sits where it does.

## 1. Eleven components, installed for a user account and not for a project

| Component | What it gives the user | Config key |
|---|---|---|
| herdr | A terminal multiplexer. It holds many terminal sessions and keeps them running after the user disconnects. | `herdr.enabled` |
| gh-dash | A pull request dashboard, in the terminal. | `gh_dash.enabled` |
| diffnav | A diff viewer with a file tree, on one key. | `diffnav.enabled` |
| delta | The diff renderer git pages through. | `delta.enabled` |
| tuicr | Reviews a pull request inside the terminal. | `tuicr.enabled` |
| lazygit | Stages, commits, amends and pushes, on one key. | `lazygit.enabled` |
| harlequin | A SQL editor in the terminal, on one key. Installed by uv, and launched by spechub-db. | `harlequin.enabled` |
| neovim | A dot in the LazyVim statusline for a buffer with unsaved changes. Installs nothing, writes one file, and starts off. | `neovim.enabled` |
| yazi | A file manager, with markdown drawn live by spechub-md. One key sends the hovered file to the machine the user sits at. | `yazi.enabled` |
| markdown | Markdown with its mermaid diagrams drawn as text, or served to a browser. Installs spechub-md, mermaid-ascii and glow. | `markdown.enabled` |
| remote | Copy and open, on a machine with no display of its own. Installs spechub-clip and spechub-open. | `remote.enabled` |

A config key never carries a hyphen, so gh-dash is `gh_dash`. The last two rows
name a feature rather than a binary, so each of those cells names its tools.
The `neovim` row names an editor this setup never installs, and only configures.

### 1.1. `g` belongs to git, and `e` means edit

The setup reserves two letters across the whole workspace, so the same key does
the same thing wherever the user is standing:

- `alt+g` opens lazygit and `alt+shift+g` opens it in a tab, so herdr's `goto` sits on `prefix+t` and `new_worktree` keeps only its chord
- `e` opens `$EDITOR` in yazi and in both of tuicr's panels, which is why tuicr's file tree filters are `x` and `X`
- diffnav is the exception, because it spends `e` on its file tree and puts the editor on `o`
