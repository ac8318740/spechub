#!/usr/bin/env bash
# SpecHub terminal workspace setup.
#   setup.sh status     what is installed and enabled
#   setup.sh apply      install and configure everything enabled in the config
#   setup.sh disable <herdr|delta|diffnav|gh_dash|lazygit|tuicr>
#   setup.sh uninstall  remove every managed block, keep the binaries
#
# Idempotent. Only ever edits between managed markers, so hand-written config
# around it survives.
set -uo pipefail

CFG="${SPECHUB_TW_CONFIG:-$HOME/.config/spechub/terminal-workspace.yaml}"
BIN="${SPECHUB_TW_BIN:-$HOME/.local/bin}"
# Everything installs into $BIN, and the config steps then ask `have <tool>`
# whether it worked. On a fresh machine $BIN is not on PATH yet, so without
# this every tool installs and every config step is skipped.
# herdr's own installer always targets ~/.local/bin, which is only the same
# as $BIN when SPECHUB_TW_BIN is left alone. Cover both.
PATH="$BIN:$HOME/.local/bin:$PATH"
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
       say "install herdr, delta, diffnav, and lazygit yourself, then run apply again"
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
  local url json
  # py reads its script from stdin, so the release JSON has to arrive by
  # environment rather than by pipe: a pipe here is silently swallowed by
  # the heredoc and python then reads an empty stdin.
  json=$(curl -sSf "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null)
  [ -z "$json" ] && { say "$name: could not reach the GitHub release API"; return 1; }
  url=$(SPECHUB_JSON="$json" py "$match" <<'PY'
import json, os, sys
try:
    d = json.loads(os.environ["SPECHUB_JSON"])
except ValueError:
    raise SystemExit
for a in d.get("assets", []):
    # yazi publishes .zip only; delta and glow publish .tar.gz. Take either.
    if sys.argv[1] in a["name"] and a["name"].endswith((".tar.gz", ".tgz", ".zip")):
        print(a["browser_download_url"]); break
PY
)
  [ -z "$url" ] && { say "$name: no matching release asset, install manually"; return 1; }
  # Explicit cleanup rather than `trap ... RETURN`: a RETURN trap stays
  # registered for every later function return in this shell, where $tmp is
  # gone and `set -u` then aborts the run.
  local tmp found ar; tmp=$(mktemp -d)
  case "$url" in *.zip) ar="$tmp/a.zip" ;; *) ar="$tmp/a.tgz" ;; esac
  if ! curl -sL "$url" -o "$ar"; then
    rm -rf "$tmp"; say "$name: download failed"; return 1
  fi
  case "$ar" in
    *.zip) have unzip || { rm -rf "$tmp"; say "$name: needs unzip"; return 1; }
           unzip -qo "$ar" -d "$tmp" || { rm -rf "$tmp"; say "$name: unzip failed"; return 1; } ;;
    *)     tar xzf "$ar" -C "$tmp" || { rm -rf "$tmp"; say "$name: untar failed"; return 1; } ;;
  esac
  found=$(find "$tmp" -type f -name "$name" | head -1)
  if [ -z "$found" ]; then
    rm -rf "$tmp"; say "$name: binary not found in archive"; return 1
  fi
  mkdir -p "$BIN"; cp "$found" "$BIN/$name"; chmod +x "$BIN/$name"
  rm -rf "$tmp"
  say "$name installed to $BIN/$name"
}

write_helpers() {
  mkdir -p "$BIN"
  # Helpers this script used to write and no longer does. Upgrading otherwise
  # leaves them on PATH, shadowing nothing but confusing everything.
  rm -f "$BIN"/spechub-files "$BIN"/spechub-files-tab \
        "$BIN"/spechub-yazi-tab "$BIN"/spechub-tab "$BIN"/spechub-renumber
  cat > "$BIN/spechub-diff" <<'H'
#!/usr/bin/env bash
# Show a git diff in diffnav, with a banner naming what is being compared.
#
#   spechub-diff        this branch against dev, committed work only (alt+f)
#   spechub-diff pick   choose the comparison from a menu (alt+x)
#   spechub-diff auto   first non-empty of working tree, staged, last commit
#
# Every launch prepends a COMPARING block to the diff. diffnav renders whatever
# precedes the first "diff --git" line, which is how git show's commit header
# reaches the screen, so the block lands at the top of the content pane.
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

BRANCH=$(git branch --show-current 2>/dev/null) || BRANCH=""
[ -n "$BRANCH" ] || BRANCH="HEAD (detached)"

# ---- refs -----------------------------------------------------------------
ref_exists() { git rev-parse --verify --quiet "$1" >/dev/null 2>&1; }
first_ref() { local r; for r in "$@"; do ref_exists "$r" && { echo "$r"; return 0; }; done; return 1; }
dev_ref()     { first_ref origin/dev dev; }          # the server's dev wins over a stale local one
              # default_compare falls back to the default branch only where no dev branch exists
default_ref() {
  local d; d=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  [ -n "$d" ] && { echo "$d"; return 0; }
  first_ref origin/main main origin/master master
}
tip() {  # tip <ref> -> "1b298bd . 4 hours ago . Merge pull request ..."
  # kept short: diffnav's content pane is narrower than the popup, so a long
  # line wraps and the banner stops looking like a banner.
  git log -1 --format='%h  %ar  %s' "$1" 2>/dev/null | cut -c1-70
}

# ---- what diffnav cannot draw ---------------------------------------------
# diffnav hands each file to delta, and delta dies on SIGABRT when one line
# runs to hundreds of kilobytes. diffnav reports the child's death as
# "FATA signal: aborted (core dumped)" and quits, so one such file takes the
# whole diff down with it. A committed build artifact is what does it: this
# project's own cli/dist/index.js.map holds a single 982,428-character line,
# and the merge commit touching it aborted diffnav in 1.7 seconds.
#
# So the file goes, not the diff. Any file whose patch holds a line over the
# limit is dropped and named in the banner, and the rest is drawn as usual.
# 20000 is far above any line a person writes and far below where delta gives
# out. Raise or lower it with SPECHUB_DIFF_LINE_LIMIT.
LINE_LIMIT_DEFAULT=20000
LINE_LIMIT="${SPECHUB_DIFF_LINE_LIMIT:-$LINE_LIMIT_DEFAULT}"
# awk compares a length against whatever this holds. Hand it "abc" and every
# comparison is a string comparison that is never true, so the guard turns
# itself off and the abort comes back with nothing on screen to explain it.
# Hand it 0 and every file is dropped instead. Refuse both, out loud.
case "$LINE_LIMIT" in
  ''|0|*[!0-9]*)
    echo "spechub-diff: SPECHUB_DIFF_LINE_LIMIT is \"$LINE_LIMIT\", which is not a" >&2
    echo "  positive whole number. Using $LINE_LIMIT_DEFAULT." >&2
    LINE_LIMIT=$LINE_LIMIT_DEFAULT ;;
esac
drop_unrenderable() {  # drop_unrenderable <skipped-file>  ; diff in, diff out
  # One file at a time: a patch has to be held whole before its longest line
  # is known. Everything before the first "diff --git" is a header, so it goes
  # straight through. Written for gawk, mawk and busybox awk alike.
  awk -v lim="$LINE_LIMIT" -v skip="$1" '
    function flush() {
      if (path == "") return
      # A tab between the two fields. banner reads this file back and splits
      # on the same tab, so the two have to move together.
      if (long) printf "%s\t%d\n", path, maxlen > skip
      else for (i = 1; i <= n; i++) print buf[i]
    }
    /^diff --git / {
      flush()
      split("", buf); n = 0; long = 0; maxlen = 0
      path = $0; sub(/^diff --git a\//, "", path); sub(/ b\/.*$/, "", path)
      if (path == "") path = "?"
    }
    {
      if (path == "") { print; next }
      if (length($0) > maxlen) maxlen = length($0)
      if (length($0) > lim) long = 1
      buf[++n] = $0
    }
    END { flush() }'
}

# ---- banner ---------------------------------------------------------------
banner() {  # banner <source-label> <change-label> <what> <command>
  # No line may start with a space: diffnav strips leading whitespace, so any
  # indentation collapses and columns stop lining up.
  printf 'COMPARING  %s  ==>  %s\n' "$1" "$2"
  # base and compare repeat their ref so each row ties back to the first line.
  [ -n "${SRC_TIP:-}" ] && printf 'base     %s\n' "$(printf '%s  %s' "$1" "$SRC_TIP" | cut -c1-70)"
  [ -n "${CHG_TIP:-}" ] && printf 'compare  %s\n' "$(printf '%s  %s' "$2" "$CHG_TIP" | cut -c1-70)"
  printf 'showing  %s\n' "$3"
  printf 'command  %s\n' "$4"
  # A dropped file is named here rather than left to be noticed as missing.
  # The tab is what drop_unrenderable writes between the two fields.
  [ -s "${SKIP:-}" ] && while IFS="$(printf '\t')" read -r p len; do
    printf 'skipped  %s  (one line is %s chars, and diffnav aborts on it)\n' "$p" "$len"
  done < "$SKIP"
  return 0
}
launch() {  # launch <source> <change> <what> <git-args...>
  local src="$1" chg="$2" what="$3"; shift 3
  local cmd="git $*"
  local tmp; tmp=$(mktemp); SKIP=$(mktemp)
  git "$@" 2>/dev/null | drop_unrenderable "$SKIP" > "$tmp"
  if grep -q '^diff --git' "$tmp"; then
    # diffnav puts the line after "commit <sha>" in its status bar, and the bar
    # stays put while you walk the file tree. A git show stream carries its own
    # header, so only a plain diff needs one synthesised.
    { [ "${1:-}" = diff ] && printf 'commit %s\n' "$(git rev-parse HEAD 2>/dev/null)"
      banner "$src" "$chg" "$what" "$cmd"; echo; cat "$tmp"; } | diffnav
  else
    # Nothing for diffnav to draw, for one of two different reasons. The
    # banner and the wait for a keypress are the same either way, so only the
    # explanation sits inside the branch.
    banner "$src" "$chg" "$what" "$cmd"
    echo
    if [ -s "$SKIP" ]; then
      echo "  Every file that changed carries a line too long for diffnav."
      echo "  They are named above, and nothing else differs between these two."
    else
      echo "  No difference between these two. Nothing to show."
      local dirty; dirty=$(git status --porcelain 2>/dev/null | grep -cv '^??')
      if [ "${dirty:-0}" -gt 0 ]; then
        echo "  You do have $dirty file(s) changed but not committed."
        echo "  Press alt+x and pick \"my uncommitted changes\" to see them."
      else
        echo "  Press alt+x to compare something else."
      fi
    fi
    echo; echo "Press any key..."; read -rsn1
  fi
  rm -f "$tmp" "$SKIP"
}

# ---- comparisons ----------------------------------------------------------
against() {  # against <base-ref> <committed|everything>
  local base="$1" mode="$2" mb
  SRC_TIP=$(tip "$base")
  mb=$(git merge-base "$base" HEAD 2>/dev/null); mb=${mb:0:9}
  [ -n "$mb" ] || { echo "No common history between $base and $BRANCH."
                    echo; echo "Press any key..."; read -rsn1; return 1; }
  if [ "$mode" = committed ]; then
    CHG_TIP=$(tip HEAD)
    launch "$base" "$BRANCH" \
      "commits on $BRANCH that $base does not have" \
      diff "$base...HEAD"
  else
    CHG_TIP="the files as they sit on disk right now"
    launch "$base" "$BRANCH plus my uncommitted changes" \
      "everything $BRANCH has since it left $base, committed or not" \
      diff "$mb"
  fi
}
local_only() {
  SRC_TIP=$(tip HEAD); CHG_TIP="the files as they sit on disk right now"
  launch "the newest commit on $BRANCH" "my uncommitted changes" \
    "edits I have made but not committed, staged or not" diff HEAD
}
one_commit() {  # one_commit <sha>
  SRC_TIP=$(tip "$1^" 2>/dev/null); CHG_TIP=$(tip "$1")
  launch "the commit just before $1" "commit $1" "what this one commit changed" \
    show "$1" -m --first-parent
}
auto() {  # fallback when there is no branch comparison to make; $1 says why
  local why="${1:-nothing new to compare against another branch}"
  if ! git diff --quiet || ! git diff --cached --quiet; then local_only
  else SRC_TIP=$(tip HEAD^ 2>/dev/null); CHG_TIP=$(tip HEAD)
       launch "$BRANCH one commit back" "$BRANCH at its newest commit" \
         "$why, and nothing is uncommitted, so here is that commit alone" \
         show HEAD -m --first-parent; fi
}

# ---- picker ---------------------------------------------------------------
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }
pick_ref() {  # pick_ref <prompt> -> a branch name
  git for-each-ref --sort=-committerdate --format='%(refname:short)' \
      refs/heads refs/remotes 2>/dev/null | grep -v '^origin/HEAD$' \
    | fzf --prompt="$1 > " --no-multi --cycle --preview-window='right,60%' \
          --preview='git log --oneline --decorate --color=always -20 {}'
}
pick_commit() {  # pick_commit -> a short sha
  git log --oneline --decorate --color=always -300 2>/dev/null \
    | fzf --ansi --prompt="commit > " --no-multi --cycle --preview-window='right,60%' \
          --preview='git show --stat --color=always {1}' \
    | strip_ansi | awk '{print $1}'
}
pick() {
  command -v fzf >/dev/null 2>&1 || { echo "fzf is not installed."; echo; auto; return; }
  local dev def choice a b
  dev=$(dev_ref); def=$(default_ref)
  local -a rows=()
  row() { rows+=("$(printf '%s\t%-24s ==>  %-30s %s' "$1" "$2" "$3" "$4")"); }
  [ -n "$dev" ] && [ "$dev" != "$BRANCH" ] && {
    row dev-committed  "$dev" "$BRANCH"                "committed work only"
    row dev-everything "$dev" "$BRANCH + uncommitted"  "committed work plus what is not committed"; }
  [ -n "$def" ] && [ "$def" != "$BRANCH" ] && [ "$def" != "$dev" ] && {
    row def-committed  "$def" "$BRANCH"                "committed work only"
    row def-everything "$def" "$BRANCH + uncommitted"  "committed work plus what is not committed"; }
  row local  "HEAD"        "my uncommitted work" "staged and unstaged changes only"
  row commit "its parent"  "one commit"          "pick a commit from this branch's history"
  row branch "any branch"  "any branch"          "pick the source, then the branch to compare"
  choice=$(printf '%s\n' "${rows[@]}" \
    | fzf --delimiter=$'\t' --with-nth=2.. --no-multi --cycle \
          --prompt="diff > " --header="on $BRANCH   ·   source ==> change" \
    | cut -f1)
  case "$choice" in
    dev-committed)  against "$dev" committed ;;
    dev-everything) against "$dev" everything ;;
    def-committed)  against "$def" committed ;;
    def-everything) against "$def" everything ;;
    local)          local_only ;;
    commit)         a=$(pick_commit); [ -n "$a" ] && one_commit "$a" ;;
    branch)         a=$(pick_ref "source (compare against)") ; [ -z "$a" ] && exit 0
                    b=$(pick_ref "change (the new work)")    ; [ -z "$b" ] && exit 0
                    SRC_TIP=$(tip "$a"); CHG_TIP=$(tip "$b")
                    launch "$a" "$b" "commits on $b that $a does not have" diff "$a...$b" ;;
    *)              exit 0 ;;
  esac
}

