# Config choices

`SKILL.md` decides when to read this file: before walking the user through the config, on a first setup or when they change a setting.

## 3. Copy the config, then walk the user through the choices

Then ask about these settings, in this order:

- **`herdr.integration`**: which agent reports its state to herdr. Set it to the agent the user actually runs, or `none`. Without it, herdr infers state by reading the screen
- **`gh_dash.repo_paths`**: map each repository to its local clone. Without it, checkout fails. So does any keybinding using `{{.RepoPath}}`, the placeholder gh-dash fills in with that clone's path
- **`herdr.chord_modifier`**: `alt` (default), `ctrl+alt`, or `none`. A chord is one key combination, such as `alt+f`
    - Recommend `alt`. It is the only family measured to work whichever way the user connects
    - The herdr documentation recommends `ctrl+alt`. That does reach herdr over a plain SSH shell
    - A Windows client attaching with `herdr --remote` never delivers `ctrl+alt`. Every such chord goes silently dead
    - Suggest `ctrl+alt` only to a user who attaches exactly one way and has tested it
    - `none` keeps herdr's prefix-only keymap. The user presses a prefix key first
- **`herdr.worktrees_directory`**: keep it absolute. A worktree is a second checkout of the same repository on its own branch.

    A relative value resolves against the herdr session's base directory, not the repository you point at. Worktrees for a second repository then land inside the first

- **`herdr.theme.name`**: leave it empty unless the user asks for a theme, and `apply` then writes none
    - Set `herdr.theme.light` too for a user who attaches from two devices with different backgrounds, such as a dark terminal and an e-ink panel
    - `auto_switch` asks each attached client for its background colour over OSC 11, an escape sequence a terminal answers with the colour it paints
    - herdr then picks the dark or the light theme from that answer
    - Without a light theme there is nothing to switch to, so `apply` writes the name alone
- **`herdr.toast_delivery`** and **`herdr.agent_panel_sort`**: empty by default, and `apply` writes neither
    - Set `toast_delivery` to `herdr` on a machine reached over SSH, where the terminal is the only surface herdr can draw a message on
    - Set `agent_panel_sort` to `priority` to put the agents waiting on the user at the top
- **`herdr.agent_labels_on_pane_borders`**: leave it `true`. Several agents in several panes is what this workspace is for, and an unlabelled pane does not say which agent it holds
- **`tuicr.build_from_fork`**: leave it `false`
    - Set it `true` for the two unmerged upstream pull requests, #607 stats and #633 resize
    - Set it `true` also for the fork's own fix for blank `+N -N` counts in pull request review mode
    - `true` needs cargo, the Rust build tool, and takes a few minutes to build
    - Tell the user it is temporary. `status` tracks the two upstream pull requests, not the local fix
- **`tuicr.appearance`**: pin it to `dark` or `light` on any machine the user reaches over the network
    - Detection asks the terminal for its background colour over OSC 11, and nothing answers under `herdr --remote`
    - tuicr then falls back to a desktop setting that a headless machine reports as light, and paints dark text on a black terminal
    - Empty leaves the detection in place, which is right on a machine the user sits at
- **`gh_dash.keybindings.agent_review`**: hands the selected pull request to an agent. Leave it empty if the user does not want that key. Avoid `R`, which is gh-dash's built-in refresh-all
- **`yazi.download_target`**: the Tailscale node name of the machine the user sits at. Setting it puts a download key in yazi. Leave it empty for a user who does not run Tailscale, and `apply` writes no key
    - Ask for the name `tailscale status` prints on **this** machine, not the name the user calls their laptop
    - Taildrop sends only between devices one Tailscale account owns on one tailnet, so confirm both ends match before setting it
    - Tell them to run `sudo tailscale set --operator=$USER` once on this machine, because `tailscale file cp` refuses a non-root caller without it
- **`neovim.enabled`**: off by default, and the only component that is. Turn it on for a user who edits in LazyVim, and always on a machine they reach over SSH
    - Over SSH, LazyVim turns clipboard sync off and `:%y+` fails with `clipboard: No provider`
    - `neovim.osc52_clipboard`, on by default, sends each copy to the user's own clipboard over OSC 52
        - `p` pastes what neovim copied last, because Windows Terminal refuses OSC 52 reads
        - The file does nothing on a machine with a display or inside tmux
        - `apply` leaves it out when a file the user wrote already sets `vim.g.clipboard`, and names that file
    - LazyVim recolours the filename and shows no sign of its own, so a modified buffer is easy to miss
    - `apply` writes `~/.config/nvim/lua/plugins/spechub.lua` and edits nothing the user wrote
    - `apply` leaves the dot out when a lualine override the user wrote already marks a modified buffer, and names that file
        - The statusline would otherwise carry two dots side by side
    - Tell such a user to delete their own file to hand the dot to this component
- **`remote.clipboard_shim`**: leave it `true` on any machine reached over SSH. It puts an `xclip` on `$PATH`, backed by `spechub-clip`. That stand-in is the only reason gh-dash's `y` and `Y` work there. `apply` skips it when the machine has a real `xclip` or a display

One setting sits outside the config. `spechub-md --serve` takes its port from
`$SPECHUB_MD_PORT` and falls back to 6419. Tell the user to forward whichever
port they serve on, or the link `--serve` prints is unreachable from their
laptop.
