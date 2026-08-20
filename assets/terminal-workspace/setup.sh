#!/usr/bin/env bash
# SpecHub terminal workspace setup.
#   setup.sh status     what is installed and enabled
#   setup.sh apply      install and configure everything enabled in the config
#   setup.sh disable <herdr|delta|diffnav|gh_dash>
#   setup.sh uninstall  remove every managed block, keep the binaries
#
# Idempotent. Only ever edits between managed markers, so hand-written config
# around it survives.
set -uo pipefail

CFG="${SPECHUB_TW_CONFIG:-$HOME/.config/spechub/terminal-workspace.yaml}"
BIN="${SPECHUB_TW_BIN:-$HOME/.local/bin}"
HERDR_CFG="$HOME/.config/herdr/config.toml"
GHDASH_CFG="$HOME/.config/gh-dash/config.yml"
BEGIN="# >>> spechub terminal-workspace >>>"
END="# <<< spechub terminal-workspace <<<"
ACTION="${1:-status}"

have() { command -v "$1" >/dev/null 2>&1; }

require_yaml() {
  python3 -c 'import yaml' 2>/dev/null && return 0
  echo "PyYAML is required to read $CFG" >&2
  echo "Install it (pip install --user pyyaml) and run again. Refusing to" >&2
  echo "continue, because without it every setting falls back to a default" >&2
  echo "and your config is silently ignored." >&2
  exit 1
}

arch_supported() {
  case "$(uname -m)" in
    x86_64|amd64) return 0 ;;
    *) say "prebuilt binaries are x86_64 only, and this is $(uname -m)"
       say "install herdr, delta, and diffnav yourself, then run apply again"
       return 1 ;;
  esac
}
say()  { printf '  %s\n' "$*"; }

py() { python3 - "$@"; }

# Reads one dotted path. require_yaml runs first, so a fallback here means
# the key is absent, never that yaml failed to import.
cfg_get() {  # cfg_get <dotted.path> <default>
  SPECHUB_CFG="$CFG" py "$1" "${2:-}" <<'PY'
import os, sys
import yaml
p = os.environ["SPECHUB_CFG"]
if not os.path.isfile(p):
    print(sys.argv[2]); raise SystemExit
d = yaml.safe_load(open(p)) or {}
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None: break
if isinstance(d, bool): d = "true" if d else "false"
print(d if d is not None else sys.argv[2])
PY
}

install_binary() {  # install_binary <name> <repo> <asset-match>
  local name="$1" repo="$2" match="$3"
  have "$name" && { say "$name already installed"; return 0; }
  local url
  url=$(curl -s "https://api.github.com/repos/$repo/releases/latest" \
    | py "$match" <<'PY'
import json, sys
d = json.load(sys.stdin)
for a in d.get("assets", []):
    if sys.argv[1] in a["name"] and a["name"].endswith((".tar.gz", ".tgz")):
        print(a["browser_download_url"]); break
PY
)
  [ -z "$url" ] && { say "$name: no matching release asset, install manually"; return 1; }
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  curl -sL "$url" -o "$tmp/a.tgz" && tar xzf "$tmp/a.tgz" -C "$tmp" || { say "$name: download failed"; return 1; }
  local found; found=$(find "$tmp" -type f -name "$name" | head -1)
  [ -z "$found" ] && { say "$name: binary not found in archive"; return 1; }
  mkdir -p "$BIN"; cp "$found" "$BIN/$name"; chmod +x "$BIN/$name"
  say "$name installed to $BIN/$name"
}