# ---- entry ----------------------------------------------------------------
default_compare() {  # alt+f: the newest commit on this branch, against origin/dev
  local base; base=$(dev_ref) || base=$(default_ref)
  # Only when this checkout IS the base branch is there nothing to compare.
  if [ -z "$base" ] || [ "$base" = "$BRANCH" ] || [ "origin/$BRANCH" = "$base" ]; then
    auto "$BRANCH is the branch everything else compares against"; return; fi
  against "$base" committed
}
case "${1:-}" in
  "")   default_compare ;;
  pick) pick ;;
  auto) auto ;;
  *)    echo "usage: spechub-diff [pick|auto]"; exit 2 ;;
esac
H
  chmod +x "$BIN/spechub-diff"

  cat > "$BIN/spechub-dash" <<'H'
#!/usr/bin/env bash
# gh-dash with a section for the repo you are standing in. Installed by spechub.
set -uo pipefail
# Every action gh-dash takes shells out to gh and discards its stderr, so a
# refusal from GitHub reaches you as "exit status 1" for two seconds. spechub-gh
# goes in front of the real gh under that name and speaks the refusal aloud.
# Its directory holds nothing else, so nothing else on PATH is shadowed.
SHIM="$(mktemp -d)"; GEN=""
trap 'rm -rf "$SHIM"; rm -f "$GEN"' EXIT
ln -s "$(command -v spechub-gh)" "$SHIM/gh" 2>/dev/null && export PATH="$SHIM:$PATH"
BASE="$HOME/.config/gh-dash/config.yml"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
# Not exec, so the trap above still gets to clean up after the dashboard.
[ -z "$REPO" ] && { gh dash "$@"; exit $?; }
GEN="$(mktemp)"
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

  cat > "$BIN/spechub-gh" <<'H'
#!/usr/bin/env bash
# gh, plus the reason a pull request action failed.
#
# gh-dash runs gh for everything it does to a pull request - approve, comment,
# merge - and throws the command's stderr away, so GitHub refusing one shows as
# "exit status 1" in the footer for two seconds and nothing else. Approving your
# own pull request is the everyday case: GitHub always refuses that, and the
# dashboard looks like it simply ignored the keypress.
#
# spechub-dash links this into a directory of its own at the front of $PATH
# under the name gh, so gh-dash finds it first. Everything is handed to the real
# gh untouched and its exit code is returned as-is; the only thing added is a
# notification when an action fails, because a suspended TUI cannot print for
# us. Installed by spechub.
set -uo pipefail

# The real gh is the first one on $PATH that is not this script under another
# name. Comparing what each resolves to sees through both the link spechub-dash
# makes and a plain copy of this file.
ME="$(readlink -f "$0")"
REAL=""
while IFS= read -r dir; do
  [ -n "$dir" ] && [ -x "$dir/gh" ] || continue
  [ "$(readlink -f "$dir/gh")" = "$ME" ] && continue
  REAL="$dir/gh"; break
done < <(printf '%s\n' "${PATH//:/$'\n'}")
[ -n "$REAL" ] || { echo "spechub-gh: no gh on \$PATH besides this shim" >&2; exit 127; }

# The dashboard is not an action: it owns the terminal for as long as it runs.
[ "${1:-}" = "dash" ] && exec "$REAL" "$@"

ERR="$(mktemp)"; trap 'rm -f "$ERR"' EXIT
"$REAL" "$@" 2>"$ERR"
RC=$?
cat "$ERR" >&2

# Only what a dashboard key fires. gh's own plumbing - repo view, api, auth -
# fails for reasons a notification cannot help with, and spechub-dash asks gh
# which repository this is before the dashboard has even started.
case "${1:-}" in pr|issue) ;; *) exit $RC ;; esac
[ "$RC" -eq 0 ] && exit 0

MSG="$(grep -v '^[[:space:]]*$' "$ERR" | head -3)"
[ -n "$MSG" ] || MSG="gh exited with status $RC"
command -v herdr >/dev/null 2>&1 \
  && herdr notification show "gh ${1:-} ${2:-} failed" --body "$MSG" >/dev/null 2>&1
exit $RC
H
  chmod +x "$BIN/spechub-gh"

  cat > "$BIN/spechub-md" <<'H'
#!/usr/bin/env bash
# Read a markdown file in the terminal with its mermaid diagrams drawn as text.
#
#   spechub-md FILE.md              render to the terminal
#   spechub-md --preview FILE.md    render into a preview pane: width from
#                                   $COLUMNS, straight to stdout, no pager
#   spechub-md --numbered FILE.md   the source instead, line numbers down the
#                                   left, for quoting a line back in a review
#   spechub-md --toggle-line-numbers  flip which of the two --preview shows
#   spechub-md --diagram N FILE.md  one diagram alone, with horizontal scroll
#   spechub-md --serve FILE.md      serve it for a real browser, print the link
#   spechub-md --html FILE.md       print that same page as one HTML document
#   spechub-md --browser FILE.md    open it in the browser you are sitting at
#
# While reading, b opens the page in that browser and # switches between the
# rendered document and its source with line numbers. $SPECHUB_MD_BROWSER_KEY
# and $SPECHUB_MD_LINE_NUMBERS_KEY move them.
#
# Text, not images, is deliberate: herdr emits the kitty graphics protocol and
# no terminal reachable from Windows or Android renders that, and e-ink panels
# render text far better than bitmaps anyway. Installed by spechub.
set -uo pipefail

PORT="${SPECHUB_MD_PORT:-6419}"
# Named rather than inherited from an ambient $AGENT_BROWSER_CDP, for the
# reason spechub-open gives at its own bridge branch: leaning on the ambient
# one launches a headless Chrome nobody can see and calls it success.
BRIDGE="${SPECHUB_BRIDGE_URL:-http://127.0.0.1:19988}"
OPENER="${SPECHUB_OPENER_URL:-http://127.0.0.1:19989}"
# The opener refuses anything without this, so its absence is the same as the
# opener being down - which is exactly how the route probe treats it.
OPENER_TOKEN="${XDG_CONFIG_HOME:-$HOME/.config}/spechub/opener.token"
SERVE=0; ONLY=0; PREVIEW=0; HTML=0; BROWSER=0; NUMBERED=0; TOGGLE=0
usage() { echo "usage: spechub-md [--preview] [--numbered] [--toggle-line-numbers] [--diagram N] [--serve|--html|--browser] FILE.md" >&2; exit 1; }
# The preview pane and the key that flips it are two processes that never meet,
# so the choice between the rendered view and the source lives in a file both
# of them can find. One name, defined once, is what keeps them agreeing.
LINE_NUMBER_FLAG="${XDG_STATE_HOME:-$HOME/.local/state}/spechub/md-line-numbers"
# A loop rather than a fixed order, so --preview composes with --diagram and
# a caller can pass them either way round.
while [ $# -gt 0 ]; do
  case "$1" in
    --serve)   SERVE=1; shift ;;
    --html)    HTML=1; shift ;;
    --browser) BROWSER=1; shift ;;
    --preview) PREVIEW=1; shift ;;
    --numbered) NUMBERED=1; shift ;;
    --toggle-line-numbers) TOGGLE=1; shift ;;
    --diagram) ONLY="${2:-1}"; shift; [ $# -gt 0 ] && shift ;;
    --)        shift; break ;;
    --*)       usage ;;
    *)         break ;;
  esac
done
# The toggle names no file: it changes what the next preview will draw and has
# nothing to draw itself. So it answers here, before the file check below.
if [ "$TOGGLE" = "1" ]; then
  if [ -e "$LINE_NUMBER_FLAG" ]; then
    rm -f "$LINE_NUMBER_FLAG"
    echo "spechub-md: markdown previews render again"
  else
    # A machine that has never had a state directory is every machine the
    # first time, so make it rather than fail on it.
    mkdir -p "$(dirname "$LINE_NUMBER_FLAG")" && : > "$LINE_NUMBER_FLAG" \
      || { echo "spechub-md: could not write $LINE_NUMBER_FLAG" >&2; exit 1; }
    echo "spechub-md: markdown previews show source with line numbers"
  fi
  exit 0
fi
# --preview, --serve and --html are three answers to the same question - where
# does this end up - so at most one can be true. A preview pane is somewhere to
# read, not somewhere to run a server or hand a document out of.
if [ $((SERVE + PREVIEW + HTML + BROWSER)) -gt 1 ]; then
  echo "spechub-md: --preview, --serve, --html and --browser do different things - pick one" >&2
  exit 1
fi
# --numbered answers a different question - which of the two views - so it
# composes with --preview and with nothing else. The others all want the
# rendered document, and numbered source is not one.
if [ "$NUMBERED" = "1" ] && [ $((SERVE + HTML + BROWSER)) -gt 0 ]; then
  echo "spechub-md: --numbered prints the source, so --serve, --html and --browser have nothing to render" >&2
  exit 1
fi
# The flag is what the file manager's key flips, and the pane is the only
# place it applies: every other route was asked for a rendered document by
# name, and the opener menu lists the numbered read as its own entry.
#
# --diagram is the exception the pane itself holds. It names one drawing to
# show, which is a different question from which of the two views the pane is
# on, and a reader who left the flag set and then asked for a diagram still
# wants the diagram. So an explicit --diagram outranks the flag. An explicit
# --numbered still wins over it, for the same reason in the other direction.
if [ "$PREVIEW" = "1" ] && [ "$ONLY" = "0" ] && [ -e "$LINE_NUMBER_FLAG" ]; then NUMBERED=1; fi
# Node labels set a diagram's width, so padding cannot rescue a wide one.
# Tightening still buys roughly a third of the height back.
PAD="${SPECHUB_MD_PAD:--x 2 -y 2}"
# A caller that exports COLUMNS means it, so it wins outright. tput reads
# COLUMNS too, ahead of terminfo, but that is a side effect worth naming
# rather than resting on - it goes when TERM is unset and tput fails.
case "${COLUMNS:-}" in
  ''|*[!0-9]*) COLS=$(tput cols 2>/dev/null || echo 80) ;;
  *)           COLS="$COLUMNS" ;;
esac
[ "$COLS" -gt 0 ] 2>/dev/null || COLS=80
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || usage
# One place to clean up, so no exit path leaks a temp file.
trap "rm -f /tmp/spechub-md.$$.md /tmp/spechub-md-out.$$.md /tmp/spechub-md-art.$$.* /tmp/spechub-md-keys.$$" EXIT

# Wanting a document in a browser happens while reading it, so the key belongs
# in the pager rather than before or after one.
#
# less has no action that runs a fixed command, and its one shell escape
# expands % to the file it was handed - which here is the rendered temp copy,
# not the markdown someone asked for. So the key quits instead: lesskey's quit
# action takes the first character of its extra string as the exit status, and
# "A" is 65, a value less never returns of its own accord. Nothing has to be
# passed through the binding, because this script already knows the file.
BROWSE_STATUS=65
BROWSE_KEY="${SPECHUB_MD_BROWSER_KEY:-b}"
# The same trick a second time, for the other thing a reader wants mid-document.
# Wanting a line number happens while reading too - that is the moment you are
# about to quote one - and by then the file list with its own binding is not in
# front of you. So the key means the same thing in both places.
NUMBER_STATUS=66
NUMBER_KEY="${SPECHUB_MD_LINE_NUMBERS_KEY:-#}"
KEYS="/tmp/spechub-md-keys.$$"

# A preview pane cannot page, so the same render goes straight to stdout.
emit() {
  local f="$1" nk rc; shift
  if [ "$PREVIEW" = "1" ]; then cat "$f"; return; fi
  # The binding is a less feature, so only less is handed it. Setting
  # LESSKEYIN for a pager that never reads it is at best noise, and acting on
  # an exit status that pager chose for its own reasons is a bug waiting.
  case "${1:-}" in
    less|*/less)
      # b is back-a-page in less. ^B and PageUp both still do that, so this
      # costs nothing (measured). LESSKEYIN wants less 582 or newer; older
      # versions ignore it and quietly keep b as it was.
      #
      # lesskey reads a line starting with # as a comment, so the key that
      # means line numbers has to be escaped or the binding is silently
      # dropped and the key does nothing but ring the bell - measured on less
      # 590, and how this arrived as a bug report. Only a leading # needs it:
      # backslash means something of its own to lesskey, and \b would bind
      # backspace rather than the letter.
      case "$NUMBER_KEY" in
        '#'*) nk="\\$NUMBER_KEY" ;;
        *)    nk="$NUMBER_KEY" ;;
      esac
      { printf '#command\n'
        printf '%s quit A\n' "$BROWSE_KEY"
        printf '%s quit B\n' "$nk"
      } > "$KEYS"
      LESSKEYIN="$KEYS" "$@" "$f"
      rc=$?
      if [ "$rc" = "$BROWSE_STATUS" ]; then
        "$0" --browser "$FILE"
        exit $?
      fi
      if [ "$rc" = "$NUMBER_STATUS" ]; then
        # One key, both directions: the view you are not in is the one it
        # takes you to. $FILE is the markdown throughout, never the rendered
        # temp copy, so either re-read starts from the source again.
        if [ "$NUMBERED" = "1" ]; then "$0" "$FILE"; else "$0" --numbered "$FILE"; fi
        exit $?
      fi
      ;;
    *) "$@" "$f" ;;
  esac
}

# A wide diagram left a marker behind rather than art glow would wrap. Turn
# the marker into a line a person can read and put the drawing back under it.
# Both output paths run this: without it the marker reaches the reader raw.
splice() {
  SPECHUB_PID=$$ SPECHUB_PREVIEW="$PREVIEW" python3 - "$1" <<'PY'
import os, pathlib, re, sys
f = pathlib.Path(sys.argv[1])
pid = os.environ["SPECHUB_PID"]
preview = os.environ.get("SPECHUB_PREVIEW") == "1"
lines = []
for line in f.read_text().split("\n"):
    m = re.search(r"\x00SPECHUBART(\d+)\x00", line)
    if not m:
        lines.append(line); continue
    art = pathlib.Path(f"/tmp/spechub-md-art.{pid}.{m.group(1)}")
    lines.append(re.sub(r"\x00SPECHUBART\d+\x00", f"Diagram {m.group(1)}:", line))
    if art.exists():
        # Art too wide for the pane would spill past it, so a preview pane
        # keeps the placeholder and leaves the drawing to a full-width read.
        if not preview:
            lines.extend("  " + l for l in art.read_text().splitlines())
        art.unlink()
f.write_text("\n".join(lines) + "\n")
PY
}

