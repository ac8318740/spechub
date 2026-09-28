# Turn off and update

`SKILL.md` decides when to read this file: when the user asks to turn a component off or uninstall, or `outdated` reports something.

## 8. Turning one component off, or all of them

*`disable` undoes one component. `uninstall` undoes the managed config. harlequin is the one binary either of them removes.*

```bash
bash "$SETUP" disable herdr     # or delta, diffnav, gh_dash, harlequin, lazygit, neovim, tuicr
```

`disable` takes those eight components and no others. For `diffnav`, `gh_dash`,
`harlequin`, `lazygit` and `tuicr` it writes `<component>.enabled: false` into
the config itself, then rebuilds the herdr keymap so the rest of it survives.

For `herdr`, `delta` and `neovim` it does not. Set `<component>.enabled: false`
yourself after those three, or the next `apply` restores them.

`neovim` is the one whose undo is a deletion. The component writes a whole file
of SpecHub's own, so `disable` removes `~/.config/nvim/lua/plugins/spechub.lua`
and leaves the rest of the user's neovim config alone. Neither `disable` nor
`uninstall` touches a `spechub.lua` the user wrote by hand.

`yazi`, `markdown` and `remote` have no `disable` path. `disable` refuses for
those three and names the edit that turns one off. Set the component's
`enabled` key to `false` in the config, then run `apply` again.

```bash
bash "$SETUP" uninstall
```

`uninstall` removes everything `apply` wrote. It strips the managed blocks from
the herdr, tuicr and yazi configs. It unsets delta as the git pager.

It deletes the helper scripts, the `xclip` stand-in, the neovim plugin file, and
the keybindings it wrote into gh-dash. The user's own settings around them
survive, and every binary stays except harlequin, which uv owns whole rather
than as one file in `$BIN`.

## 9. Keeping it current

*`outdated` reports what has moved on. `upgrade` fetches it.*

```bash
bash "$SETUP" outdated
```

It prints one finding per line, tab-separated as kind, name and detail, and
answers in its exit code:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Nothing to do | Say nothing |
| 1 | Something is missing, new or stale | Show the findings and offer `upgrade` |
| 2 | It cannot tell | Name the reason once and move on |

Four kinds of finding:

- `missing` – this machine has never applied the workspace, so run section 4 of `SKILL.md` rather than `upgrade`
- `new` – a component this plugin version ships that the user's last `apply` never saw
- `stale` – an installed tool behind its published release
- `unknown` – the script cannot compare, so there is nothing to act on

```bash
bash "$SETUP" upgrade              # everything reported stale
bash "$SETUP" upgrade yazi delta   # only these
```

`upgrade` reinstalls each stale binary and appends any new component's config
block to the user's file, comments intact. The three tools that update
themselves go through `herdr update`, `gh extension upgrade dlvhdr/gh-dash`,
and `uv tool upgrade harlequin`. Run `apply` afterwards to install what the new
block turned on.

Naming a tool skips the version comparison, which is the only way to refresh
`mermaid-ascii`. It has no version flag, so nothing can read the installed version.

`outdated` reads herdr's stable release manifest, so a user on the preview
channel sees a `stale` row for herdr that is not one.