write_helpers() {
  mkdir -p "$BIN"
  cat > "$BIN/spechub-diff" <<'H'
#!/usr/bin/env bash
# Show the most relevant diff in diffnav. Installed by spechub.
set -uo pipefail
pick_checkout() {
  # herdr groups worktrees as <root>/<repo>/<branch-slug>, so a pane often
  # sits in the parent of several checkouts rather than in one.
  local -a repos=()
  while IFS= read -r d; do repos+=("$d"); done < <(
    find . -mindepth 1 -maxdepth 1 -type d -exec test -e '{}/.git' \; -print 2>/dev/null | sort)
  case ${#repos[@]} in
    0) return 1 ;;
    1) cd "${repos[0]}" && return 0 ;;
    *) echo "Not a repo, but it holds ${#repos[@]} checkouts:"; echo
       local i=1
       for d in "${repos[@]}"; do
         printf '  %d) %-34s %s\n' "$i" "${d#./}" "$(git -C "$d" branch --show-current 2>/dev/null)"
         i=$((i+1))
       done
       echo; read -rp "Which one? [1-${#repos[@]}, q to quit] " choice
       [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#repos[@]} ] \
         && cd "${repos[$((choice-1))]}" && return 0
       return 1 ;;
  esac
}
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  pick_checkout || { echo "No git checkout here: $PWD"; echo "Press any key..."; read -rsn1; exit 0; }
fi
if ! git diff --quiet; then git diff | diffnav
elif ! git diff --cached --quiet; then echo "(staged)"; git diff --cached | diffnav
else echo "(no pending changes - last commit)"; git show HEAD | diffnav; fi
H
  chmod +x "$BIN/spechub-diff"

  cat > "$BIN/spechub-dash" <<'H'
#!/usr/bin/env bash
# gh-dash with a section for the repo you are standing in. Installed by spechub.
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
H
  chmod +x "$BIN/spechub-dash"
  say "helpers written: spechub-diff, spechub-dash"
}

apply_herdr() {
  have herdr || { say "herdr not installed, skipping keymap"; return 0; }
  mkdir -p "$(dirname "$HERDR_CFG")"; touch "$HERDR_CFG"
  local mod wt diffkey dashkey
  mod=$(cfg_get herdr.chord_modifier alt)
  wt=$(cfg_get herdr.worktrees_directory "~/.herdr/worktrees")
  diffkey=$(cfg_get diffnav.popup_key "alt+d")
  dashkey=$(cfg_get gh_dash.popup_key "alt+i")
  [ "$(cfg_get diffnav.enabled true)" = "true" ] || diffkey=""
  [ "$(cfg_get gh_dash.enabled true)" = "true" ] || dashkey=""

  SPECHUB_ARGS="$mod|$wt|$diffkey|$dashkey|$BEGIN|$END" py "$HERDR_CFG" <<'PY'
import os, re, sys
path = sys.argv[1]
mod, wt, diffkey, dashkey, begin, end = os.environ["SPECHUB_ARGS"].split("|")
text = open(path).read() if os.path.isfile(path) else ""
# Drop any previous managed region so this is idempotent.
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)

keys = []
if mod != "none":
    m = mod
    keys = [
        f'focus_agent = "{m}+1..9"',
        f'focus_pane_left  = ["prefix+h", "{m}+h"]',
        f'focus_pane_down  = ["prefix+j", "{m}+j"]',
        f'focus_pane_up    = ["prefix+k", "{m}+k"]',
        f'focus_pane_right = ["prefix+l", "{m}+l"]',
        f'next_agent = "{m}+n"',
        f'previous_agent = "{m}+u"',
        f'next_tab = ["prefix+n", "{m}+right"]',
        f'previous_tab = ["prefix+p", "{m}+left"]',
        f'next_workspace = ["{m}+down"]',
        f'previous_workspace = ["{m}+up"]',
        f'toggle_sidebar = ["prefix+b", "{m}+s"]',
        f'goto = ["prefix+g", "{m}+g"]',
        f'zoom = ["prefix+z", "{m}+z"]',
        f'last_pane = "{m}+a"',
        f'new_tab = ["prefix+c", "{m}+c"]',
        f'new_workspace = ["prefix+shift+n", "{m}+w"]',
        f'new_worktree = ["prefix+shift+g", "{m}+r"]',
        f'split_vertical = ["prefix+v", "{m}+e"]',
        f'split_horizontal = ["prefix+minus", "{m}+minus"]',
    ]