# Rendered markdown has no line numbers, and a reader who wants to quote a
# line back in a review needs the file's own. The gutter is as wide as the
# largest number in it, so the source stays on one column whatever the length.
numbered() {  # numbered <file> -> stdout
  local total width avail
  total=$(awk 'END { print NR }' "$1")
  width=${#total}
  [ "$width" -lt 3 ] && width=3
  if [ "$PREVIEW" = "1" ]; then
    # A wrapped line makes the gutter lie about which source line you are
    # looking at, and a pane has no arrow keys to pan with, so it chops.
    avail=$((COLS - width - 2))
    [ "$avail" -lt 1 ] && avail=1
    awk -v w="$width" -v a="$avail" \
      '{ printf "%" w "d  %s\n", NR, substr($0, 1, a) }' "$1"
  else
    awk -v w="$width" '{ printf "%" w "d  %s\n", NR, $0 }' "$1"
  fi
}

if [ "$NUMBERED" = "1" ]; then
  numbered "$FILE" > /tmp/spechub-md.$$.md
  # -S chops rather than wraps, so the arrow keys pan across a long line
  # instead of the gutter losing its column. emit sends a pane straight to
  # stdout and keeps the browser key working in the pager, both unchanged.
  emit /tmp/spechub-md.$$.md less -SR
  exit 0
fi

# --browser names a destination rather than a rendering: work out where the
# browser actually is, then pick the delivery that reaches it. spechub-open
# already answers that question for URLs, so ask it rather than deciding the
# same thing twice and drifting from it later.
if [ "$BROWSER" = "1" ]; then
  case "$(command -v spechub-open >/dev/null 2>&1 && spechub-open --why 2>/dev/null)" in
    opener)
      # The opener stores the document on the laptop and serves it to the
      # browser there, so the page still works once this machine stops
      # answering - and a re-render of the same file updates the tab already
      # showing it instead of stacking up a second one. That reuse is why the
      # key has to be stable per file: it is the absolute path, hex-encoded
      # because a path may hold anything a URL cannot.
      tok=$(cat "$OPENER_TOKEN" 2>/dev/null || true)
      if [ -z "$tok" ]; then
        echo "spechub-md: no opener token at $OPENER_TOKEN." >&2
        echo "  run register-tasks.ps1 on the laptop to install one." >&2
        exit 1
      fi
      hex() { od -An -v -tx1 | tr -d ' \n'; }
      key=$(printf '%s' "$(cd "$(dirname "$FILE")" && pwd -P)/$(basename "$FILE")" | hex)
      name=$(basename "$FILE")
      # Vendored mermaid, uploaded once so diagrams draw without reaching a
      # CDN. Best effort throughout: the opener redirects to the CDN when it
      # has no copy, so a failure here costs nothing but an outbound fetch.
      vendored="$HOME/.local/share/spechub/mermaid.min.js"
      # tr, because whitespace inside JSON carries no meaning and a match that
      # depends on its absence is a match waiting to break. Same reasoning as
      # spechub-open's /json/list check.
      if [ -s "$vendored" ] && ! curl -fsS -m 3 -H "X-Spechub-Token: $tok" \
           "$OPENER/health" 2>/dev/null | tr -d '[:space:]' | grep -q '"mermaid":true'; then
        curl -fsS -m 60 -X POST -H "X-Spechub-Token: $tok" \
          --data-binary "@$vendored" "$OPENER/asset/mermaid.js" >/dev/null 2>&1 || true
      fi
      # The opener answers with what it did, and that answer is what success
      # means - it says whether a tab was opened or a live one reused. An exit
      # status of 0 is not a page that arrived.
      answer=$(SPECHUB_MD_OPENER=1 "$0" --html "$FILE" \
        | curl -fsS -m 60 -X POST -H "X-Spechub-Token: $tok" \
            -H 'Content-Type: text/html; charset=utf-8' --data-binary @- \
            "$OPENER/doc?key=$key&title=$(printf '%s' "$name" | hex)" 2>/dev/null \
        | tr -d '[:space:]')
      case "$answer" in
        *'"reused":true'*)
          printf '%s updated in the tab already open on your machine\n' "$name" >&2
          exit 0 ;;
        *'"opened":true'*)
          printf '%s is on screen in the browser on your machine\n' "$name" >&2
          exit 0 ;;
      esac
      echo "spechub-md: the opener did not confirm the page reached a browser." >&2
      echo "  check it is up:  spechub-open --why" >&2
      exit 1
      ;;
    bridge)
      # Under `herdr --remote` the tunnel runs laptop-to-here, so nothing over
      # there can open a port on this machine and a link to localhost:6419
      # names the wrong localhost. Hand the whole document down the CDP link
      # that is already open instead, and let Chrome hold it. That is also why
      # --html exists: a document travels, a port does not.
      #
      # $0 is the path bash resolved this script to - absolute when it came off
      # PATH - so the page pushed is the one --html renders, not a second copy
      # of the renderer that can disagree with it.
      html=$("$0" --html "$FILE") || exit 1
      # base64 because the document is full of quotes and newlines and has to
      # survive being a JavaScript string literal. tr rather than `base64 -w0`,
      # which is GNU-only.
      payload=$(printf '%s' "$html" | base64 | tr -d '\n')
      # A tab of its own, and never over a page that is already there. The
      # extension attaches per tab through chrome.debugger, and rewriting a
      # real document detaches it - measured: pushing over an https page left
      # /json/list empty and the bridge unusable until it was armed again by
      # hand. A fresh about:blank tab survives the same rewrite, because the
      # document being replaced has the same origin. So the armed tab is left
      # exactly as it was, and this writes into a new one.
      #
      # The default session deliberately, as spechub-open explains: the relay
      # takes one CDP client at a time, so a session of our own could not
      # connect while an agent holds it.
      #
      # The last expression is the page title, so the browser answers with
      # what it is now holding. That answer is what success means here - a
      # command that exited 0 is not a page that arrived.
      name=$(basename "$FILE")
      timeout 20 agent-browser --cdp "$BRIDGE" tab new >/dev/null 2>&1
      landed=$(printf 'const b64="%s";const doc=new TextDecoder().decode(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)));document.open();document.write(doc);document.close();document.title;\n' \
                 "$payload" \
                 | timeout 60 agent-browser --cdp "$BRIDGE" eval --stdin 2>/dev/null)
      # Writing into the tab is only half of it. A tab created over CDP is
      # created in the background, so it has to be brought forward or the page
      # is real, correct, and never seen - which is exactly how this first went
      # wrong. agent-browser carries Page.bringToFront on its tab switch, so
      # switch to the tab just written into, which is the one it already has
      # selected. Best effort: a page in a background tab still beats an error.
      # The arrow marks the active tab, which is the one just written into.
      # Taking the first line instead would raise whatever sits at index 0 -
      # somebody else's tab, and the page still unseen.
      idx=$(timeout 20 agent-browser --cdp "$BRIDGE" tab list 2>/dev/null \
              | grep -m1 -- "$(printf '\342\206\222')" \
              | sed -n 's/.*\[\([0-9][0-9]*\)\].*/\1/p')
      [ -n "$idx" ] && timeout 20 agent-browser --cdp "$BRIDGE" tab "$idx" >/dev/null 2>&1
      case "$landed" in
        *"$name"*)
          printf '%s is on screen in the browser on your machine\n' "$name" >&2
          exit 0 ;;
      esac
      # Serving instead would print a link the laptop resolves to its own
      # localhost, which is a wrong answer dressed as a working one.
      echo "spechub-md: the bridge answered but is not holding the page." >&2
      echo "  the document goes to the tab the Playwriter extension is armed on." >&2
      echo "  check something is still armed:  spechub-open --why" >&2
      exit 1
      ;;
  esac
  # Every other route has a browser that can reach this machine's ports, or a
  # terminal that can hand someone a link. Serving is already exactly that.
  SERVE=1
fi

if [ "$SERVE" = "1" ] || [ "$HTML" = "1" ]; then
  # One program, two ways out: --serve keeps answering with the document,
  # --html hands it over once and stops. Same renderer either way, so the two
  # cannot drift into disagreeing about what the page looks like.
  MODE=serve; NAME=spechub-md-serve
  if [ "$HTML" = "1" ]; then MODE=html; NAME=spechub-md-html; fi
  # A document bound for the opener on the laptop is handed over once, like
  # --html, but it does end up behind a server - the opener's. So it wants the
  # relative mermaid src that --html cannot use. Internal: set by the --browser
  # dispatch below, never by a caller.
  if [ "${SPECHUB_MD_OPENER:-0}" = "1" ] && [ "$HTML" = "1" ]; then MODE=opener; fi
  # exec -a names the process. Without it a running server is just "python3 -"
  # and there is nothing sensible to pkill.
  exec -a "$NAME" python3 - "$FILE" "$PORT" "$MODE" <<'PY'
import html, http.server, pathlib, re, socketserver, sys
try:
    import markdown
except ImportError:
    sys.exit("spechub-md: needs the python markdown package: pip install --user markdown")

src, port, MODE = pathlib.Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
VENDOR = pathlib.Path.home() / ".local/share/spechub/mermaid.min.js"

CSS = """*{box-sizing:border-box}body{max-width:54rem;margin:0 auto;padding:2rem 1.25rem;
font:16px/1.65 -apple-system,Segoe UI,system-ui,sans-serif;color:#1a1a1a;background:#fff}
h1,h2,h3{line-height:1.25;margin:2rem 0 .75rem}h1{font-size:1.9rem}h2{font-size:1.45rem}
code{font:14px/1.5 ui-monospace,Consolas,monospace;background:#f2f2f2;padding:.15em .35em;border-radius:3px}
pre{background:#f7f7f7;padding:1rem;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}
pre.mermaid{background:none;text-align:center}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
blockquote{margin:1rem 0;padding:.1rem 1rem;border-left:3px solid #ccc;color:#555}
img{max-width:100%}
@media(prefers-color-scheme:dark){body{background:#151515;color:#e6e6e6}
code{background:#242424}pre{background:#1d1d1d}th,td{border-color:#333}
blockquote{border-color:#444;color:#aaa}}"""

