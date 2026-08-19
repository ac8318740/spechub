# Terminal workspace: herdr, gh-dash, diffnav

Run several coding agents in parallel, keep them alive when you close the terminal, and review their work without leaving it. Three tools cover it: herdr owns the terminals, gh-dash triages pull requests, diffnav reads diffs. This is one worked setup, with exact configuration and keys.

Use it when you work on a remote machine over SSH, drive more than one agent at a time, and want a keyboard-only workflow. Skip it if you work locally in a graphical editor: a desktop tool will serve you better.

## What you get

- **Agents that survive disconnect.** herdr runs a background server, so closing the terminal, dropping the network, or attaching from another machine never stops an agent mid-task
- **One screen that shows who needs you.** Every pane is marked working, blocked, idle, or done, so you stop hunting for the stuck one
- **Review without a browser.** Pull request triage, diffs with a file tree, and comments, all from the terminal

## The parts

| Tool | Role | Why this one |
|---|---|---|
| [herdr](https://herdr.dev) | Terminal workspace manager | Background server, per-pane agent state, git worktree workspaces |
| [gh-dash](https://github.com/dlvhdr/gh-dash) | Pull request dashboard | Saved searches per section, custom actions, `gh` underneath |
| [diffnav](https://github.com/dlvhdr/diffnav) | Diff reader | File tree beside the diff, the blast-radius view a plain pager lacks |
| [delta](https://github.com/dandavison/delta) | Pager | Syntax highlighting for every diff, and gh-dash uses it internally |

## Install

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

Check what is available with `herdr integration status`. The hook applies to sessions started after it is installed.

## Configure

### herdr

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
command = "hdiff"
description = "diff (diffnav)"
width = "90%"
height = "90%"

[[keys.command]]
key = "alt+i"
type = "popup"
command = "hdash"
description = "PR dashboard"
width = "95%"
height = "95%"

[worktrees]
directory = "~/.herdr/worktrees"
```

Two choices worth explaining.

**Plain `alt` chords, not `ctrl+alt`.** herdr's docs recommend `ctrl+alt` because it is free across most terminals, but many terminals cannot encode it over SSH. `alt+<key>` transmits as escape plus the key and survives almost anywhere. Test your own path before committing to a family.

**Absolute `worktrees.directory`.** A relative value resolves against the herdr session's base directory, not the repository you point at, so worktrees for a second repository land inside the first. Use an absolute path unless you only ever work in one repository.

### Git and delta

```bash
git config --global core.pager delta
git config --global interactive.diffFilter "delta --color-only"
git config --global delta.navigate true
git config --global delta.line-numbers true
git config --global merge.conflictstyle zdiff3
```

Agents are unaffected: git only pages to a terminal, so a command whose output is piped or captured still gets plain text.

### gh-dash

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
      name: tree diff
      command: >
        gh pr diff {{.PrNumber}} --repo {{.RepoName}} | diffnav
    - key: S
      name: agent review
      command: >
        cd {{.RepoPath}} && claude "/code-review {{.PrNumber}}"
```

Any GitHub search string works as a section filter, so anything you can type into GitHub's search box becomes a tab. Avoid binding `R`: it is the built-in refresh-all.

### Two helper scripts

`hdiff` picks the most relevant diff, so one key always shows something useful:

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

`hdash` adds a section for whichever repository you are standing in, then hands a generated config to gh-dash:

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

## Keys

Each tool has its own help: `prefix+?` in herdr (press `/` to filter), `?` in gh-dash, and diffnav's footer.

### herdr

Prefix is `ctrl+b`. Everything below is a direct chord that needs no prefix.

| Key | Action |
|---|---|
| `alt+1`..`alt+9` | Focus agent by row |
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

### gh-dash

| Key | Action |
|---|---|
| `j` / `k` | Move between rows |
| `h` / `l` | Previous / next section |
| `p` | Toggle the preview pane |
| `[` / `]` | Previous / next preview tab: Overview, Activity, Commits, Checks, Files Changed |
| `ctrl+d` / `ctrl+u` | Scroll the preview |
| `e` | Expand the description |
| `d` | Built-in diff |
| `D` | diffnav, with the file tree |
| `S` | Hand the pull request to an agent |
| `C` or `space` | Check the branch out locally |
| `w` | Watch checks |
| `c` / `v` / `m` | Comment / approve / merge |
| `y` / `Y` | Copy number / URL |
| `r` / `R` | Refresh section / all |
| `/` · `?` · `q` | Search · help · quit |

### diffnav

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

## The workflow

1. **Dispatch.** `alt+r` creates a worktree workspace, or ask an agent for one and the `new-worktree` skill registers it with herdr for you
2. **Monitor.** `alt+s` shows the sidebar. Blocked needs an answer, done finished and you have not looked, working means leave it alone
3. **Review locally.** `alt+d` shows what the agent changed. Run the `pre-commit-review` skill in the agent's own pane for a deeper pass
4. **Ship.** The agent commits, pushes, and opens the pull request from its worktree
5. **Review the pull request.** `alt+i`, then `p` and `]` to reach Files Changed, `D` for the tree view, `S` to hand it to an agent
6. **Tear down.** `herdr worktree remove --workspace <id>`, then delete the branch

## Traps

Each of these cost real time to find.

- **`ctrl+b` is both herdr's prefix and Claude Code's "background this task".** Press it twice inside a Claude pane to reach Claude, or rebind herdr's prefix
- **Never submit a prompt to a blocked agent.** A blocked agent waits on a permission prompt, so injected text answers that prompt instead of giving an instruction. Wait for idle
- **`--cwd` for `herdr worktree create` must be the main checkout**, never a nested worktree. herdr stores it as the workspace's repository root and groups worktree workspaces under it in the sidebar
- **Read the created path from the command output.** Never assume where a worktree landed, because the configured root decides
- **Worktree workspaces nest, plain workspaces do not.** A workspace made with `alt+w` always sits at the top level, whatever directory it points at
- **Sidebar actions act on the selected workspace**, not the focused pane. Open the sidebar and select before creating a worktree or closing a workspace
- **In-process teammates are invisible to herdr.** A Claude teammate shares its parent's pane and session, so it never appears as its own agent. Two agents in one worktree means two real sessions