block = [begin]
if keys:
    # Merge into an existing [keys] table rather than declaring a second one.
    if re.search(r"^\[keys\]", text, flags=re.M):
        insert = "\n".join(keys)
        text = re.sub(r"^\[keys\]\n", "[keys]\n" + begin + "\n" + insert + "\n" + end + "\n",
                      text, count=1, flags=re.M)
        block = None
    else:
        block.append("[keys]")
        block.extend(keys)

if block is not None:
    tail = []
    for key, cmd, desc in ((diffkey, "spechub-diff", "diff (diffnav)"),
                           (dashkey, "spechub-dash", "PR dashboard")):
        if key:
            tail += ["", "[[keys.command]]", f'key = "{key}"', 'type = "popup"',
                     f'command = "{cmd}"', f'description = "{desc}"',
                     'width = "90%"', 'height = "90%"']
    block += tail + ["", "[worktrees]", f'directory = "{wt}"', end]
    text = text.rstrip("\n") + "\n\n" + "\n".join(block) + "\n"
else:
    tail = [begin]
    for key, cmd, desc in ((diffkey, "spechub-diff", "diff (diffnav)"),
                           (dashkey, "spechub-dash", "PR dashboard")):
        if key:
            tail += ["", "[[keys.command]]", f'key = "{key}"', 'type = "popup"',
                     f'command = "{cmd}"', f'description = "{desc}"',
                     'width = "90%"', 'height = "90%"']
    tail += ["", "[worktrees]", f'directory = "{wt}"', end]
    text = text.rstrip("\n") + "\n\n" + "\n".join(tail) + "\n"

open(path, "w").write(text)
PY
  if herdr config check 2>&1 | grep -q "^config: ok"; then
    herdr server reload-config >/dev/null 2>&1
    say "herdr keymap applied and reloaded"
  else
    say "herdr config check failed, review $HERDR_CFG"
    herdr config check 2>&1 | sed 's/^/    /' | head -5
  fi

  local integ; integ=$(cfg_get herdr.integration none)
  if [ "$integ" != "none" ] && [ -n "$integ" ]; then
    herdr integration install "$integ" >/dev/null 2>&1 && say "herdr $integ state hook installed"
  fi
}

apply_delta() {
  have delta || { say "delta not installed, skipping git pager"; return 0; }
  [ "$(cfg_get delta.set_git_pager true)" = "true" ] || { say "delta: git pager left alone"; return 0; }
  git config --global core.pager delta
  git config --global interactive.diffFilter "delta --color-only"
  git config --global delta.navigate true
  git config --global delta.line-numbers true
  git config --global merge.conflictstyle zdiff3
  say "delta set as git pager"
}

apply_ghdash() {
  have gh || { say "gh not installed, skipping dashboard"; return 0; }
  gh extension list 2>/dev/null | grep -q gh-dash || gh extension install dlvhdr/gh-dash >/dev/null 2>&1
  mkdir -p "$(dirname "$GHDASH_CFG")"
  SPECHUB_CFG="$CFG" py "$GHDASH_CFG" <<'PY'
import os, sys, yaml
src, dst = os.environ["SPECHUB_CFG"], sys.argv[1]
tw = (yaml.safe_load(open(src)) or {}).get("gh_dash", {}) if os.path.isfile(src) else {}
cfg = yaml.safe_load(open(dst)) or {} if os.path.isfile(dst) else {}
if tw.get("sections"):
    cfg["prSections"] = [{"title": s["title"], "filters": s["filters"]} for s in tw["sections"]]
if tw.get("repo_paths"):
    cfg["repoPaths"] = tw["repo_paths"]
kb = tw.get("keybindings", {}) or {}
prs = [k for k in (cfg.get("keybindings", {}) or {}).get("prs", [])
       if k.get("name") not in ("tree diff", "agent review")]
if kb.get("tree_diff"):
    prs.append({"key": kb["tree_diff"], "name": "tree diff",
                "command": "gh pr diff {{.PrNumber}} --repo {{.RepoName}} | diffnav\n"})
if kb.get("agent_review"):
    prs.append({"key": kb["agent_review"], "name": "agent review",
                "command": 'cd {{.RepoPath}} && claude "/code-review {{.PrNumber}}"\n'})
cfg.setdefault("keybindings", {})["prs"] = prs
yaml.safe_dump(cfg, open(dst, "w"), sort_keys=False, default_flow_style=False, width=200)
print("  gh-dash config written")
PY
}