def render():
    body = markdown.markdown(src.read_text(),
        extensions=["fenced_code", "tables", "toc", "sane_lists"])
    # mermaid.js wants <pre class="mermaid">, not a highlighted code block.
    body = re.sub(r'<pre><code class="language-mermaid">(.*?)</code></pre>',
                  lambda m: '<pre class="mermaid">' + html.unescape(m.group(1)) + "</pre>",
                  body, flags=re.S)
    # --serve answers for /mermaid.js itself off the vendored copy. A document
    # standing on its own has no server behind it, so a relative src would be
    # fetched from whatever host the page ended up on and find nothing there -
    # it names the CDN instead. Inlining the vendored 3.5MB would make the page
    # offline-proof and far too big to push through a CDP payload, which is the
    # whole reason --html exists.
    # The opener serves the page from the laptop and answers /mermaid.js off
    # the copy this machine uploaded to it - falling back to the CDN itself if
    # it has none. So a relative src is right there too, and unlike --serve it
    # does not depend on this machine having vendored anything.
    js = ('<script src="/mermaid.js"></script>'
          if MODE == "opener" or (MODE == "serve" and VENDOR.exists()) else
          '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>')
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(src.name)}</title><style>{CSS}</style></head><body>
{body}
{js}
<script>mermaid.initialize({{startOnLoad:true,securityLevel:"loose",
theme:matchMedia("(prefers-color-scheme:dark)").matches?"dark":"default"}});</script>
</body></html>""".encode()

# Out before the port is ever looked at: a document is not a server, and a
# caller that only wants the page must not be stopped by a busy 6419.
if MODE in ("html", "opener"):
    sys.stdout.buffer.write(render())
    raise SystemExit

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/mermaid.js" and VENDOR.exists():
            body, ctype = VENDOR.read_bytes(), "application/javascript"
        else:
            body, ctype = render(), "text/html; charset=utf-8"   # re-read: edits show on reload
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

socketserver.TCPServer.allow_reuse_address = True
def holder(port):
    """pid and command line of whatever is listening, best effort."""
    import subprocess
    try:
        out = subprocess.run(["ss", "-ltnpH", f"sport = :{port}"],
                             capture_output=True, text=True, timeout=3).stdout
        pid = re.search(r"pid=(\d+)", out)
        if not pid:
            return None, None
        pid = pid.group(1)
        cmd = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
        return pid, cmd.strip()
    except Exception:
        return None, None

try:
    srv = socketserver.TCPServer(("127.0.0.1", port), H)
except OSError as e:
    pid, cmd = holder(port)
    msg = [f"port {port} is busy: {e}"]
    if pid:
        mine = "spechub-md-serve" in cmd or "spechub-md" in cmd
        msg.append(f"  held by pid {pid}: {cmd[:90]}")
        msg.append(f"  stop it with:  kill {pid}" if mine else
                   f"  not spechub-md. use another port:  SPECHUB_MD_PORT=<n> spechub-md --serve ...")
    else:
        msg.append("  could not identify the holder. try:  ss -ltnp | grep " + str(port))
    sys.exit("\n".join(msg))
url = f"http://localhost:{port}"
# OSC 8 makes it ctrl+clickable; the bare URL below covers terminals without it.
sys.stderr.write(f"\033]8;;{url}\033\\{src.name}\033]8;;\033\\  {url}\n")
sys.stderr.write("  reload the page after editing. ctrl+C to stop.\n")
if not VENDOR.exists():
    sys.stderr.write("  note: mermaid.js not vendored, falling back to CDN\n")
try: srv.serve_forever()
except KeyboardInterrupt: pass
PY
fi


# Terminal render: swap each mermaid fence for its text drawing, then page it.
SPECHUB_COLS="$COLS" SPECHUB_PAD="$PAD" SPECHUB_ONLY="$ONLY" SPECHUB_RUN="$$" \
SPECHUB_PREVIEW="$PREVIEW" \
python3 - "$FILE" <<'PY' > /tmp/spechub-md.$$.md 2>/dev/null
import os, pathlib, re, shlex, shutil, subprocess, sys, tempfile
text = pathlib.Path(sys.argv[1]).read_text()
# "$HOME/..." rather than the absolute path: shorter, and unlike ~'/x y'
# it expands correctly when the path contains spaces.
_raw = sys.argv[1]
_home = str(pathlib.Path.home())
SELF = ('"$HOME' + _raw[len(_home):].replace('"', '\\"') + '"'
        if _raw.startswith(_home) else shlex.quote(_raw))
have = shutil.which("mermaid-ascii")
COLS = int(os.environ.get("SPECHUB_COLS") or 80)
PAD = (os.environ.get("SPECHUB_PAD") or "").split()
ONLY = int(os.environ.get("SPECHUB_ONLY") or 0)
PREVIEW = os.environ.get("SPECHUB_PREVIEW") == "1"
# glow indents and pads a fenced block, so the art has less room than the pane.
BUDGET = max(20, COLS - 6)
seen = 0

# mermaid-ascii understands `graph`/`flowchart` with [square] nodes. It draws
# styling directives as if they were nodes, and leaks any other shape syntax
# into the label, so both are normalised away before it sees the source.
DROP = re.compile(r"^\s*(style|classDef|class|linkStyle|click|%%)\b")
SHAPES = [
    (re.compile(r"(\w+)\{\{(.+?)\}\}"), r"\1[\2]"),   # {{hexagon}}
    (re.compile(r"(\w+)\(\((.+?)\)\)"), r"\1[\2]"),   # ((circle))
    (re.compile(r"(\w+)\(\[(.+?)\]\)"), r"\1[\2]"),   # ([stadium])
    (re.compile(r"(\w+)\[\((.+?)\)\]"), r"\1[\2]"),   # [(database)]
    (re.compile(r"(\w+)\{(.+?)\}"),     r"\1[\2]"),   # {decision}
    (re.compile(r"(\w+)\((.+?)\)"),     r"\1[\2]"),   # (rounded)
]

def to_ascii(src):
    if not have:
        return None, "mermaid-ascii not installed"
    body = "\n".join(l for l in src.splitlines() if not DROP.match(l))
    for pat, rep in SHAPES:
        body = pat.sub(rep, body)
    if not re.match(r"\s*(graph|flowchart|sequenceDiagram)\b", body):
        kind = (body.strip().split(None, 1) or ["?"])[0]
        return None, f"{kind} diagrams are not supported by mermaid-ascii"
    with tempfile.NamedTemporaryFile("w", suffix=".mmd", delete=False) as f:
        f.write(body); path = f.name
    # mermaid-ascii reads a file, not stdin. A preview redraws on every cursor
    # move, so a file left behind here fills /tmp at cursor speed.
    try:
        r = subprocess.run(["mermaid-ascii", "--file", path] + PAD,
                           capture_output=True, text=True)
    finally:
        os.unlink(path)
    if r.returncode != 0 or not r.stdout.strip():
        return None, (r.stderr.strip().splitlines() or ["could not draw it"])[0]
    return r.stdout.rstrip("\n"), None

def repl(m):
    global seen
    seen += 1
    n = seen
    art, err = to_ascii(m.group(1))
    if not art:
        # Keep the source visible rather than swallowing the diagram.
        return (f"\n```\nDiagram {n} not drawn: {err}\n```\n\n"
                f"```\n{m.group(1).rstrip()}\n```")
    lines = art.splitlines()
    width = max((len(l) for l in lines), default=0)
    if ONLY:
        # Raw, unwrapped, for a pager that can scroll sideways.
        return "\0DIAGRAM%d\0%s\0" % (n, art) if n == ONLY else ""
    if width > BUDGET:
        # glow wraps whatever it renders, and wrapped box-drawing art is
        # noise. Emit a marker instead and splice the raw art back in after
        # glow has run, so prose wraps to the pane and the diagram does not.
        run = os.environ.get("SPECHUB_RUN") or str(os.getpid())
        # /tmp, not gettempdir(): the shell trap and the splicer both look
        # there, and a stray $TMPDIR would hide the art from either.
        art_path = pathlib.Path(f"/tmp/spechub-md-art.{run}.{n}")
        art_path.write_text(art + "\n")
        # The arrow keys belong to the pager. A preview pane has none, and
        # opening the file is what draws the diagram there.
        hint = "open it full width" if PREVIEW else "pans sideways with the arrow keys"
        return f"\n```\n\x00SPECHUBART{n}\x00 {width} cols, {hint}\n```"
    return "```\n" + art + "\n```"

out = re.sub(r"```mermaid\n(.*?)```", repl, text, flags=re.S)
if ONLY:
    hit = re.search(r"\0DIAGRAM(\d+)\0(.*?)\0", out, re.S)
    sys.stdout.write(hit.group(2) if hit else f"no diagram {ONLY} in this file\n")
else:
    sys.stdout.write(out)
PY

if [ "$ONLY" != "0" ]; then
  # -S chops instead of wrapping: arrow keys scroll sideways.
  emit /tmp/spechub-md.$$.md less -SR
elif command -v glow >/dev/null 2>&1; then
  # glow drops all styling when stdout is not a terminal, and its output has
  # to be captured to splice the diagrams into, so it runs under a pty.
  SPECHUB_COLS="$COLS" SPECHUB_STYLE="${SPECHUB_MD_STYLE:-}" \
    python3 - /tmp/spechub-md.$$.md /tmp/spechub-md-out.$$.md <<'PY'
import fcntl, os, pathlib, pty, re, struct, subprocess, sys, termios
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
cols = int(os.environ.get("SPECHUB_COLS") or 80)
# Leave glow on "auto": under a pty it picks its full palette. Pinning a
# named style here gives a noticeably flatter one.
style = os.environ.get("SPECHUB_STYLE") or ""

cmd = ["glow", "-w", str(cols - 2)] + (["--style", style] if style else []) + [str(src)]
master, slave = pty.openpty()
# glow reads the width from the pty, not just -w, so set it to match.
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 200, min(cols, 65535), 0, 0))
proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.DEVNULL)
os.close(slave)
chunks = []
while True:
    try:
        b = os.read(master, 65536)
    except OSError:
        break
    if not b:
        break
    chunks.append(b)
os.close(master); proc.wait()
raw = b"".join(chunks)
text = raw.decode("utf-8", "replace").replace("\r\n", "\n")
# A pty makes glow probe the terminal for its background colour. Those replies
# are meant for a real terminal, not a file, so drop them.
text = re.sub(r"\x1b\][01][01];\?(\x07|\x1b\\)", "", text)
text = re.sub(r"\x1b\[6n", "", text)
dst.write_text(text)
PY
  splice /tmp/spechub-md-out.$$.md
  emit /tmp/spechub-md-out.$$.md ${PAGER:-less -SR}
else
  splice /tmp/spechub-md.$$.md
  emit /tmp/spechub-md.$$.md ${PAGER:-less -R}
fi
H
  chmod +x "$BIN/spechub-md"

  cat > "$BIN/spechub-view" <<'H'
#!/usr/bin/env bash
# View one file, picked by what the file is.
#
#   spechub-view README.md      rendered markdown, mermaid diagrams included
#   spechub-view src/main.rs    yazi, opened with the cursor on that file
#
# tuicr's <leader>v hands us the file under its cursor. Everything this
# dispatches to is a terminal program, so `q` hands the screen back to tuicr
# the same way a terminal editor does - which is the whole reason the choice
# lives in a script rather than in tuicr: changing it is an edit, not a
# rebuild.
# Installed by spechub.
set -uo pipefail

FILE="${1:-}"
[ -n "$FILE" ] || { echo "usage: spechub-view <file>" >&2; exit 2; }
[ -e "$FILE" ] || { echo "spechub-view: no such file: $FILE" >&2; exit 1; }

# Markdown is worth rendering rather than listing: spechub-md draws mermaid
# diagrams as text, and offers --serve for a browser when a diagram needs to
# be rendered properly.
case "$FILE" in
  *.md|*.MD|*.markdown|*.Markdown|*.mdown|*.mkd)
    command -v spechub-md >/dev/null 2>&1 && exec spechub-md "$FILE"
    ;;
esac

# yazi opens on the file's own directory with the cursor on it, so the preview
# pane shows the file and the tree is right there to move around in.
command -v yazi >/dev/null 2>&1 && exec yazi "$FILE"

# Neither installed: a pager still beats nothing, and -R keeps any colour.
exec ${PAGER:-less -R} "$FILE"
H
  chmod +x "$BIN/spechub-view"

  cat > "$BIN/spechub-herdr-tab" <<'H'
#!/usr/bin/env bash
# Run a command in a new herdr tab, beside the pane the key was pressed in.
#
#   spechub-herdr-tab <label> <command> [args...]
#
# herdr has no type = "tab" custom command, and its tab.create API launches a
# shell rather than a command, so the tab is created first and the command
# sent into it with `herdr pane run`.
#
# The target comes from `herdr pane current`, not from HERDR_* variables: a
# type = "shell" binding runs detached with none of them set, and reading the
# environment sent every one of these commands off to run with no terminal.
# Asked without that environment, herdr reports the focused pane, which is
# exactly the one the key was pressed in. Installed by spechub.
set -uo pipefail

label="${1:?usage: spechub-herdr-tab <label> <command> [args...]}"; shift
[ $# -gt 0 ] || { echo "spechub-herdr-tab: no command given" >&2; exit 1; }

command -v herdr >/dev/null 2>&1 || exec "$@"

cur=$(herdr pane current 2>/dev/null) || exec "$@"
read -r ws cwd <<<"$(printf '%s' "$cur" | python3 -c '
import json, sys
p = json.load(sys.stdin).get("result", {}).get("pane", {})
print(p.get("workspace_id") or "", p.get("foreground_cwd") or p.get("cwd") or "")
' 2>/dev/null)"
[ -n "${ws:-}" ] || exec "$@"

resp=$(herdr tab create --workspace "$ws" ${cwd:+--cwd "$cwd"} --label "$label" --focus 2>/dev/null) \
  || exec "$@"
pane=$(printf '%s' "$resp" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])' 2>/dev/null)
[ -n "$pane" ] || exec "$@"

# herdr hosts a type = "shell" command in a real pane for as long as the
# process lives, so anything slow here shows up as a stray terminal in the
# current tab. Hand the wait to a detached child and return immediately: the
# host pane then lasts only as long as the tab.create call.
#
# The settle is because the new tab's shell may not have drawn its prompt yet.
# The pty buffers input, so it is belt and braces, not a correctness need.
( sleep 0.3; herdr pane run "$pane" "$*" >/dev/null 2>&1 ) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
H
  chmod +x "$BIN/spechub-herdr-tab"

  cat > "$BIN/spechub-herdr-renumber" <<'H'
#!/usr/bin/env python3
"""Make the herdr sidebar numbers match prefix+1..9.

herdr draws a workspace's position in its stored list, but prefix+N targets the
row's position in the grouped sidebar, where worktrees sit indented under their
parent repo. The two agree until you create or tear down a worktree: new ones
append to the end of the list but appear mid-sidebar under their parent, so the
numbers you read stop being the numbers you press.

This rewrites the stored order to match the grouped order, so both agree again.
Run it after adding or removing a worktree. Safe to run repeatedly. Installed
by spechub.
"""
import json
import os
import socket
import sys


def socket_path():
    override = os.environ.get("HERDR_SOCKET_PATH")
    if override:
        return override
    config = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(config, "herdr", "herdr.sock")


def call(method, params=None):
    try:
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(socket_path())
    except OSError as err:
        sys.exit(f"spechub-herdr-renumber: no herdr server at {socket_path()} ({err})")
    with conn:
        conn.sendall((json.dumps({"id": "renumber", "method": method,
                                  "params": params or {}}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
    lines = buf.decode().strip().splitlines()
    if not lines:
        sys.exit(f"spechub-herdr-renumber: herdr closed the connection during {method}")
    reply = json.loads(lines[0])
    if "error" in reply:
        sys.exit(f"spechub-herdr-renumber: {method} failed: {reply['error']}")
    return reply


def workspaces():
    return call("workspace.list")["result"]["workspaces"]


def grouped_order(spaces):
    """The order the sidebar draws: every repo's rows contiguous, the repo
    checkout above the worktrees indented under it, stored order within each
    of those two parts. A group sits where its repo checkout sits, not where
    its first row happens to sit, so a worktree cannot drag its parent up."""
    groups, anchors = {}, {}
    for position, space in enumerate(spaces):
        tree = space.get("worktree") or {}
        root = tree.get("repo_root") or space["workspace_id"]
        groups.setdefault(root, []).append((bool(tree.get("is_linked_worktree")),
                                            position, space["workspace_id"]))
        if not tree.get("is_linked_worktree") and root not in anchors:
            anchors[root] = position
    # A group of nothing but worktrees, its repo checkout never opened, anchors
    # on its first row instead.
    for root, members in groups.items():
        anchors.setdefault(root, min(position for _, position, _ in members))
    order = []
    for root in sorted(groups, key=lambda key: anchors[key]):
        order.extend(wid for _, _, wid in sorted(groups[root]))
    return order


def main():
    before = workspaces()
    target = grouped_order(before)
    if [space["workspace_id"] for space in before] == target:
        print("already aligned")
    else:
        for index, workspace_id in enumerate(target):
            call("workspace.move", {"workspace_id": workspace_id, "insert_index": index})
    for space in workspaces():
        indent = "  " if (space.get("worktree") or {}).get("is_linked_worktree") else ""
        print(f"{space['number']:>3}  {indent}{space['label']}")


if __name__ == "__main__":
    main()
H
  chmod +x "$BIN/spechub-herdr-renumber"

  cat > "$BIN/spechub-clip" <<'H'
#!/usr/bin/env bash
# Put text on the clipboard of the machine your terminal is on.
#
#   spechub-clip "text"      copy the arguments
#   ... | spechub-clip       copy stdin
#   spechub-clip --out       print what was copied last
#
# A VM reached over SSH has no display and no clipboard of its own, so
# xclip and friends have nothing to talk to. OSC 52 is the escape sequence
# that asks the terminal at the far end - Windows Terminal, iTerm2, kitty -
# to put text on its own clipboard. It is only bytes in the terminal stream,
# so it crosses SSH for free, and herdr forwards it from a pane to whatever
# terminal is hosting it.
#
# Reading back is not symmetrical. Windows Terminal refuses OSC 52 reads on
# purpose, so --out replays a local cache instead. Installed by spechub.
set -uo pipefail

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/spechub/clipboard"

# A real clipboard beats an escape sequence when one exists. Anything sitting
# in this script's own directory is skipped, so the xclip shim installed
# beside it can never call back into here in a loop.
native() {  # native <tool>; prints the path of a real one, if any
  local tool="$1" self candidate
  self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
  while IFS= read -r candidate; do
    [ "$(cd "$(dirname "$candidate")" 2>/dev/null && pwd)" = "$self" ] && continue
    printf '%s' "$candidate"; return 0
  done < <(type -ap "$tool" 2>/dev/null)
  return 1
}

has_display() { [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }

if [ "${1:-}" = "--out" ] || [ "${1:-}" = "-o" ]; then
  if has_display; then
    for tool in wl-paste xclip xsel; do
      real="$(native "$tool")" || continue
      case "$tool" in
        wl-paste) exec "$real" --no-newline ;;
        xclip)    exec "$real" -out -selection clipboard ;;
        xsel)     exec "$real" --output --clipboard ;;
      esac
    done
  fi
  [ -f "$CACHE" ] || { echo "spechub-clip: nothing copied yet" >&2; exit 1; }
  cat "$CACHE"
  exit 0
fi

if [ $# -gt 0 ]; then text="$*"; else text="$(cat)"; fi

mkdir -p "$(dirname "$CACHE")"
printf '%s' "$text" > "$CACHE"
chmod 600 "$CACHE" 2>/dev/null

if has_display; then
  for tool in wl-copy xclip xsel; do
    real="$(native "$tool")" || continue
    case "$tool" in
      wl-copy) printf '%s' "$text" | "$real" && exit 0 ;;
      xclip)   printf '%s' "$text" | "$real" -in -selection clipboard && exit 0 ;;
      xsel)    printf '%s' "$text" | "$real" --input --clipboard && exit 0 ;;
    esac
  done
fi

b64="$(printf '%s' "$text" | base64 | tr -d '\n')"
# 74994 bytes is the ceiling tmux puts on an OSC 52 payload, and the lowest
# of anything in this path. Past it the sequence is dropped without a word,
# so say so rather than report a copy that did not happen.
if [ ${#b64} -gt 74994 ]; then
  echo "spechub-clip: too large for the terminal clipboard (${#b64} bytes encoded)" >&2
  exit 1
fi

esc=$'\033]52;c;'"$b64"$'\a'
# tmux drops escape sequences it does not recognise unless they are wrapped
# for passthrough. herdr needs no wrapping - it forwards OSC 52 itself.
if [ -n "${TMUX:-}" ]; then
  esc=$'\033Ptmux;'"${esc//$'\033'/$'\033\033'}"$'\033\\'
fi

# The controlling terminal, not stdout. Callers are usually TUIs that have
# redirected both streams, and OSC 52 has to reach the terminal itself.
if { printf '%s' "$esc" > /dev/tty; } 2>/dev/null; then exit 0; fi
printf '%s' "$esc" >&2
H
  chmod +x "$BIN/spechub-clip"

  cat > "$BIN/spechub-open" <<'H'
#!/usr/bin/env bash
# Open a URL from a machine that has no browser of its own.
#
#   spechub-open https://github.com/owner/repo/pull/1
#   spechub-open --why      which route this machine will take, without taking it
#
# gh-dash binds o to this. It is bound as a keybinding rather than left to
# $BROWSER because gh-dash runs $BROWSER with its output discarded and the
# dashboard still drawn: a route that needs to say anything, or to hand you a
# link to click, has nowhere to put it. As a keybinding gh-dash steps aside
# and gives us the terminal.
#
# In order: an explicit override, a desktop on this machine, WSL, the opener
# service on the laptop, the Playwriter bridge to Chrome on the laptop, and
# last a link you can click.
# Installed by spechub.
set -uo pipefail

LOG="${XDG_CACHE_HOME:-$HOME/.cache}/spechub/open.log"
# An ambient $AGENT_BROWSER_CDP is a hint, never the thing we rely on. See
# the bridge branch below for what happened when it was.
BRIDGE="${SPECHUB_BRIDGE_URL:-${AGENT_BROWSER_CDP:-http://127.0.0.1:19988}}"
OPENER="${SPECHUB_OPENER_URL:-http://127.0.0.1:19989}"
# The opener refuses anything without this, so its absence is the same as the
# opener being down - which is exactly how the route probe treats it.
OPENER_TOKEN="${XDG_CONFIG_HOME:-$HOME/.config}/spechub/opener.token"

WHY=0
[ "${1:-}" = "--why" ] && { WHY=1; shift; }
URL="${1:-}"
[ -n "$URL" ] || [ "$WHY" = 1 ] \
  || { echo "usage: spechub-open [--why] <url>" >&2; exit 2; }

log() {  # the only record of what happened when the caller discards output
  mkdir -p "$(dirname "$LOG")"
  printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"
  if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
    tail -n 200 "$LOG" > "$LOG.trim" && mv "$LOG.trim" "$LOG"
  fi
}

note() {  # say something a suspended TUI cannot print for us
  command -v herdr >/dev/null 2>&1 \
    && herdr notification show "$1" --body "$2" >/dev/null 2>&1
  return 0
}

# Not [ -t 1 ]: route() runs inside a command substitution for --why, which
# makes stdout a pipe even when the terminal is right there.
has_tty() { { : > /dev/tty; } 2>/dev/null; }

# The relay answering on its HTTP port is not the same as the browser being
# reachable through it. agent-browser quietly launches a headless Chrome on
# this machine when it cannot attach, and that Chrome navigates happily and
# shows nobody anything - which is how o came to report a page it had opened
# where no one could see it. So ask what is actually on the far end.
#
# /json/list is the Playwriter extension's own answer to that question. The
# extension attaches per tab, so `[]` means it is armed on nothing and there
# is no browser to drive, however healthy the tunnel underneath looks.
#
# This used to gate on $HOME/.agent-browser/default.sock existing first, on
# the reasoning that probing starts a browser as a side effect. It does not:
# curl starts nothing. What that gate did do was make the bridge unreachable,
# because nothing on this machine creates that socket until an agent-browser
# session is already running - so a perfectly healthy bridge still fell
# through to the link route. Asking the relay is both safer and correct.
bridge_attached() {
  [ "${SPECHUB_OPEN_BRIDGE:-auto}" != "off" ] || return 1
  # agent-browser has to exist to take the route, but is never run to decide
  # it: deciding must cost one round trip, not a browser launch.
  command -v agent-browser >/dev/null 2>&1 || return 1
  # Seconds, not tens of them: the tunnel stays bound on this side after the
  # relay at the far end stops answering, so an unhealthy bridge connects and
  # then hangs rather than refusing. Every one of those seconds is spent in
  # front of someone who just pressed a key.
  local targets
  targets=$(curl -fsS --connect-timeout 1 -m 2 "$BRIDGE/json/list" 2>/dev/null) || return 1
  # Whitespace-only and [] both mean armed on no tab.
  case "$(printf '%s' "$targets" | tr -d '[:space:]')" in
    ''|'[]') return 1 ;;
  esac
  return 0
}

# Same discipline as bridge_attached: ask the far end rather than believing
# anything local. A token on disk proves nothing about a service being up, and
# a service being up proves nothing without the token it will demand - so the
# probe carries the token and the route is only taken if that round trip
# answered.
opener_ready() {
  [ "${SPECHUB_OPEN_OPENER:-auto}" != "off" ] || return 1
  local tok
  tok=$(cat "$OPENER_TOKEN" 2>/dev/null) || return 1
  [ -n "$tok" ] || return 1
  # Seconds, not tens of them - someone just pressed a key and is watching.
  curl -fsS --connect-timeout 1 -m 2 -H "X-Spechub-Token: $tok" \
    "$OPENER/health" >/dev/null 2>&1
}

route() {  # the route this machine will take, decided without taking it
  [ -n "${SPECHUB_OPEN_CMD:-}" ] && { echo "command"; return; }
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1 \
    && { echo "xdg-open"; return; }
  local opener
  for opener in wslview wsl-open explorer.exe; do
    command -v "$opener" >/dev/null 2>&1 && { echo "$opener"; return; }
  done
  # Ahead of the bridge deliberately. The bridge drives a browser for an
  # agent: it attaches per tab, only after someone clicks the extension icon,
  # and it does so in a Chrome profile that is not the default browser. The
  # opener needs no click and reaches the browser the user actually uses. See
  # docs/adr/0006-document-opener-service.md.
  opener_ready && { echo "opener"; return; }
  bridge_attached && { echo "bridge"; return; }
  has_tty && { echo "link"; return; }
  echo "clipboard"
}

# A clickable link, on the terminal you are actually sitting at. OSC 8 is a
# hyperlink the terminal draws itself, so ctrl+click reaches the browser on
# your own machine with nothing installed anywhere in between. The bare URL
# on the next line covers terminals that ignore OSC 8, and the clipboard
# copy covers not wanting to click at all.
link_screen() {
  printf '%s' "$URL" | spechub-clip
  {
    printf '\n  Open on GitHub\n\n  '
    printf '\033]8;;%s\033\\%s\033]8;;\033\\\n' "$URL" "$URL"
    printf '  ctrl+click the link, or paste it - it is on your clipboard\n\n'
    printf '  Press any key to go back.'
  } > /dev/tty
  read -rsn1 < /dev/tty
  printf '\n' > /dev/tty
}

ROUTE="$(route)"
[ "$WHY" = 1 ] && { echo "$ROUTE"; exit 0; }

case "$ROUTE" in
  command)
    log "override: $SPECHUB_OPEN_CMD $URL"
    exec ${SPECHUB_OPEN_CMD} "$URL"
    ;;
  xdg-open)
    # $BROWSER is cleared first: xdg-open reads it too, and $BROWSER may well
    # be pointing back here, which would loop.
    log "xdg-open: $URL"
    BROWSER= exec xdg-open "$URL"
    ;;
  explorer.exe)
    # explorer.exe reports failure even when it opened the page. Ignore it.
    log "explorer.exe: $URL"
    explorer.exe "$URL" >/dev/null 2>&1
    exit 0
    ;;
  wslview|wsl-open)
    log "$ROUTE: $URL"
    exec "$ROUTE" "$URL"
    ;;
  opener)
    # One POST and the laptop opens it in whatever it considers the default
    # browser. No tab to arm, no extension, no CDP session to contend for.
    #
    # A URL carrying a double quote or a backslash would break out of the JSON
    # string it is about to become. Rather than escape it, fall through to the
    # link screen: those characters are not legal in a URL unescaped, so a URL
    # holding one is malformed and worth showing a human rather than sending.
    tok=$(cat "$OPENER_TOKEN" 2>/dev/null || true)
    case "$URL" in
      *'"'*|*'\\'*) tok="" ;;
    esac
    if [ -n "$tok" ] && curl -fsS --connect-timeout 2 -m 10 -X POST \
         -H "X-Spechub-Token: $tok" -H 'Content-Type: application/json' \
         --data "$(printf '{"url":"%s"}' "$URL")" \
         "$OPENER/open" 2>/dev/null | tr -d '[:space:]' | grep -q '"opened":true'; then
      log "opener $OPENER: $URL"
      exit 0
    fi
    log "opener $OPENER did not open it, handing over the link: $URL"
    if has_tty; then link_screen; exit 0; fi
    ;;
  bridge)
    # Name the endpoint rather than inheriting one. Leaning on an ambient
    # $AGENT_BROWSER_CDP made this launch a headless Chrome on the VM when
    # run from a herdr popup, which reported success and opened nothing
    # anybody could see.
    #
    # The default session, deliberately: the relay takes one CDP client at a
    # time, so a session of our own cannot connect while an agent holds it.
    # That also means the new tab becomes the active one for any agent
    # driving that browser. SPECHUB_OPEN_BRIDGE=off trades the one-key open
    # for never touching it.
    if timeout 20 agent-browser --cdp "$BRIDGE" tab new >/dev/null 2>&1 \
       && timeout 30 agent-browser --cdp "$BRIDGE" open "$URL" >/dev/null 2>&1; then
      log "bridge $BRIDGE: $URL"
      exit 0
    fi
    log "bridge $BRIDGE unavailable, handing over the link: $URL"
    if has_tty; then link_screen; exit 0; fi
    ;;
esac

[ "$ROUTE" = link ] && { log "link: $URL"; link_screen; exit 0; }

# No terminal to draw on and no browser to reach. The clipboard is still one
# paste from the browser on the machine you are sitting at, which beats
# nothing, but report failure anyway: a silent success here is what left
# gh-dash saying "Opened in browser" about a page that never opened.
if printf '%s' "$URL" | spechub-clip; then
  log "copied, not opened: $URL"
  note "URL copied, not opened" "No browser reachable from here. Paste: $URL"
  exit 3
fi
log "no route: $URL"
note "Cannot open URL" "$URL"
exit 1
H
  chmod +x "$BIN/spechub-open"

  cat > "$BIN/spechub-bridge" <<'H'
#!/usr/bin/env bash
# Look at the Playwriter bridge from the dev machine, and fix it where that is
# possible from here.
#
#   spechub-bridge status        what is up, on both machines
#   spechub-bridge fix [what]    restart relay | tunnel | both (default both)
#
# Restarting either is a Windows scheduled task, so this machine cannot do it
# directly. It asks the opener, which runs over there and can. When the opener
# is not reachable either, it prints the handoff block to paste into a
# PowerShell on the laptop instead - the same block the bridge skill defines.
#
# What it still cannot do is arm the extension. That is a click inside a
# third-party extension and nothing on either machine can press it.
# Installed by spechub.
set -uo pipefail

BRIDGE="${SPECHUB_BRIDGE_URL:-http://127.0.0.1:19988}"
OPENER="${SPECHUB_OPENER_URL:-http://127.0.0.1:19989}"
OPENER_TOKEN="${XDG_CONFIG_HOME:-$HOME/.config}/spechub/opener.token"
FREE_PORT="${SPECHUB_FREE_PORT:-$HOME/.claude/spechub/bin/vm-free-port.sh}"

CMD="${1:-status}"
WHAT="${2:-both}"

tok() { cat "$OPENER_TOKEN" 2>/dev/null; }

clear_port() {  # clear_port <port> - let go of a forward this machine still holds
  # A tunnel that will not rebind is usually held from this side: the VM's sshd
  # still owns the forward channel of a session that dropped. Restarting the
  # task on the laptop then fails exactly the way it failed before, because
  # nothing here let go of the port. So this runs first.
  #
  # The clearer ships with spechub and may simply not be installed on a machine
  # that got the terminal workspace some other way. Worth saying, but not a
  # reason to refuse the restart, which may be all that was needed.
  if [ ! -f "$FREE_PORT" ]; then
    echo "no port clearer at $FREE_PORT - asking for the restart without freeing $1 first." >&2
    return 0
  fi
  #
  # A clearer that predates --port is the awkward case in between: it exists,
  # so the missing-file warning never fires, but it only knows how to free
  # 19988. Called bare it would clear the bridge port twice, never touch 19989,
  # and hand back two successes - so the caller would believe both ports were
  # freed. Report the version and clear nothing; guessing is worse than saying.
  # It announces its age two ways: the flag is nowhere in its text, or it takes
  # the flag, does not recognise the argument, and exits 64 - the usage code,
  # which is not "the port is stuck" and is not worth a retry without the flag.
  local older="is older than this branch, so it cannot free $1 on request."
  local fix="Update spechub on this machine to refresh it. Asking for the restart anyway."
  if ! grep -q -- '--port' "$FREE_PORT" 2>/dev/null; then
    echo "$FREE_PORT $older It has no --port support at all. $fix" >&2
    return 0
  fi
  local rc=0
  bash "$FREE_PORT" --port "$1" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = "64" ]; then
    echo "$FREE_PORT $older It refused --port with the usage code 64. $fix" >&2
  elif [ "$rc" != "0" ]; then
    echo "$FREE_PORT could not free $1 - asking for the restart anyway." >&2
  fi
}

opener_call() {  # opener_call <method> <path> [data]
  local t; t=$(tok) || return 1
  [ -n "$t" ] || return 1
  if [ "$1" = "POST" ]; then
    curl -fsS --connect-timeout 2 -m 40 -X POST -H "X-Spechub-Token: $t" \
      -H 'Content-Type: application/json' --data "${3:-{\}}" "$OPENER$2" 2>/dev/null
  else
    curl -fsS --connect-timeout 2 -m 10 -H "X-Spechub-Token: $t" "$OPENER$2" 2>/dev/null
  fi
}

handoff() {  # what this machine cannot do, in the shape the other side expects
  # Unquoted, because $1 names what is being asked for - so every PowerShell $
  # inside has to be escaped or the shell eats it. A handoff block is pasted
  # verbatim into a shell on the other machine, so a mangled one is worse than
  # no block at all.
  cat >&2 <<HANDOFF

--- BEGIN VM-SIDE HANDOFF (to Windows agent) ---
Context: the bridge needs $1 on the laptop, and the opener on 19989 is not
reachable from this machine either, so nothing here can do it.

Run on the Windows laptop:
  Stop-ScheduledTask -TaskName 'Playwriter-*'
  Start-ScheduledTask -TaskName 'Playwriter-Relay'
  Start-ScheduledTask -TaskName 'Playwriter-Opener'
  Get-ScheduledTask -TaskName 'Playwriter-Tunnel-*','Playwriter-OpenerTunnel-*' |
    ForEach-Object { Start-ScheduledTask -TaskName \$_.TaskName }
  .\doctor.ps1

Expected result:
  doctor.ps1 exits with all green rows, including "Relay listening on 19988"
  and "Opener listening on 19989", and no tunnel-*.stuck markers.

Report back:
  The doctor.ps1 output (paste the table).
--- END VM-SIDE HANDOFF ---
HANDOFF
}

case "$CMD" in
  status)
    # This machine's own view first: these say whether the tunnels arrived,
    # which is the half the laptop cannot see.
    if curl -fsS --connect-timeout 1 -m 3 "$BRIDGE/json/version" >/dev/null 2>&1; then
      armed=$(curl -fsS --connect-timeout 1 -m 3 "$BRIDGE/json/list" 2>/dev/null | tr -d '[:space:]')
      case "$armed" in
        ''|'[]') echo "relay:   reachable, but the extension is armed on no tab" ;;
        *)       echo "relay:   reachable, extension armed" ;;
      esac
    else
      echo "relay:   not reachable on $BRIDGE"
    fi

    if health=$(opener_call GET /health); then
      echo "opener:  reachable - $(printf '%s' "$health" | tr -d '[:space:]')"
    elif [ -z "$(tok)" ]; then
      echo "opener:  no token at $OPENER_TOKEN (run register-tasks.ps1 on the laptop)"
    else
      echo "opener:  not reachable on $OPENER"
    fi

    # And the laptop's view, which only the opener can fetch.
    if tasks=$(opener_call GET /bridge/health); then
      echo "tasks:   $(printf '%s' "$tasks" | tr -d '[:space:]')"
    else
      echo "tasks:   unknown - the opener is the only way to see them from here"
    fi
    echo "route:   $(spechub-open --why 2>/dev/null || echo unknown)"
    ;;
  fix)
    case "$WHAT" in
      relay|tunnel|both) ;;
      *) echo "usage: spechub-bridge fix [relay|tunnel|both]" >&2; exit 2 ;;
    esac
    # A tunnel restart is the only case where a port here is in the way. Both
    # ports get cleared, because the opener's 19989 is forwarded by its own task
    # and wedges on its own. fix relay touches no tunnel, so clearing a port
    # there would be tearing down a working connection to fix something else.
    if [ "$WHAT" != "relay" ]; then
      clear_port 19988
      clear_port 19989
    fi
    if out=$(opener_call POST /bridge/restart "$(printf '{"what":"%s"}' "$WHAT")"); then
      echo "asked the laptop to restart: $WHAT"
      printf '%s\n' "$out"
      # Restarting is not recovering. Give the tunnels a moment to rebind, then
      # say whether they actually came back rather than reporting the request.
      sleep 5
      rc=0
      if curl -fsS --connect-timeout 1 -m 3 "$BRIDGE/json/version" >/dev/null 2>&1; then
        echo "relay is answering again on $BRIDGE"
      else
        echo "the restart was accepted but the relay is still not answering here on 19988." >&2
        echo "  if this persists the port may be wedged on this machine:" >&2
        echo "  bash $FREE_PORT --port 19988" >&2
        rc=1
      fi
      # Two tunnels, two verdicts. A relay that came back says nothing about
      # the opener, and an opener that stayed down is the half that leaves this
      # machine unable to reach a browser at all - so it is checked, and named.
      if [ "$WHAT" != "relay" ]; then
        if opener_call GET /health >/dev/null; then
          echo "opener is answering again on $OPENER"
        else
          echo "the restart was accepted but the opener is still not answering here on 19989." >&2
          echo "  if this persists the port may be wedged on this machine:" >&2
          echo "  bash $FREE_PORT --port 19989" >&2
          rc=1
        fi
      fi
      exit $rc
    fi
    handoff "a restart of $WHAT"
    exit 1
    ;;
  *)
    echo "usage: spechub-bridge [status|fix [relay|tunnel|both]]" >&2
    exit 2
    ;;
esac
H
  chmod +x "$BIN/spechub-bridge"

  say "helpers written: spechub-diff, spechub-dash, spechub-md, spechub-view"
  say "remote helpers written: spechub-clip, spechub-open, spechub-bridge"
  say "herdr helpers written: spechub-herdr-tab, spechub-herdr-renumber"
}

apply_herdr() {
  have herdr || { say "herdr not installed, skipping keymap"; return 0; }
  mkdir -p "$(dirname "$HERDR_CFG")"; touch "$HERDR_CFG"
  local mod wt diffkey dashkey filekey filetabkey difftabkey dashtabkey
  local pickkey picktabkey gitkey gittabkey scrollbars
  mod=$(cfg_get herdr.chord_modifier alt)
  wt=$(cfg_get herdr.worktrees_directory "~/.herdr/worktrees")
  # f, not d: Windows Terminal keeps alt+shift+d for "duplicate pane", so the
  # tab half of a d pair never reaches herdr. Both diff keys sit on f instead.
  diffkey=$(cfg_get diffnav.popup_key "alt+f")
  dashkey=$(cfg_get gh_dash.popup_key "alt+i")
  filekey=$(cfg_get yazi.popup_key "alt+y")
  filetabkey=$(cfg_get yazi.tab_key "alt+shift+y")
  difftabkey=$(cfg_get diffnav.tab_key "alt+shift+f")
  dashtabkey=$(cfg_get gh_dash.tab_key "alt+shift+i")
  pickkey=$(cfg_get diffnav.pick_key "alt+x")
  picktabkey=$(cfg_get diffnav.pick_tab_key "alt+shift+x")
  gitkey=$(cfg_get lazygit.popup_key "alt+g")
  gittabkey=$(cfg_get lazygit.tab_key "alt+shift+g")
  # herdr counts the scrollbar column inside the pane rect but reports the
  # full rect width to the program running in the pane. A full-screen app then
  # writes one column more than it has, so every wrapped row starts a column
  # left of the row above it. Turning the scrollbar off gives the column back.
  scrollbars=$(cfg_get herdr.pane_scrollbars false)
  [ "$(cfg_get diffnav.enabled true)" = "true" ] \
    || { diffkey=""; difftabkey=""; pickkey=""; picktabkey=""; }
  [ "$(cfg_get gh_dash.enabled true)" = "true" ] || { dashkey=""; dashtabkey=""; }
  [ "$(cfg_get yazi.enabled true)"    = "true" ] || { filekey=""; filetabkey=""; }
  [ "$(cfg_get lazygit.enabled true)" = "true" ] || { gitkey=""; gittabkey=""; }

  SPECHUB_ARGS="$mod|$wt|$diffkey|$dashkey|$filekey|$filetabkey|$difftabkey|$dashtabkey|$pickkey|$picktabkey|$gitkey|$gittabkey|$scrollbars|$BEGIN|$END" py "$HERDR_CFG" <<'PY'
import os, re, sys
path = sys.argv[1]
(mod, wt, diffkey, dashkey, filekey, filetabkey, difftabkey, dashtabkey,
 pickkey, picktabkey, gitkey, gittabkey, scrollbars,
 begin, end) = os.environ["SPECHUB_ARGS"].split("|")

# key, command, description, herdr custom-command type, popup size.
# type "shell" takes no size: herdr rejects width/height on a non-popup.
CUSTOM = [
    (diffkey,    "spechub-diff",                  "diff: branch vs dev", "popup", "90%"),
    (difftabkey, "spechub-herdr-tab diff spechub-diff", "diff: branch vs dev (tab)", "shell", None),
    (pickkey,    "spechub-diff pick",             "diff: pick what to compare", "popup", "90%"),
    (picktabkey, "spechub-herdr-tab diffpick spechub-diff pick",
                                                  "diff: pick what to compare (tab)", "shell", None),
    (dashkey,    "spechub-dash",                  "PR dashboard",       "popup", "95%"),
    (dashtabkey, "spechub-herdr-tab dash spechub-dash", "PR dashboard (tab)", "shell", None),
    (filekey,    "yazi",                          "file tree",          "popup", "95%"),
    (filetabkey, "spechub-herdr-tab yazi yazi",         "file tree (tab)",    "shell", None),
    (gitkey,     "lazygit",                       "git: stage, commit, push", "popup", "90%"),
    (gittabkey,  "spechub-herdr-tab lazygit lazygit",
                                                  "git: stage, commit, push (tab)", "shell", None),
]

def custom_blocks():
    out = []
    for key, cmd, desc, typ, size in CUSTOM:
        if not key:
            continue
        out += ["", "[[keys.command]]", f'key = "{key}"', f'type = "{typ}"',
                f'command = "{cmd}"', f'description = "{desc}"']
        if size:
            out += [f'width = "{size}"', f'height = "{size}"']
    return out
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
        # herdr puts switch_tab on prefix+1..9 by default. Move it aside so
        # switch_workspace below can have the plain digits.
        f'switch_tab = "prefix+{m}+1..9"',
        f'toggle_sidebar = ["prefix+b", "{m}+s"]',
        # g belongs to git only when lazygit is on. alt+g is lazygit and
        # alt+shift+g is its tab, so goto moves off the letter on both layers:
        # prefix+g one key away from alt+g reads as the same thing. With
        # lazygit off, nothing wants the letter and goto keeps it.
        ('goto = "prefix+t"' if gitkey else f'goto = ["prefix+g", "{m}+g"]'),
        f'zoom = ["prefix+z", "{m}+z"]',
        f'last_pane = "{m}+a"',
        f'new_tab = ["prefix+c", "{m}+c"]',
        f'new_workspace = ["prefix+shift+n", "{m}+w"]',
        # Also off g, for the same reason, and back on it when lazygit is off.
        (f'new_worktree = "{m}+r"' if gitkey
         else f'new_worktree = ["prefix+shift+g", "{m}+r"]'),
        f'split_vertical = ["prefix+v", "{m}+e"]',
        f'split_horizontal = ["prefix+minus", "{m}+minus"]',
    ]

# herdr leaves switch_workspace unbound, so without this there is no way to
# reach a workspace by number at all. It is prefix-only, so it is written even
# when the chord family is off: opting out of alt chords should not cost you
# workspace numbers.
keys.append('switch_workspace = "prefix+1..9"')

# The first and only [ui] setting this script manages. See the comment on
# `scrollbars` above for what the scrollbar column costs.
ui = ["pane_scrollbars = " + ("true" if scrollbars == "true" else "false")]

# TOML forbids a duplicate key, so a hand-written keymap that already sets
# something this script manages would make the merged file unparseable and
# herdr would reject the lot. Drop our own keys from the user's [keys] table,
# and any [[keys.command]] bound to a key we are about to claim, before
# inserting. Anything we do not manage is left exactly as it was.
managed = {k.split("=", 1)[0].strip() for k in keys if "=" in k}
managed_ui = {k.split("=", 1)[0].strip() for k in ui if "=" in k}
claimed = {key for key, *_ in CUSTOM if key}


def strip_managed(table, names):
    # Drop the settings this script manages, and the comment block that
    # introduced each one. Removing the setting alone strands its comment: the
    # user is left with a run of bare headings describing settings that are no
    # longer there, which reads as a broken config.
    out, pending = [], []
    for ln in table:
        stripped = ln.strip()
        if stripped.startswith("#") or not stripped:
            pending.append(ln)
            continue
        if "=" in ln and ln.split("=", 1)[0].strip() in names:
            pending = []
            continue
        out.extend(pending)
        pending = []
        out.append(ln)
    out.extend(pending)
    return out


def tables(lines):
    current = []
    for line in lines:
        if line.strip().startswith("[") and current:
            yield current
            current = []
        current.append(line)
    if current:
        yield current


kept = []
for table in tables(text.splitlines()):
    header = table[0].strip()
    # The managed block re-declares [worktrees] in full, and TOML forbids
    # declaring a table twice.
    if header == "[worktrees]":
        continue
    if header == "[[keys.command]]":
        bound = re.search(r'(?m)^\s*key\s*=\s*"([^"]+)"', "\n".join(table))
        if bound and bound.group(1) in claimed:
            continue
    if header == "[keys]":
        table = strip_managed(table, managed)
    if header == "[ui]":
        table = strip_managed(table, managed_ui)
    kept.extend(table)
text = "\n".join(kept)
if text and not text.endswith("\n"):
    text += "\n"

def merge(text, header, lines):
    # Merge into a table the user already declared rather than declaring a
    # second one, because TOML forbids declaring the same table twice. Returns
    # the text and whether the merge happened.
    head = r"^\[" + header + r"\][ \t]*\n"
    if not re.search(head, text, flags=re.M):
        return text, False
    region = begin + "\n" + "\n".join(lines) + "\n" + end
    return re.sub(head, f"[{header}]\n" + region + "\n",
                  text, count=1, flags=re.M), True


block = []
for header, lines in (("keys", keys), ("ui", ui)):
    text, merged = merge(text, header, lines)
    if merged:
        continue
    if block:
        block.append("")
    block += [f"[{header}]"] + lines

# [[keys.command]] and [worktrees] are top-level, so they can never sit inside
# a merged region and always land in a block of their own at the end.
block += custom_blocks() + ["", "[worktrees]", f'directory = "{wt}"']
text = text.rstrip("\n") + "\n\n" + "\n".join([begin] + block + [end]) + "\n"

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

build_tuicr_fork() {
  # TEMPORARY path. Builds the two unmerged upstream pull requests the config
  # comments name. Once both land, set build_from_fork: false and this whole
  # function stops being reachable.
  # `have cargo` is not enough: a rustup shim on PATH with no default
  # toolchain installed exits non-zero on every invocation.
  if ! cargo --version >/dev/null 2>&1; then
    say "tuicr fork build needs a working cargo (see rustup.rs), skipping"
    cargo --version 2>&1 | head -2 | sed 's/^/    /'
    return 1
  fi
  have git   || { say "tuicr fork build needs git, skipping"; return 1; }
  local url branch dir
  url=$(cfg_get tuicr.fork "https://github.com/ac8318740/tuicr")
  branch=$(cfg_get tuicr.fork_branch "local/daily")
  dir="${SPECHUB_TUICR_SRC:-$HOME/tuicr}"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch --quiet --all 2>/dev/null
    git -C "$dir" checkout --quiet "$branch" 2>/dev/null || { say "tuicr: no branch $branch in $dir"; return 1; }
    git -C "$dir" pull --quiet --ff-only 2>/dev/null
  else
    git clone --quiet -b "$branch" "$url" "$dir" || { say "tuicr: clone failed"; return 1; }
  fi
  say "building tuicr from $branch (a few minutes on a cold cache)"
  local log; log=$(mktemp)
  if ! ( cd "$dir" && cargo build --release ) >"$log" 2>&1; then
    say "tuicr: build failed in $dir"
    # Swallowing cargo's output here made a missing toolchain look identical
    # to a compile error.
    grep -E '^(error|warning: unused)' "$log" | head -5 | sed 's/^/    /'
    tail -3 "$log" | sed 's/^/    /'
    rm -f "$log"; return 1
  fi
  rm -f "$log"
  mkdir -p "$BIN"
  # mv, not cp: cp fails with "Text file busy" when tuicr is running.
  cp "$dir/target/release/tuicr" "$BIN/tuicr.new" && mv -f "$BIN/tuicr.new" "$BIN/tuicr"
  say "tuicr built from $branch and installed to $BIN/tuicr"
}

apply_tuicr() {
  local from_fork; from_fork=$(cfg_get tuicr.build_from_fork false)
  if ! have tuicr; then
    if [ "$from_fork" = "true" ]; then
      build_tuicr_fork || return 0
    else
      install_binary tuicr agavra/tuicr x86_64-unknown-linux-gnu || return 0
    fi
  fi
  have tuicr || { say "tuicr not installed, skipping config"; return 0; }

  mkdir -p "$HOME/.config/tuicr"
  # show_file_line_stats and file_list_width only exist in the fork build.
  # Writing them against a stock release makes tuicr warn on every start.
  SPECHUB_ARGS="$from_fork|$(cfg_get tuicr.file_list_width 30)|$(cfg_get tuicr.show_file_line_stats true)|$BEGIN|$END" \
    py "$HOME/.config/tuicr/config.toml" <<'PY'
import os, re, sys
path = sys.argv[1]
from_fork, width, stats, begin, end = os.environ["SPECHUB_ARGS"].split("|")
text = open(path).read() if os.path.isfile(path) else ""
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)

block = [begin]
if from_fork == "true":
    block += [
        "# These two keys exist only in the fork build. See the tuicr section",
        "# of ~/.config/spechub/terminal-workspace.yaml.",
        f"show_file_line_stats = {stats}",
        f"file_list_width = {width}",
        "# A local build must not be replaced by a stock release.",
        "no_update_check = true",
    ]
else:
    block += ["# Stock release: the fork-only keys are omitted so tuicr does not",
              "# warn about unknown config keys at startup."]
block.append(end)
text = text.rstrip("\n")
text = (text + "\n\n" if text else "") + "\n".join(block) + "\n"
open(path, "w").write(text)
PY
  say "tuicr config written"
}

# The sidebar draws a workspace's position in herdr's stored list, but
# prefix+1..9 targets its row in the grouped sidebar. Creating or removing a
# worktree moves one and not the other, so the numbers you read stop being the
# numbers you press. This links a tiny herdr plugin that reruns the alignment
# on every event that can move a row, so it never needs remembering.
apply_herdr_numbers() {
  have herdr || return 0
  [ "$(cfg_get herdr.renumber_plugin true)" = "true" ] || return 0

  local dir="$HOME/.config/spechub/herdr-numbers"
  mkdir -p "$dir"
  # An absolute command: herdr runs argv without a shell and resolves relative
  # commands from the plugin root, not from PATH.
  cat > "$dir/herdr-plugin.toml" <<H
id = "spechub.herdr-numbers"
name = "SpecHub workspace numbers"
version = "1.0.0"
min_herdr_version = "0.8.0"
description = "Keep the sidebar numbers matching prefix+1..9"
platforms = ["linux", "macos", "windows"]

# Every event that can move a sidebar row. workspace.moved and
# workspace.reordered are deliberately absent: the realignment emits both, so
# hooking them would loop forever. The helper is idempotent, so the overlap
# between the workspace and worktree events costs nothing.
[[events]]
on = "workspace.created"
command = ["$BIN/spechub-herdr-renumber"]

[[events]]
on = "workspace.closed"
command = ["$BIN/spechub-herdr-renumber"]

[[events]]
on = "worktree.created"
command = ["$BIN/spechub-herdr-renumber"]

[[events]]
on = "worktree.opened"
command = ["$BIN/spechub-herdr-renumber"]

[[events]]
on = "worktree.removed"
command = ["$BIN/spechub-herdr-renumber"]
H

  if herdr plugin list 2>/dev/null | grep -q "spechub.herdr-numbers"; then
    say "herdr numbers plugin already linked"
  elif herdr plugin link "$dir" >/dev/null 2>&1; then
    say "herdr numbers plugin linked, sidebar numbers stay aligned"
  else
    say "herdr plugin link failed; run spechub-herdr-renumber by hand"
  fi
}

apply_yazi() {
  [ "$(cfg_get yazi.enabled true)" = "true" ] || return 0
  if ! have yazi; then
    install_binary yazi sxyazi/yazi x86_64-unknown-linux-gnu || return 0
    install_binary ya   sxyazi/yazi x86_64-unknown-linux-gnu || true
  fi
  have yazi || { say "yazi not installed, skipping config"; return 0; }

  # piper turns any shell command into a previewer, which is how spechub-md
  # gets to draw markdown in the preview pane.
  if have ya && ! ya pkg list 2>/dev/null | grep -q "plugins:piper"; then
    ya pkg add yazi-rs/plugins:piper >/dev/null 2>&1 \
      && say "yazi piper plugin installed" \
      || say "piper install failed; markdown will preview as plain text"
  fi

  mkdir -p "$HOME/.config/yazi"
  SPECHUB_ARGS="$(cfg_get yazi.show_hidden true)|$BEGIN|$END" \
    py "$HOME/.config/yazi/yazi.toml" <<'PY'
import os, re, sys
path = sys.argv[1]
hidden, begin, end = os.environ["SPECHUB_ARGS"].split("|")
text = open(path).read() if os.path.isfile(path) else ""
# Drop any previous managed region, both to stay idempotent and so what is
# left to inspect below is exactly the config the user wrote.
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)

# Every namespace the block writes into. TOML forbids declaring any of them
# twice, and yazi answers one duplicate by throwing the entire config away and
# falling back to presets. So a namespace the user already occupies is theirs:
# the block gives that piece up rather than cost them every other setting they
# have. Deciding which are taken is a question about the parsed document, not
# about the text: [ mgr ], [ "mgr" ], [ 'mgr' ] and mgr.show_hidden = false are
# all the same table, and only a parser knows that.
NAMESPACES = ("mgr", "opener.markdown", "plugin.prepend_previewers", "open.prepend_rules")

try:
    import tomllib
except ImportError:  # tomllib is 3.11 and newer
    tomllib = None


def claimed(cfg):
    """Which of NAMESPACES the user's own config already occupies."""
    if tomllib is None:
        # No parser to reason with, so read the text conservatively: name the
        # top-level table wherever TOML could open one, as a header or as a
        # key of its own. That concedes namespaces which would have been safe
        # to write, and each of those costs one setting; guessing the other
        # way costs the file. One thing text cannot see is that the config is
        # broken already, so unlike the parsed path below this branch does not
        # concede everything for a file that never parsed.
        found = set()
        for ns in NAMESPACES:
            root = re.escape(ns.split(".")[0])
            # A key may be bare, a basic string or a literal string, and all
            # three name the same table: [mgr], ["mgr"] and ['mgr'] are one.
            name = r"""(?:%s|"%s"|'%s')""" % (root, root, root)
            header = r'\[\[?\s*%s\s*[.\]]' % name
            key = r'%s\s*[.=]' % name
            if re.search(r"(?m)^\s*(?:%s|%s)" % (header, key), cfg):
                found.add(ns)
        return found
    try:
        tomllib.loads(cfg)
    except tomllib.TOMLDecodeError:
        # Their config does not parse as it stands. We cannot tell what it
        # claims, and repairing it is not ours to do, so concede everything:
        # the file ends up exactly as broken as it arrived, never more.
        return set(NAMESPACES)
    found = set()
    for ns in NAMESPACES:
        # Whether a namespace is free is not "is the key there". TOML also
        # refuses to reopen an inline table and to overwrite a scalar, so
        # opener = { text = [...] } and opener = "nope" both have no
        # opener.markdown key and are both fatal to write under. tomllib
        # hands an inline table back as an ordinary dict, so no walk over the
        # parsed document can tell those apart from a table that is still
        # open. Put the question to the parser instead, in the exact form the
        # block would write it: append that header to their config and see
        # whether the whole thing still parses. Whatever it refuses is theirs.
        probe = "[mgr]" if ns == "mgr" else "[[%s]]" % ns
        try:
            tomllib.loads(cfg + "\n" + probe + "\n")
        except tomllib.TOMLDecodeError:
            found.add(ns)
    return found