case "$ACTION" in
  status)
    echo "config: $CFG $([ -f "$CFG" ] && echo '(found)' || echo '(missing, using defaults)')"
    for t in herdr delta diffnav gh; do
      printf '  %-8s %-14s enabled=%s\n' "$t" "$(have "$t" && echo installed || echo 'not installed')" \
        "$(cfg_get "$([ "$t" = gh ] && echo gh_dash || echo "$t").enabled" true)"
    done
    grep -q "$BEGIN" "$HERDR_CFG" 2>/dev/null && say "herdr managed block: present" || say "herdr managed block: absent"
    ;;
  apply)
    require_yaml
    arch_supported || exit 1
    [ "$(cfg_get enabled true)" = "true" ] || { echo "terminal workspace disabled in config"; exit 0; }
    if [ "$(cfg_get herdr.enabled true)" = "true" ] && ! have herdr; then
      # herdr ships an installer that picks the right build and verifies a
      # checksum. Prefer it over matching release asset names ourselves.
      curl -fsSL https://herdr.dev/install.sh | sh >/dev/null 2>&1 \
        && say "herdr installed" || say "herdr install failed, see herdr.dev"
    fi
    [ "$(cfg_get delta.enabled true)"   = "true" ] && install_binary delta dandavison/delta x86_64-unknown-linux-gnu
    [ "$(cfg_get diffnav.enabled true)" = "true" ] && install_binary diffnav dlvhdr/diffnav Linux_x86_64
    write_helpers
    [ "$(cfg_get herdr.enabled true)"   = "true" ] && apply_herdr
    [ "$(cfg_get delta.enabled true)"   = "true" ] && apply_delta
    [ "$(cfg_get gh_dash.enabled true)" = "true" ] && apply_ghdash
    echo "done. open a herdr session and press prefix+? to see the keymap"
    ;;
  disable)
    comp="${2:?usage: setup.sh disable <herdr|delta|diffnav|gh_dash>}"
    case "$comp" in
      delta) for k in core.pager interactive.diffFilter delta.navigate delta.line-numbers; do
               git config --global --unset "$k" 2>/dev/null
             done
             say "delta unset as git pager"
             say "now set delta.enabled: false in $CFG so apply does not restore it" ;;
      herdr)
        py "$HERDR_CFG" "$BEGIN" "$END" <<'PY'
import re, sys, os
p, b, e = sys.argv[1:4]
if os.path.isfile(p):
    t = open(p).read()
    open(p, "w").write(re.sub(re.escape(b) + r".*?" + re.escape(e) + r"\n?", "", t, flags=re.S))
PY
        say "managed block removed from herdr config"
        say "now set herdr.enabled: false in $CFG so apply does not restore it" ;;
      diffnav|gh_dash)
        # Only this component's popup goes away. Rebuild the managed block so
        # the rest of the keymap survives.
        require_yaml
        SPECHUB_CFG="$CFG" py "$comp" <<'PY'
import os, sys, yaml
p = os.environ["SPECHUB_CFG"]
c = yaml.safe_load(open(p)) or {}
c.setdefault(sys.argv[1], {})["enabled"] = False
yaml.safe_dump(c, open(p, "w"), sort_keys=False)
PY
        apply_herdr
        say "$comp disabled, rest of the keymap left in place" ;;
    esac
    ;;
  uninstall)
    "$0" disable herdr; "$0" disable delta
    rm -f "$BIN/spechub-diff" "$BIN/spechub-dash"
    say "managed config and helpers removed. binaries left in place"
    ;;
  *) echo "usage: setup.sh [status|apply|disable <component>|uninstall]"; exit 1 ;;
esac