taken = claimed(text)
parts = []

if "plugin.prepend_previewers" not in taken:
    parts.append("""
[[plugin.prepend_previewers]]
url = "*.md"
run = 'piper -- COLUMNS=$w spechub-md --preview "$1"'

[[plugin.prepend_previewers]]
url = "*.markdown"
run = 'piper -- COLUMNS=$w spechub-md --preview "$1"'
""")

if "opener.markdown" not in taken:
    # An array of tables rather than a markdown key under [opener]: a second
    # [opener] table would be a duplicate, while a subtable of one the user
    # has already declared is legal.
    parts.append("""
# The preview pane is narrow, so a wide diagram shows its placeholder there.
# Enter opens the same renderer full width, where more of them fit.
#
# %s is what yazi substitutes for the files being opened, already quoted. Not
# "$@": an opener template is run as `sh -c '<run>'` with nothing after it, so
# $0 is "sh" and $@ is empty - measured on yazi 26.8.15, where "$@" left
# spechub-md with no file at all and Enter did nothing but print its usage.
[[opener.markdown]]
run = 'spechub-md %s'
block = true
desc = "Read (spechub-md)"

# Rendered markdown has no line number to quote back in a review, so the same
# file is also readable as its own source. Second, not first: it answers a
# narrower question than reading does, and still a readier one than editing.
# Enter takes the first entry, so O is the key that offers this one.
[[opener.markdown]]
run = 'spechub-md --numbered %s'
block = true
desc = "Read with line numbers"

[[opener.markdown]]
run = '${EDITOR:-vi} %s'
block = true
desc = "Edit"
""")

if "open.prepend_rules" not in taken:
    # Worth writing even when the opener above was skipped: the rules point
    # markdown files at whichever opener.markdown ends up in the file.
    parts.append("""
[[open.prepend_rules]]
url = "*.md"
use = "markdown"

[[open.prepend_rules]]
url = "*.markdown"
use = "markdown"
""")

if "mgr" not in taken:
    parts.append(f"[mgr]\nshow_hidden = {hidden}")

# The markers go down even when every piece was conceded, so the shell below
# can still read the region back and see what is missing from it.
block = begin + "\n" + "\n\n".join(p.strip("\n") for p in parts) + "\n" + end
text = text.rstrip("\n")
open(path, "w").write((text + "\n\n" if text else "") + block + "\n")
PY
  # A setting the block gave up to the user's own config is simply absent from
  # what was written, so read the region back rather than let it go unsaid.
  local written; written="$(sed -n "/$BEGIN/,/$END/p" "$HOME/.config/yazi/yazi.toml")"
  case "$written" in *"[[plugin.prepend_previewers]]"*) ;; *)
    say "yazi: your yazi.toml already sets plugin.prepend_previewers, so the"
    say "     markdown previewer was left alone. Add a *.md entry there to"
    say "     preview markdown with spechub-md." ;;
  esac
  case "$written" in *"[[opener.markdown]]"*) ;; *)
    say "yazi: your yazi.toml already opens markdown its own way, so it was left"
    say "     alone. Add spechub-md to that opener to read markdown with it." ;;
  esac
  case "$written" in *"[[open.prepend_rules]]"*) ;; *)
    say "yazi: your yazi.toml already sets open.prepend_rules, so the markdown"
    say "     rules were left alone. Add *.md and *.markdown entries there"
    say "     pointing at the markdown opener." ;;
  esac
  case "$written" in *show_hidden*) ;; *)
    say "yazi: your yazi.toml already claims mgr itself, so show_hidden was left"
    say "     alone. Set it there yourself to show hidden files." ;;
  esac
  # The keymap is its own file, and prepend_keymap has two spellings: an array
  # of tables, which is additive and safe to extend, and an inline array under
  # [mgr], which is one key that TOML forbids declaring twice. Only the second
  # collides with the entry below, and telling them apart takes the text - both
  # spellings parse to the same list.
  SPECHUB_ARGS="$(cfg_get yazi.browser_key "b")|$(cfg_get yazi.line_numbers_key "#")|$(cfg_get yazi.download_key "D")|$(cfg_get yazi.download_target "")|$(cfg_get yazi.edit_key "e")|$BEGIN|$END" \
    py "$HOME/.config/yazi/keymap.toml" <<'PY'
import os, re, sys

path = sys.argv[1]
key, numkey, dlkey, dltarget, editkey, begin, end = os.environ["SPECHUB_ARGS"].split("|")
text = open(path).read() if os.path.isfile(path) else ""
# Drop any previous managed region, both to stay idempotent and so what is
# left to inspect below is exactly the keymap the user wrote.
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)

try:
    import tomllib
except ImportError:  # tomllib is 3.11 and newer
    tomllib = None


def claimed(t):
    """True when the user's keymap declares prepend_keymap as an inline array
    under [mgr] - the one spelling our own entry cannot sit beside."""
    if not re.search(r"^\s*prepend_keymap\s*=", t, flags=re.M):
        return False
    if tomllib is None:
        # No parser to say which table that assignment sits in, so assume the
        # worst. A conceded binding costs one key; a collision costs the whole
        # keymap, because yazi answers invalid TOML by falling back to presets.
        return True
    try:
        return "prepend_keymap" in (tomllib.loads(t).get("mgr") or {})
    except Exception:
        return True


parts = []
if not claimed(text):
    # %h is the hovered file. $0 and $@ are not: yazi runs the template through
    # a shell, where $0 names the shell itself and $@ is empty - both measured,
    # and both would open the browser on nothing at all.
    #
    # --block because the delivery has something to say. On the bridge it is a
    # line of confirmation; on every other route it is a link, and a served
    # page that has to stay up. Detached, all of that goes nowhere.
    parts.append(
        "[[mgr.prepend_keymap]]\n"
        f'on = "{key}"\n'
        """run = 'shell --block -- spechub-md --browser "%h"'\n"""
        'desc = "Open in the browser you are sitting at"'
    )
    # Flipping the flag changes nothing a reader can see: the pane already
    # holds the view it drew before the key was pressed. So the binding is two
    # actions, and peek redraws it.
    #
    # --block, though the toggle has nothing to say. Detached, yazi spawns it
    # and runs peek immediately, and the pane is redrawn while the flag is
    # still whatever it was - a race the reader settles by pressing the key
    # twice. Blocking costs a frame and wins it outright.
    parts.append(
        "[[mgr.prepend_keymap]]\n"
        f'on = "{numkey}"\n'
        "run = [ 'shell --block -- spechub-md --toggle-line-numbers', 'peek --force' ]\n"
        'desc = "Preview markdown as source with line numbers"'
    )
    # `e` edits, everywhere. tuicr's diff and file tree both put the editor on
    # `e`, so yazi matching it means one key means edit across the workspace.
    # `o` is left alone: it opens by rule, which for markdown is the reader.
    #
    # ${EDITOR:-vi} rather than a fixed editor, the same expansion the opener
    # in yazi.toml uses, so both paths land in whatever the user actually runs.
    parts.append(
        "[[mgr.prepend_keymap]]\n"
        f'on = "{editkey}"\n'
        """run = 'shell --block -- ${EDITOR:-vi} "%h"'\n"""
        'desc = "Edit in $EDITOR"'
    )
    # Taildrop is Tailscale's file send. It is the one route off a headless
    # machine that needs nothing installed on the machine the user sits at,
    # and no inbound port there either.
    #
    # %h, the hovered file, for the same reason the browser key uses it. %* is
    # not a keybinding placeholder at all - yazi passes it through untouched,
    # and tailscale then reports `open %*: no such file or directory`.
    # Measured on yazi 26.8.15.
    #
    # --block because a send reports progress, and a refused one reports why.
    if dltarget:
        parts.append(
            "[[mgr.prepend_keymap]]\n"
            f'on = "{dlkey}"\n'
            f"""run = 'shell --block -- tailscale file cp "%h" {dltarget}:'\n"""
            f'desc = "Send this file to {dltarget} over Taildrop"'
        )

# The markers go down even when the binding was conceded, so the shell below
# can read the region back and see what is missing from it.
block = begin + "\n" + "\n\n".join(parts) + ("\n" if parts else "") + end
text = text.rstrip("\n")
open(path, "w").write((text + "\n\n" if text else "") + block + "\n")
PY
  local kmwritten; kmwritten="$(sed -n "/$BEGIN/,/$END/p" "$HOME/.config/yazi/keymap.toml")"
  case "$kmwritten" in *prepend_keymap*) ;; *)
    say "yazi: your keymap.toml already sets mgr.prepend_keymap as an inline"
    say "     array, which these bindings cannot sit beside. Add them there"
    say "     yourself:  shell --block -- spechub-md --browser \"%h\""
    say "     and:       [ 'shell --block -- spechub-md --toggle-line-numbers', 'peek --force' ]"
    say "     and:       shell --block -- \${EDITOR:-vi} \"%h\"" ;;
  esac
  # The download key is written from the config alone, so it can be wrong in
  # three ways the config cannot see. Name whichever one holds, rather than
  # leaving the user to read `status code: 1` out of a yazi popup.
  local dltarget; dltarget="$(cfg_get yazi.download_target "")"
  if [ -n "$dltarget" ]; then
    if ! have tailscale; then
      say "yazi: download_target names $dltarget, but this machine has no"
      say "     tailscale. Install it, or clear the key to drop the binding."
    elif ! tailscale file cp --targets >/dev/null 2>&1; then
      say "yazi: tailscale refuses file access to this user account. Run once:"
      say "       sudo tailscale set --operator=\$USER"
    elif ! tailscale file cp --targets 2>/dev/null \
         | awk -F'\t' -v t="$dltarget" '$2 == t { f = 1 } END { exit !f }'; then
      say "yazi: $dltarget is not a Taildrop target of this machine. Taildrop"
      say "     only sends between devices one Tailscale account owns on one"
      say "     tailnet. Check both ends with: tailscale file cp --targets"
    fi
  fi
  say "yazi config written"
}

apply_markdown() {
  [ "$(cfg_get markdown.enabled true)" = "true" ] || return 0
  install_binary mermaid-ascii AlexanderGrooff/mermaid-ascii Linux_x86_64
  install_binary glow charmbracelet/glow Linux_x86_64
  # Vendored so the preview page pulls nothing from a CDN: it works offline,
  # and on a managed laptop there is no third-party fetch to explain.
  local share="$HOME/.local/share/spechub"
  mkdir -p "$share"
  if [ ! -s "$share/mermaid.min.js" ]; then
    curl -fsSL -o "$share/mermaid.min.js" \
      "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" \
      && say "mermaid.js vendored to $share" \
      || say "mermaid.js download failed, the preview will fall back to a CDN"
  fi
  python3 -c 'import markdown' 2>/dev/null \
    || say "spechub-md --serve needs python markdown: pip install --user markdown"
  have chafa || say "optional: apt install chafa, to draw images as text"
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

apply_remote() {
  # A VM reached over SSH has no display and no clipboard of its own, so
  # anything that shells out to xclip fails. Put an xclip on PATH that speaks
  # OSC 52 to the terminal at the far end instead.
  [ "$(cfg_get remote.clipboard_shim true)" = "true" ] || {
    say "clipboard: xclip stand-in not installed"; return 0; }
  local real
  # Only when the machine has neither a real xclip nor a display for one to
  # talk to. Shadowing a working clipboard would be a downgrade. A stand-in
  # this script wrote before is not a real one, wherever it turns up.
  real="$(command -v xclip 2>/dev/null)"
  if [ -n "$real" ] && ! grep -q "Installed by spechub" "$real" 2>/dev/null; then
    say "clipboard: real xclip at $real, stand-in not installed"
    return 0
  fi
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    say "clipboard: this machine has a display, stand-in not installed"
    return 0
  fi
  cat > "$BIN/xclip" <<'H'
#!/usr/bin/env bash
# xclip, for a machine whose clipboard is at the other end of an SSH session.
# spechub installs this only when no real xclip is present.
#
# It exists for programs that reach for xclip directly instead of offering a
# setting. gh-dash copies pull request URLs through a Go library that looks
# only for xclip, xsel, wl-copy and termux-clipboard-set, and gives up when
# none is on PATH. This puts one there, and spechub-clip sends the text to
# the terminal's own clipboard with OSC 52.
#
# Hands over to a real xclip if one turns up on PATH with a display to talk
# to. Remove it with `setup.sh uninstall`. Installed by spechub.
set -uo pipefail

PATH="$(cd "$(dirname "$0")" 2>/dev/null && pwd):$PATH"

# A real xclip, anywhere on PATH except beside this script.
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
  while IFS= read -r candidate; do
    [ "$(cd "$(dirname "$candidate")" 2>/dev/null && pwd)" = "$self" ] && continue
    exec "$candidate" "$@"
  done < <(type -ap xclip 2>/dev/null)
fi

for arg in "$@"; do
  case "$arg" in
    -o|-out|-output) exec spechub-clip --out ;;
  esac
done
exec spechub-clip
H
  chmod +x "$BIN/xclip"
  say "clipboard: xclip stand-in written, copying over OSC 52"
}

apply_ghdash() {
  have gh || { say "gh not installed, skipping dashboard"; return 0; }
  gh extension list 2>/dev/null | grep -q gh-dash || gh extension install dlvhdr/gh-dash >/dev/null 2>&1
  mkdir -p "$(dirname "$GHDASH_CFG")"
  SPECHUB_CFG="$CFG" py "$GHDASH_CFG" <<'PY'
import os, sys, yaml
src, dst = os.environ["SPECHUB_CFG"], sys.argv[1]
# `or {}` on the section as well as the file. A bare "gh_dash:" with nothing
# under it, which is what commenting the block out leaves behind, parses to
# None, and every tw.get below then raises AttributeError. apply_ghdash died
# on that with a traceback and wrote no config at all. The keybindings and
# remote lookups below already guard the same way.
tw = ((yaml.safe_load(open(src)) or {}).get("gh_dash") or {}) if os.path.isfile(src) else {}
cfg = yaml.safe_load(open(dst)) or {} if os.path.isfile(dst) else {}
if tw.get("sections"):
    cfg["prSections"] = [{"title": s["title"], "filters": s["filters"]} for s in tw["sections"]]
if tw.get("repo_paths"):
    cfg["repoPaths"] = tw["repo_paths"]
kb = tw.get("keybindings", {}) or {}
# Every other setting reaches this script through cfg_get, which carries its
# own default. This block reads the yaml itself, so a machine with no
# terminal-workspace config used to land here with an empty dict: the prune
# below dropped the review and agent keys, and nothing was written back. D
# and S went silently dead while o, which already defaulted, kept working.
# Defaults here, matching config.example.yaml. An empty string still disables.
review = kb.get("review", "D")
agent_review = kb.get("agent_review", "S")
# "tree diff" is the old name for the review key, kept here so re-applying
# over a config written before the rename drops it rather than leaving two
# bindings on the same key.
MANAGED = ("review (tuicr)", "tree diff", "agent review", "open in browser")
prs = [k for k in (cfg.get("keybindings", {}) or {}).get("prs", [])
       if k.get("name") not in MANAGED]
if review:
    prs.append({"key": review, "name": "review (tuicr)",
                "command": "cd {{.RepoPath}} && tuicr pr {{.PrNumber}}\n"})
if agent_review:
    prs.append({"key": agent_review, "name": "agent review",
                "command": 'cd {{.RepoPath}} && claude "/code-review {{.PrNumber}}"\n'})
kbs = cfg.setdefault("keybindings", {})
# o built into gh-dash opens through $BROWSER, whose output it discards. That
# is enough for a machine with a desktop and nothing at all for one without,
# where the only way to reach a browser is to hand the terminal a link. Take
# the key so spechub-open gets a terminal to draw on. GH_HOST covers
# GitHub Enterprise, whose URLs are the same shape on a different host.
open_key = (tw.get("remote", {}) or {}).get("open_key", "o")
if open_key:
    host = "https://${GH_HOST:-github.com}"
    prs.append({"key": open_key, "name": "open in browser",
                "command": f'spechub-open "{host}/{{{{.RepoName}}}}/pull/{{{{.PrNumber}}}}"\n'})
    issues = [k for k in (cfg.get("keybindings", {}) or {}).get("issues", [])
              if k.get("name") not in MANAGED]
    issues.append({"key": open_key, "name": "open in browser",
                   "command": f'spechub-open "{host}/{{{{.RepoName}}}}/issues/{{{{.IssueNumber}}}}"\n'})
    kbs["issues"] = issues
kbs["prs"] = prs
if tw.get("page_keys", True):
    uni = [k for k in kbs.get("universal", []) if k.get("builtin") not in ("pageUp", "pageDown")]
    uni += [{"key": "pgup", "builtin": "pageUp"}, {"key": "pgdown", "builtin": "pageDown"}]
    kbs["universal"] = uni
yaml.safe_dump(cfg, open(dst, "w"), sort_keys=False, default_flow_style=False, width=200)
print("  gh-dash config written")
PY
}

case "$ACTION" in
  status)
    echo "config: $CFG $([ -f "$CFG" ] && echo '(found)' || echo '(missing, using defaults)')"
    for t in herdr delta diffnav fzf lazygit tuicr yazi glow mermaid-ascii gh; do
      case "$t" in
        gh) k=gh_dash ;; glow|mermaid-ascii) k=markdown ;; fzf) k=diffnav ;; *) k="$t" ;;
      esac
      printf '  %-13s %-14s enabled=%s\n' "$t" "$(have "$t" && echo installed || echo 'not installed')" \
        "$(cfg_get "$k.enabled" true)"
    done
    grep -q "$BEGIN" "$HERDR_CFG" 2>/dev/null && say "herdr managed block: present" || say "herdr managed block: absent"
    echo
    # Where a copy and an open actually land, which is the first thing to
    # check when o or y misbehaves on a machine reached over SSH.
    if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
      say "clipboard: this machine has a display, using its own"
    elif [ -x "$BIN/xclip" ]; then
      say "clipboard: xclip stand-in, copying to your terminal over OSC 52"
    else
      say "clipboard: none - run apply, or copy will fail in gh-dash and friends"
    fi
    # Ask the opener itself rather than repeating its rules here. Two copies
    # of this decision drifting apart is exactly how o came to claim it had
    # opened a page it had not.
    case "$(spechub-open --why 2>/dev/null)" in
      command)      say "browser: \$SPECHUB_OPEN_CMD = $SPECHUB_OPEN_CMD" ;;
      xdg-open)     say "browser: xdg-open on this machine" ;;
      wslview|wsl-open|explorer.exe)
                    say "browser: the Windows side of this machine" ;;
      opener)       say "browser: your default browser on your laptop, through the opener" ;;
      bridge)       say "browser: Chrome on your laptop, through the Playwriter bridge" ;;
      link)         say "browser: none - o hands you a ctrl+clickable link and copies it" ;;
      clipboard)    say "browser: none, and no terminal either - o copies and reports failure" ;;
      *)            say "browser: unknown - run apply" ;;
    esac
    [ -f "$HOME/.cache/spechub/open.log" ] \
      && say "last open: $(tail -1 "$HOME/.cache/spechub/open.log")"
    if [ "$(cfg_get tuicr.build_from_fork false)" = "true" ]; then
      echo
      say "tuicr: local fork build - this is meant to be temporary"
      if have gh; then
        for pr in 607 633; do
          state=$(gh pr view "$pr" --repo agavra/tuicr --json state -q .state 2>/dev/null || echo "unknown")
          printf '    agavra/tuicr#%s  %s\n' "$pr" "$state"
        done
        say "both MERGED? set tuicr.build_from_fork: false and re-run apply"
        say "check the merged key names first - review can rename them"
      else
        say "install gh to have this check agavra/tuicr#607 and #633 for you"
      fi
    fi
    ;;
  apply)
    require_yaml
    arch_supported || exit 1
    # Every setting has a default, so a missing config is a working setup and
    # not an error. Say so anyway: the alternative is a run that looks like it
    # read your settings and did not.
    [ -f "$CFG" ] || say "no config at $CFG, so every setting takes its default"
    [ "$(cfg_get enabled true)" = "true" ] || { echo "terminal workspace disabled in config"; exit 0; }
    if [ "$(cfg_get herdr.enabled true)" = "true" ] && ! have herdr; then
      # herdr ships an installer that picks the right build and verifies a
      # checksum. Prefer it over matching release asset names ourselves.
      curl -fsSL https://herdr.dev/install.sh | sh >/dev/null 2>&1 \
        && say "herdr installed" || say "herdr install failed, see herdr.dev"
    fi
    [ "$(cfg_get delta.enabled true)"   = "true" ] && install_binary delta dandavison/delta x86_64-unknown-linux-gnu
    [ "$(cfg_get diffnav.enabled true)" = "true" ] && install_binary diffnav dlvhdr/diffnav Linux_x86_64
    # fzf drives the comparison picker behind spechub-diff pick.
    [ "$(cfg_get diffnav.enabled true)" = "true" ] && install_binary fzf junegunn/fzf linux_amd64
    [ "$(cfg_get lazygit.enabled true)" = "true" ] && install_binary lazygit jesseduffield/lazygit linux_x86_64
    write_helpers
    [ "$(cfg_get tuicr.enabled true)"   = "true" ] && apply_tuicr
    apply_yazi
    apply_markdown
    [ "$(cfg_get herdr.enabled true)"   = "true" ] && apply_herdr
    [ "$(cfg_get herdr.enabled true)"   = "true" ] && apply_herdr_numbers
    [ "$(cfg_get delta.enabled true)"   = "true" ] && apply_delta
    [ "$(cfg_get remote.enabled true)" = "true" ] && apply_remote
    [ "$(cfg_get gh_dash.enabled true)" = "true" ] && apply_ghdash
    echo "done. open a herdr session and press prefix+? to see the keymap"
    ;;
  disable)
    DISABLE_USAGE="usage: setup.sh disable <herdr|delta|diffnav|gh_dash|lazygit|tuicr>"
    comp="${2:?$DISABLE_USAGE}"
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
      diffnav|gh_dash|lazygit|tuicr)
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
      yazi|markdown|remote)
        # These three have no keys to remove and no git settings to unset, so
        # there is nothing here to carry out. Refusing says so; the arm that
        # was missing let the script exit 0 in silence, which reads as done.
        say "$comp has no disable step"
        say "set $comp.enabled: false in $CFG and run apply instead"
        exit 1 ;;
      *) echo "$comp is not a component. $DISABLE_USAGE" >&2; exit 1 ;;
    esac
    ;;
  uninstall)
    "$0" disable herdr; "$0" disable delta
    # By prefix, which is why helpers are named spechub-*: anything this
    # script ever wrote goes, including helpers retired in an older version.
    herdr plugin unlink spechub.herdr-numbers >/dev/null 2>&1 || true
    rm -rf "$HOME/.config/spechub/herdr-numbers"
    rm -f "$BIN"/spechub-*
    # The xclip stand-in is the one managed file without the prefix.
    grep -q "Installed by spechub" "$BIN/xclip" 2>/dev/null && rm -f "$BIN/xclip"
    # Every file apply leaves a marked region in. Removing the region is the
    # same edit `disable herdr` makes, so whatever the user wrote around it
    # comes through untouched. Left behind, the yazi regions keep routing
    # markdown at spechub-md, a helper this command has just deleted.
    SPECHUB_ARGS="$BEGIN|$END" py \
      "$HOME/.config/tuicr/config.toml" \
      "$HOME/.config/yazi/yazi.toml" \
      "$HOME/.config/yazi/keymap.toml" <<'PY'
import os, re, sys
b, e = os.environ["SPECHUB_ARGS"].split("|")
for p in sys.argv[1:]:
    if os.path.isfile(p):
        t = open(p).read()
        open(p, "w").write(re.sub(re.escape(b) + r".*?" + re.escape(e) + r"\n?", "", t, flags=re.S))
PY
    # gh-dash reads YAML that python rewrites whole, so a marker comment never
    # survives the round trip. What identifies spechub's work there is the name
    # on each keybinding, the same handle apply_ghdash uses to replace its own
    # entries, plus the two page keys it binds. Sections, repo paths and every
    # other keybinding belong to the user and stay.
    if [ -f "$GHDASH_CFG" ] && python3 -c 'import yaml' 2>/dev/null; then
      py "$GHDASH_CFG" <<'PY'
import sys, yaml
p = sys.argv[1]
cfg = yaml.safe_load(open(p)) or {}
MANAGED = ("review (tuicr)", "tree diff", "agent review", "open in browser")
kbs = cfg.get("keybindings") or {}
for scope in ("prs", "issues"):
    if scope in kbs:
        kbs[scope] = [k for k in kbs[scope] or [] if k.get("name") not in MANAGED]
        if not kbs[scope]:
            del kbs[scope]
if "universal" in kbs:
    kbs["universal"] = [k for k in kbs["universal"] or []
                        if k.get("builtin") not in ("pageUp", "pageDown")]
    if not kbs["universal"]:
        del kbs["universal"]
if kbs:
    cfg["keybindings"] = kbs
else:
    cfg.pop("keybindings", None)
yaml.safe_dump(cfg, open(p, "w"), sort_keys=False, default_flow_style=False, width=200)
PY
      say "gh-dash keybindings removed"
    fi
    say "managed config and helpers removed. binaries left in place"
    ;;
  *) echo "usage: setup.sh [status|apply|disable <component>|uninstall]"; exit 1 ;;
esac
