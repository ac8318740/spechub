#!/usr/bin/env bash
# Guards assets/terminal-workspace/setup.sh against the two ways it has drifted
# before: docs naming helpers the script no longer writes, and the generated
# keymap colliding with a config the user wrote by hand.
#
# Every check here is offline. herdr is not required, so this runs in CI.
#
# Run it:  bash tests/test-terminal-workspace.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
SETUP="${ROOT}/assets/terminal-workspace/setup.sh"
DOCS="${ROOT}/docs/terminal-workspace.md"

for f in "$SETUP" "$DOCS"; do
  [ -f "$f" ] || { echo "FATAL: missing $f" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
skipped=0
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; skipped=$((skipped + 1)); }
# One line of a captured run, for a failure message that has to stay on one.
flat() { printf '%s' "$1" | tr '\n' '|'; }

# spechub-md builds its HTML with the python markdown package and exits 1 when
# it cannot import one, which is deliberate: there is nothing to render. Every
# check that builds a document then fails for a reason that has nothing to do
# with the code under test - --html, each --browser route, the pager's browser
# status, and the document the opener is handed. That is fourteen red lines
# saying nothing, and it is what a missing optional dependency looked like in
# CI until this guard existed. Name it once and skip those checks instead.
#
# Only the checks that actually render. The refusal paths - --html alongside
# --serve, "leaves no server behind", a missing opener token - reach no
# renderer, so they keep running and keep their coverage.
RENDERS_HTML=1
python3 -c 'import markdown' 2>/dev/null || RENDERS_HTML=0
# A skipped check is named by what it checks, never by its failure text: the
# condition was never evaluated, so "b no longer reaches the browser" would be
# a claim nothing here established. nor takes the neutral name as a second
# argument wherever the two differ, and drops any (rc=...) detail otherwise.
okr() { if [ "$RENDERS_HTML" = "1" ]; then ok "$1"; else skip "$1"; fi; }
nor() { if [ "$RENDERS_HTML" = "1" ]; then no "$1"; else skip "${2:-${1%% (rc=*}}"; fi; }
[ "$RENDERS_HTML" = "1" ] || {
  printf '  note: the python markdown package is not installed, so nothing can\n'
  printf '        render HTML. The --html and --browser checks are skipped:\n'
  printf '        apt install python3-markdown, or pip install --user markdown\n'
}

# Helper names setup.sh actually writes, and the retired ones it cleans up.
installed=$(grep -oE 'cat > "\$BIN/[a-z-]+"' "$SETUP" | sed 's|.*/||; s|"||')
retired=$(sed -n '/^  rm -f "\$BIN"\/spechub-/,/^        /p' "$SETUP" \
          | grep -oE '\$BIN"/[a-z-]+' | sed 's|.*/||')

echo "setup.sh integrity"
if bash -n "$SETUP" 2>/dev/null; then ok "setup.sh parses"; else no "setup.sh parses"; fi

# Every python helper heredoc must compile. A broken one only shows up on a
# user's machine otherwise, because setup.sh writes it without running it.
py_broken=""
for name in $installed; do
  body="$WORK/$name"
  awk -v n="$name" '$0 == "  cat > \"$BIN/" n "\" <<'\''H'\''" {f=1; next} f && $0 == "H" {exit} f' \
    "$SETUP" > "$body"
  head -1 "$body" | grep -q python || continue
  python3 -m py_compile "$body" 2>/dev/null || py_broken="$py_broken $name"
done
if [ -z "$py_broken" ]; then ok "embedded python helpers compile"
else no "embedded python helpers compile:$py_broken"; fi

echo "docs match setup.sh"
# Any spechub-* command the docs tell a reader to run must be one setup.sh
# writes. This is the check that would have caught spechub-files and
# spechub-open outliving the script that wrote them.
unknown=""
for name in $(grep -oE '\bspechub-[a-z][a-z-]*[a-z]\b' "$DOCS" | sort -u); do
  echo "$installed" | grep -qx "$name" && continue
  # Process names rather than binaries, named via exec -a inside a helper.
  # Either spelling counts: a fixed name, or a variable, which is how one
  # helper that renames itself by the mode it was asked for spells it.
  grep -qE "exec -a $name|NAME=$name\\b" "$SETUP" && continue
  # A family prefix such as spechub-herdr- names a convention, not a command.
  echo "$installed" | grep -q "^$name-" && continue
  unknown="$unknown $name"
done
if [ -z "$unknown" ]; then ok "every spechub-* in docs is installed"
else no "docs reference helpers setup.sh never writes:$unknown"; fi

stale=""
for name in $retired; do
  grep -qE "\`$name\`|\"$name\"" "$DOCS" && stale="$stale $name"
done
if [ -z "$stale" ]; then ok "no retired helper documented"
else no "docs still document retired helpers:$stale"; fi

# A changed default key must reach the docs. Catches the keymap and the prose
# drifting apart, which is how hdiff and hdash outlived themselves.
missing=""
while read -r key; do
  [ -n "$key" ] || continue
  grep -qF "$key" "$DOCS" || missing="$missing $key"
done < <(grep -oE 'cfg_get [a-z_]+\.[a-z_]*key "[^"]+"' "$SETUP" | grep -oE '"[^"]+"$' | tr -d '"')
if [ -z "$missing" ]; then ok "every default keybinding is documented"
else no "keybindings missing from docs:$missing"; fi

# A key whose default is punctuation slips through the check above: `#` is in
# every markdown heading, so grepping for it proves nothing. Name the thing
# the key does instead, which is what a reader is looking for.
if grep -qi 'line numbers' "$DOCS"; then
  ok "the line-numbers view is documented"
else
  no "the line-numbers view is not documented"
fi

# The retired-name check above only sees helpers named spechub-*. The names
# that actually rotted were hdiff and hdash, which predate that convention, so
# check the config example the way a reader uses it: every command it binds
# must be something this machine will actually have.
externals="yazi diffnav delta glow tuicr gh lazygit"
dangling=""
while read -r cmd; do
  [ -n "$cmd" ] || continue
  first=${cmd%% *}
  echo "$installed" | grep -qx "$first" && continue
  echo "$externals" | grep -qw "$first" && continue
  dangling="$dangling $first"
done < <(grep -oE '^command = "[^"]+"' "$DOCS" | sed 's/^command = "//; s/"$//')
if [ -z "$dangling" ]; then ok "every command the docs bind resolves to a real binary"
else no "docs bind commands nothing installs:$dangling"; fi

echo "keymap merge safety"
# The generated block must survive landing on a keymap somebody wrote by hand.
# TOML forbids a duplicate key, so a naive insert makes the whole file
# unparseable and herdr rejects it.
# Its own variable, not $KEYMAP: the yazi keymap section below claims that
# name for its own writer, and the herdr fixtures are seeded after it runs.
HERDR_KEYMAP="$WORK/herdr-keymap.py"
awk "/^  SPECHUB_ARGS=.*py \"\\\$HERDR_CFG\" <<'PY'\$/{f=1; next} f && /^PY\$/{exit} f" \
  "$SETUP" > "$HERDR_KEYMAP"
BEGIN_MARK="# >>> spechub terminal-workspace >>>"
END_MARK="# <<< spechub terminal-workspace <<<"
# args <chord-modifier> [theme] [theme-light] [toast-delivery] [labels] [panel-sort]
# Everything after the modifier is a setting that is not a key. Each one is
# empty here unless a check names it, which is the shape a config that says
# nothing about them produces.
args() {
  echo "$1|~/.herdr/worktrees|alt+f|alt+i|alt+y|alt+shift+y|alt+shift+f|alt+shift+i|alt+x|alt+shift+x|alt+g|alt+shift+g|alt+q|alt+shift+q|false|${2-}|true|${3-}|${4-}|${5-true}|${6-}|$BEGIN_MARK|$END_MARK"
}

cat > "$WORK/hand.toml" <<'T'
[keys]
focus_agent = "alt+1..9"
next_tab = ["prefix+n", "alt+right"]
my_own_setting = "untouched"

[[keys.command]]
key = "alt+f"
type = "popup"
command = "my-old-diff"

[[keys.command]]
key = "alt+0"
type = "popup"
command = "my-own-tool"

[theme]
name = "catppuccin"

[ui]
# Mine, and it introduces the setting below it.
pane_gaps = true
pane_scrollbars = true

[worktrees]
directory = "~/.herdr/worktrees"
T

run_keymap() {
  local mod="$1" file="$2"; shift 2
  SPECHUB_ARGS="$(args "$mod" "$@")" python3 "$HERDR_KEYMAP" "$file" 2>/dev/null
}
parses() { python3 -c "import tomllib,sys; tomllib.load(open(sys.argv[1],'rb'))" "$1" 2>/dev/null; }

cp "$WORK/hand.toml" "$WORK/merged.toml"
run_keymap alt "$WORK/merged.toml"
if parses "$WORK/merged.toml"; then ok "merging onto a hand-written keymap stays valid TOML"
else no "merging onto a hand-written keymap stays valid TOML"; fi

# Twelve managed blocks, plus the one hand-written binding on a key this
# script does not claim. The hand-written alt+f is dropped, because TOML
# forbids two commands on one key and the managed one has to win.
count=$(grep -c '^\[\[keys.command\]\]' "$WORK/merged.toml")
if [ "$count" = "13" ]; then ok "managed custom commands replace, not duplicate ($count)"
else no "expected 13 [[keys.command]] blocks, found $count"; fi

# The newest component's two keys. A key that never reaches the merged file is
# a component the user cannot open, however well the rest of apply ran.
if grep -q 'key = "alt+q"' "$WORK/merged.toml" \
   && grep -q 'spechub-herdr-tab harlequin spechub-db' "$WORK/merged.toml"
then ok "the harlequin popup and its tab variant both reach the keymap"
else no "the harlequin popup and its tab variant both reach the keymap"; fi

if grep -q 'my-own-tool' "$WORK/merged.toml" && ! grep -q 'my-old-diff' "$WORK/merged.toml"
then ok "a hand-written binding survives unless it collides with a managed key"
else no "a hand-written binding survives unless it collides with a managed key"; fi

if grep -q 'my_own_setting' "$WORK/merged.toml" && grep -q 'catppuccin' "$WORK/merged.toml"
then ok "unmanaged settings survive the merge"
else no "unmanaged settings survive the merge"; fi

# A pane's scrollbar costs the pane a column that herdr does not subtract from
# the width it reports, so a full-screen app wraps one column early and every
# row drifts left. The fix is a [ui] key, the first this script has ever
# written, and it has to beat a hand-written value rather than sit beside it:
# TOML forbids the duplicate and herdr would throw the whole file out.
ui_value=$(python3 -c "import tomllib,sys; print(tomllib.load(open(sys.argv[1],'rb'))['ui']['pane_scrollbars'])" \
  "$WORK/merged.toml" 2>/dev/null)
if [ "$ui_value" = "False" ]; then ok "apply writes pane_scrollbars = false into [ui]"
else no "expected [ui] pane_scrollbars false, parsed: ${ui_value:-nothing}"; fi

# One [ui] table, not two, and the user's own key in it comes through.
ui_tables=$(grep -c '^\[ui\]' "$WORK/merged.toml")
if [ "$ui_tables" = "1" ] && grep -q 'pane_gaps = true' "$WORK/merged.toml"
then ok "the managed [ui] key merges into the user's table instead of declaring a second"
else no "expected 1 [ui] table with pane_gaps intact, found $ui_tables"; fi

cp "$WORK/merged.toml" "$WORK/twice.toml"
run_keymap alt "$WORK/twice.toml"
if diff -q "$WORK/merged.toml" "$WORK/twice.toml" >/dev/null; then ok "re-applying is idempotent"
else no "re-applying is idempotent"; fi

# Merging into an existing [keys] needs two managed regions, not one: the bare
# keys must sit inside [keys], while [[keys.command]] and [worktrees] are
# top-level tables and cannot. What must hold is that re-applying does not
# accumulate them.
first=$(grep -c "$BEGIN_MARK" "$WORK/merged.toml")
again=$(grep -c "$BEGIN_MARK" "$WORK/twice.toml")
if [ "$first" = "$again" ]; then ok "managed blocks do not accumulate ($first)"
else no "managed blocks grew from $first to $again"; fi

# prefix+1..9 needs no modifier, so opting out of the chord family must not
# cost you workspace numbers.
cp "$WORK/hand.toml" "$WORK/none.toml"
run_keymap none "$WORK/none.toml"
if parses "$WORK/none.toml" && grep -q 'switch_workspace' "$WORK/none.toml"
then ok "switch_workspace is bound even when the chord family is off"
else no "switch_workspace is bound even when the chord family is off"; fi

# A comment that introduces a managed binding has to leave with it. Dropping the
# key but keeping its comment strands a heading over nothing, and a hand-written
# keymap ends up a run of bare headings describing keys that are gone.
cat > "$WORK/commented.toml" <<'T'
[keys]
# Panes - same vim letters as the prefix bindings.
focus_pane_left  = ["prefix+h", "alt+h"]
focus_pane_down  = ["prefix+j", "alt+j"]

# Agents.
next_agent = "alt+n"

# Mine, and nothing to do with this script.
my_own_setting = "untouched"
T
run_keymap alt "$WORK/commented.toml"
if parses "$WORK/commented.toml" \
  && ! grep -q 'vim letters' "$WORK/commented.toml" \
  && ! grep -q '^# Agents\.' "$WORK/commented.toml" \
  && grep -q 'Mine, and nothing to do' "$WORK/commented.toml" \
  && grep -q 'my_own_setting' "$WORK/commented.toml"
then ok "a comment introducing a managed binding leaves with it"
else no "a comment introducing a managed binding leaves with it"; fi

# Four settings that are not keys: a pane label, an agent-panel sort, a toast
# delivery and a theme. Only the label is written unconditionally, so a config
# that names none of the others must leave all of them exactly as they were.
labels_value=$(python3 -c "import tomllib,sys; print(tomllib.load(open(sys.argv[1],'rb'))['ui']['show_agent_labels_on_pane_borders'])" \
  "$WORK/merged.toml" 2>/dev/null)
if [ "$labels_value" = "True" ]; then ok "apply writes show_agent_labels_on_pane_borders into [ui]"
else no "expected [ui] show_agent_labels_on_pane_borders true, parsed: ${labels_value:-nothing}"; fi

if ! grep -q 'agent_panel_sort' "$WORK/merged.toml" \
  && ! grep -q 'delivery' "$WORK/merged.toml" \
  && ! grep -q 'auto_switch' "$WORK/merged.toml" \
  && grep -q 'name = "catppuccin"' "$WORK/merged.toml"
then ok "a config naming no sort, toast or theme writes none of the three"
else no "a config naming no sort, toast or theme writes none of the three"; fi

# The same file again, this time with all four named. The theme the user wrote
# by hand has to be replaced rather than joined: TOML forbids two `name` keys
# in one table, and herdr throws out a file it cannot parse.
cp "$WORK/hand.toml" "$WORK/settings.toml"
run_keymap alt "$WORK/settings.toml" catppuccin catppuccin-latte herdr true priority
if parses "$WORK/settings.toml"; then ok "writing a theme, a toast and a sort stays valid TOML"
else no "writing a theme, a toast and a sort stays valid TOML"; fi

theme_tables=$(grep -c '^\[theme\]' "$WORK/settings.toml")
if [ "$theme_tables" = "1" ]; then ok "the managed theme merges into the user's [theme] instead of declaring a second ($theme_tables)"
else no "expected 1 [theme] table, found $theme_tables"; fi

settings_read=$(python3 - "$WORK/settings.toml" <<'PYX'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], 'rb'))
t, u = d.get('theme', {}), d.get('ui', {})
print(t.get('name'), t.get('auto_switch'), t.get('dark_name'), t.get('light_name'),
      u.get('agent_panel_sort'), (u.get('toast') or {}).get('delivery'))
PYX
)
if [ "$settings_read" = "catppuccin True catppuccin catppuccin-latte priority herdr" ]
then ok "the theme, its light variant, the sort and the toast all land where herdr reads them"
else no "expected 'catppuccin True catppuccin catppuccin-latte priority herdr', parsed: ${settings_read:-nothing}"; fi

# A theme with no light variant has nothing to switch to, so the switch and
# both variant names stay out of the file.
cp "$WORK/hand.toml" "$WORK/onetheme.toml"
run_keymap alt "$WORK/onetheme.toml" catppuccin
if parses "$WORK/onetheme.toml" \
  && grep -q 'name = "catppuccin"' "$WORK/onetheme.toml" \
  && ! grep -q 'auto_switch' "$WORK/onetheme.toml" \
  && ! grep -q 'light_name' "$WORK/onetheme.toml"
then ok "a theme with no light variant writes the name alone"
else no "a theme with no light variant writes the name alone"; fi

cp "$WORK/settings.toml" "$WORK/settings-twice.toml"
run_keymap alt "$WORK/settings-twice.toml" catppuccin catppuccin-latte herdr true priority
if diff -q "$WORK/settings.toml" "$WORK/settings-twice.toml" >/dev/null
then ok "re-applying the theme, toast and sort is idempotent"
else no "re-applying the theme, toast and sort is idempotent"; fi

# Turning the pane labels off has to write `false`, not drop the key: herdr's
# own default is on, so an absent key reads as the opposite of the answer.
cp "$WORK/hand.toml" "$WORK/nolabels.toml"
run_keymap alt "$WORK/nolabels.toml" "" "" "" false
if grep -q 'show_agent_labels_on_pane_borders = false' "$WORK/nolabels.toml"
then ok "turning the pane labels off writes false rather than dropping the key"
else no "turning the pane labels off writes false rather than dropping the key"; fi

# A value can run over several lines, because TOML lets an array span as many
# as it likes. Dropping the first line alone strands the rest as bare list
# items, and herdr answers invalid TOML by rejecting every binding in the file.
cat > "$WORK/multiline.toml" <<'T'
[keys]
focus_pane_left = [
  "prefix+h",
  "alt+h",
]
my_own_setting = "untouched"

[ui]
pane_scrollbars = [
  "not really an array, but it spans lines",
]
my_own_ui = true
T
run_keymap alt "$WORK/multiline.toml"
if parses "$WORK/multiline.toml" \
  && grep -q 'my_own_setting' "$WORK/multiline.toml" \
  && grep -q 'my_own_ui' "$WORK/multiline.toml" \
  && ! grep -q 'not really an array' "$WORK/multiline.toml"
then ok "a managed value spanning several lines is dropped whole"
else no "a managed value spanning several lines is dropped whole"; fi

# A theme is one setting spelled across four keys. Claiming only the keys this
# run writes leaves a hand-written auto_switch and light_name beside the new
# name, and a light client then keeps the theme the user is replacing.
cat > "$WORK/oldtheme.toml" <<'T'
[theme]
name = "gruvbox"
auto_switch = true
dark_name = "gruvbox"
light_name = "gruvbox-light"
T
run_keymap alt "$WORK/oldtheme.toml" mocha
theme_read=$(python3 - "$WORK/oldtheme.toml" <<'PYTH'
import sys, tomllib
th = tomllib.load(open(sys.argv[1], 'rb')).get('theme', {})
print(th.get('name'), th.get('auto_switch'), th.get('dark_name'), th.get('light_name'))
PYTH
)
if [ "$theme_read" = "mocha None None None" ]
then ok "a theme replaces the user's whole theme, not just the name"
else no "expected 'mocha None None None', parsed: ${theme_read:-nothing (invalid TOML)}"; fi

echo "yazi merge safety"
# apply_yazi has the same shape of bug as the keymap writer above, but worse:
# it only ever strips and rewrites its OWN marked region, so a `[opener]` or
# `[mgr]` table the user wrote by hand elsewhere in yazi.toml is never touched.
# TOML forbids defining the same table twice, so the merged file fails to
# parse and yazi throws the whole config out, falling back to presets. The
# keymap format (bare `[keys]` settings plus `[[keys.command]]` array
# entries) never hits this because array-of-table entries are additive by
# design; yazi's plain tables are not.
YAZI="$WORK/yazi.py"
awk "/^    py \"\\\$HOME\/\.config\/yazi\/yazi\.toml\" <<'PY'\$/{f=1; next} f && /^PY\$/{exit} f" \
  "$SETUP" > "$YAZI"
args_yazi() { echo "$1|$BEGIN_MARK|$END_MARK"; }
run_yazi() { SPECHUB_ARGS="$(args_yazi "$1")" python3 "$YAZI" "$2" 2>/dev/null; }

# A hand-written yazi.toml with its own [mgr] tuning, its own [opener] entry
# for something other than markdown, and a setting in an unrelated table that
# has nothing to do with spechub at all.
cat > "$WORK/yazi-hand.toml" <<'YHAND'
[mgr]
sort_by = "alphabetical"
sort_dir_first = true

[opener]
edit = [
  { run = 'nvim "$@"', block = true, desc = "Edit" },
]

[log]
enabled = true
YHAND

cp "$WORK/yazi-hand.toml" "$WORK/yazi-merged.toml"
run_yazi true "$WORK/yazi-merged.toml"
if parses "$WORK/yazi-merged.toml"; then ok "merging onto a hand-written yazi.toml stays valid TOML"
else no "merging onto a hand-written yazi.toml stays valid TOML"; fi

if grep -q 'sort_by = "alphabetical"' "$WORK/yazi-merged.toml" \
   && grep -q "nvim" "$WORK/yazi-merged.toml"
then ok "the user's own mgr and opener settings survive the merge"
else no "the user's own mgr and opener settings survive the merge"; fi

cp "$WORK/yazi-merged.toml" "$WORK/yazi-twice.toml"
run_yazi true "$WORK/yazi-twice.toml"
if diff -q "$WORK/yazi-merged.toml" "$WORK/yazi-twice.toml" >/dev/null
then ok "re-applying the yazi config is idempotent"
else no "re-applying the yazi config is idempotent"; fi

first=$(grep -c "$BEGIN_MARK" "$WORK/yazi-merged.toml")
again=$(grep -c "$BEGIN_MARK" "$WORK/yazi-twice.toml")
if [ "$first" = "$again" ]; then ok "managed yazi blocks do not accumulate ($first)"
else no "managed yazi blocks grew from $first to $again"; fi

# No existing file at all is the one case with nothing to collide with, so
# this is the baseline: the markdown previewer and opener this feature exists
# for must actually land, not just "some valid TOML".
run_yazi true "$WORK/yazi-fresh.toml"
if parses "$WORK/yazi-fresh.toml" && python3 - "$WORK/yazi-fresh.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
md = data.get("opener", {}).get("markdown")
assert md, "no opener.markdown"
assert "spechub-md" in md[0]["run"], md[0]["run"]
previewers = data.get("plugin", {}).get("prepend_previewers", [])
assert any(p.get("url") == "*.md" for p in previewers), previewers
# Reading comes first, editing last, and the numbered read sits between them:
# the menu is ordered by how often each entry is wanted, and a reader who
# needs source line numbers still wants to read rather than edit.
runs = [e.get("run", "") for e in md]
numbered = [i for i, r in enumerate(runs) if "--numbered" in r]
assert numbered, runs
assert 0 < numbered[0] < len(runs) - 1, runs
assert "EDITOR" in runs[-1], runs
# An opener template is run as `sh -c '<run>'` with no arguments after it, so
# $0 is "sh" and $@ is empty - measured on yazi 26.8.15, where "$@" left the
# helper with no file and Enter did nothing but print its usage. %s is the
# placeholder yazi substitutes, already quoted.
for r in runs:
    assert "$@" not in r and "$0" not in r and "$1" not in r, r
    assert "%s" in r, r
PYCHK
then ok "a fresh yazi.toml gets a working markdown opener and previewer"
else no "a fresh yazi.toml gets a working markdown opener and previewer"; fi

# This is the case that actually broke in the wild: the user already had
# their own opener.markdown (their own choice of pager, say), so the managed
# block's [opener] collides on both the table AND the key. A collision this
# direct still must not corrupt the file - a warning and a skipped setting is
# fine, an unparseable config is not.
cat > "$WORK/yazi-collision.toml" <<'YCOL'
[opener]
markdown = [
  { run = 'less "$1"', block = true, desc = "Read (less)" },
]
YCOL
run_yazi true "$WORK/yazi-collision.toml"
if parses "$WORK/yazi-collision.toml"
then ok "a user-defined opener.markdown does not corrupt the merged file"
else no "a user-defined opener.markdown does not corrupt the merged file"; fi

# With no [mgr] of its own to collide with, show_hidden must actually reach
# the file - this is the one setting apply_yazi lets config.yaml override.
cat > "$WORK/yazi-nomgr.toml" <<'YNM'
[log]
enabled = true
YNM
run_yazi true "$WORK/yazi-nomgr.toml"
if parses "$WORK/yazi-nomgr.toml" && python3 - "$WORK/yazi-nomgr.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
assert data.get("mgr", {}).get("show_hidden") is True
PYCHK
then ok "show_hidden is honoured when there is no existing [mgr] to collide with"
else no "show_hidden is honoured when there is no existing [mgr] to collide with"; fi

# The collision guards above only ever look for the literal strings "[mgr]"
# and "[opener]" plus a bare "markdown =" key under it. TOML permits several
# other legal spellings of the same table: whitespace inside the brackets,
# a quoted table name, and a dotted key that opens the table implicitly with
# no header at all. Each case below is one of those legal spellings, and
# each one currently slips past the guard, so the managed block declares the
# table a second time and yazi rejects the whole file. Parseability is what
# must hold; conceding the setting to the user is an acceptable outcome.
cat > "$WORK/yazi-mgr-spaced.toml" <<'YMS'
[ mgr ]
sort_by = "natural"
YMS
run_yazi true "$WORK/yazi-mgr-spaced.toml"
if parses "$WORK/yazi-mgr-spaced.toml"
then ok "a spaced [ mgr ] header does not corrupt the merged file"
else no "a spaced [ mgr ] header does not corrupt the merged file"; fi
if grep -q 'sort_by = "natural"' "$WORK/yazi-mgr-spaced.toml"
then ok "the user's mgr setting survives a spaced [ mgr ] header"
else no "the user's mgr setting survives a spaced [ mgr ] header"; fi

cat > "$WORK/yazi-mgr-quoted.toml" <<'YMQ'
[ "mgr" ]
sort_by = "natural"
YMQ
run_yazi true "$WORK/yazi-mgr-quoted.toml"
if parses "$WORK/yazi-mgr-quoted.toml"
then ok 'a quoted [ "mgr" ] header does not corrupt the merged file'
else no 'a quoted [ "mgr" ] header does not corrupt the merged file'; fi
if grep -q 'sort_by = "natural"' "$WORK/yazi-mgr-quoted.toml"
then ok 'the user'"'"'s mgr setting survives a quoted [ "mgr" ] header'
else no 'the user'"'"'s mgr setting survives a quoted [ "mgr" ] header'; fi

cat > "$WORK/yazi-opener-spaced.toml" <<'YOS'
[ opener ]
markdown = [
  { run = 'less "$1"', block = true, desc = "Read (less)" },
]
YOS
run_yazi true "$WORK/yazi-opener-spaced.toml"
if parses "$WORK/yazi-opener-spaced.toml"
then ok "a spaced [ opener ] header with its own markdown key does not corrupt the merged file"
else no "a spaced [ opener ] header with its own markdown key does not corrupt the merged file"; fi
if grep -q 'less "$1"' "$WORK/yazi-opener-spaced.toml"
then ok "the user's own opener.markdown survives a spaced [ opener ] header"
else no "the user's own opener.markdown survives a spaced [ opener ] header"; fi

cat > "$WORK/yazi-mgr-dotted.toml" <<'YMD'
mgr.show_hidden = false
YMD
run_yazi true "$WORK/yazi-mgr-dotted.toml"
if parses "$WORK/yazi-mgr-dotted.toml"
then ok "a top-level dotted mgr.show_hidden key does not corrupt the merged file"
else no "a top-level dotted mgr.show_hidden key does not corrupt the merged file"; fi
if grep -q 'mgr.show_hidden = false' "$WORK/yazi-mgr-dotted.toml"
then ok "the user's dotted mgr.show_hidden survives the merge"
else no "the user's dotted mgr.show_hidden survives the merge"; fi

cat > "$WORK/yazi-opener-dotted.toml" <<'YOD'
opener.markdown = [
  { run = 'less "$1"', block = true, desc = "Read (less)" },
]
YOD
run_yazi true "$WORK/yazi-opener-dotted.toml"
if parses "$WORK/yazi-opener-dotted.toml"
then ok "a top-level dotted opener.markdown key does not corrupt the merged file"
else no "a top-level dotted opener.markdown key does not corrupt the merged file"; fi
if grep -q 'less "$1"' "$WORK/yazi-opener-dotted.toml"
then ok "the user's dotted opener.markdown survives the merge"
else no "the user's dotted opener.markdown survives the merge"; fi

# plugin.prepend_previewers and open.prepend_rules have no guard at all: the
# managed block always appends its own [[plugin.prepend_previewers]] and
# [[open.prepend_rules]] array-of-tables entries, unconditionally. The form
# below - a [plugin] table holding prepend_previewers as one inline array -
# is not a contrived edge case: it is the exact form yazi's own
# configuration documentation teaches for adding a custom previewer, which
# makes it the most likely real-world collision of every case in this
# section. Spechub must concede this namespace: the file must still parse,
# and the user's own *.raf entry must still be there, even though spechub's
# own entries are not.
cat > "$WORK/yazi-plugin-documented.toml" <<'YPD'
[plugin]
prepend_previewers = [ { url = "*.raf", run = "raf" } ]
YPD
run_yazi true "$WORK/yazi-plugin-documented.toml"
if parses "$WORK/yazi-plugin-documented.toml"
then ok "a documented-form [plugin] prepend_previewers does not corrupt the merged file"
else no "a documented-form [plugin] prepend_previewers does not corrupt the merged file"; fi
if parses "$WORK/yazi-plugin-documented.toml" && python3 - "$WORK/yazi-plugin-documented.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
previewers = data.get("plugin", {}).get("prepend_previewers", [])
assert any(p.get("url") == "*.raf" for p in previewers), previewers
PYCHK
then ok "the user's own *.raf previewer survives the plugin.prepend_previewers collision"
else no "the user's own *.raf previewer survives the plugin.prepend_previewers collision"; fi

# Same shape, same documentation-taught form, for open.prepend_rules.
cat > "$WORK/yazi-open-documented.toml" <<'YOPD'
[open]
prepend_rules = [ { url = "*.raf", use = "raf" } ]
YOPD
run_yazi true "$WORK/yazi-open-documented.toml"
if parses "$WORK/yazi-open-documented.toml"
then ok "a documented-form [open] prepend_rules does not corrupt the merged file"
else no "a documented-form [open] prepend_rules does not corrupt the merged file"; fi
if parses "$WORK/yazi-open-documented.toml" && python3 - "$WORK/yazi-open-documented.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
rules = data.get("open", {}).get("prepend_rules", [])
assert any(r.get("url") == "*.raf" for r in rules), rules
PYCHK
then ok "the user's own *.raf rule survives the open.prepend_rules collision"
else no "the user's own *.raf rule survives the open.prepend_rules collision"; fi

# The same two namespaces, spelled as a plain table header instead of an
# inline array. Still legal TOML, still uncollided-with by any guard, and
# the resulting redefinition ("Cannot overwrite a value") is a different
# TOML error from the array case above, so it is worth pinning separately.
cat > "$WORK/yazi-plugin-table.toml" <<'YPT'
[plugin.prepend_previewers]
url = "*.raf"
run = "raf"
YPT
run_yazi true "$WORK/yazi-plugin-table.toml"
if parses "$WORK/yazi-plugin-table.toml"
then ok "a plain [plugin.prepend_previewers] table header does not corrupt the merged file"
else no "a plain [plugin.prepend_previewers] table header does not corrupt the merged file"; fi
if parses "$WORK/yazi-plugin-table.toml" && python3 - "$WORK/yazi-plugin-table.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
table = data.get("plugin", {}).get("prepend_previewers", {})
assert table.get("url") == "*.raf", table
PYCHK
then ok "the user's own plugin.prepend_previewers table survives the collision"
else no "the user's own plugin.prepend_previewers table survives the collision"; fi

cat > "$WORK/yazi-open-table.toml" <<'YOT'
[open.prepend_rules]
url = "*.raf"
use = "raf"
YOT
run_yazi true "$WORK/yazi-open-table.toml"
if parses "$WORK/yazi-open-table.toml"
then ok "a plain [open.prepend_rules] table header does not corrupt the merged file"
else no "a plain [open.prepend_rules] table header does not corrupt the merged file"; fi
if parses "$WORK/yazi-open-table.toml" && python3 - "$WORK/yazi-open-table.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
table = data.get("open", {}).get("prepend_rules", {})
assert table.get("url") == "*.raf", table
PYCHK
then ok "the user's own open.prepend_rules table survives the collision"
else no "the user's own open.prepend_rules table survives the collision"; fi

# Every case above still gave claimed() a real dotted key to walk into. The
# four below break a different assumption it makes: that finding a key means
# the parent can still be EXTENDED. TOML says otherwise - you cannot add a
# subtable to an inline table once it is written, and you cannot overwrite a
# scalar with a table - so claimed() calling a namespace "free" is not enough;
# the block goes on to write into it anyway and the decoder rejects the
# result. Guard against a stale extraction the same way the section above
# already does: nothing below is worth running against an empty heredoc.
[ -s "$YAZI" ] || { echo "FATAL: yazi heredoc extraction produced an empty file" >&2; exit 1; }

# opener as one inline table (the shape yazi's own docs use for a simple
# opener) has no opener.markdown key at all, so claimed() sees nothing there
# and calls the namespace free. The block then appends [[opener.markdown]],
# which TOML refuses to graft onto an inline table that is already sealed.
cat > "$WORK/yazi-opener-inline.toml" <<'YOI'
opener = { text = [ { run = "vi" } ] }
YOI
run_yazi true "$WORK/yazi-opener-inline.toml"
if parses "$WORK/yazi-opener-inline.toml"
then ok "a top-level inline-table [opener] does not corrupt the merged file"
else no "a top-level inline-table [opener] does not corrupt the merged file"; fi
if grep -q 'run = "vi"' "$WORK/yazi-opener-inline.toml"
then ok "the user's own inline-table opener.text survives the collision"
else no "the user's own inline-table opener.text survives the collision"; fi

# Same shape, same bug, for plugin.prepend_previewers: an inline [plugin]
# table holding an unrelated key leaves no prepend_previewers key to find.
cat > "$WORK/yazi-plugin-inline.toml" <<'YPI'
plugin = { prepend_fetchers = [] }
YPI
run_yazi true "$WORK/yazi-plugin-inline.toml"
if parses "$WORK/yazi-plugin-inline.toml"
then ok "a top-level inline-table [plugin] does not corrupt the merged file"
else no "a top-level inline-table [plugin] does not corrupt the merged file"; fi
if grep -q 'prepend_fetchers = \[\]' "$WORK/yazi-plugin-inline.toml"
then ok "the user's own inline-table plugin.prepend_fetchers survives the collision"
else no "the user's own inline-table plugin.prepend_fetchers survives the collision"; fi

# Same shape, same bug, for open.prepend_rules.
cat > "$WORK/yazi-open-inline.toml" <<'YOPI'
open = { rules = [] }
YOPI
run_yazi true "$WORK/yazi-open-inline.toml"
if parses "$WORK/yazi-open-inline.toml"
then ok "a top-level inline-table [open] does not corrupt the merged file"
else no "a top-level inline-table [open] does not corrupt the merged file"; fi
if grep -q 'rules = \[\]' "$WORK/yazi-open-inline.toml"
then ok "the user's own inline-table open.rules survives the collision"
else no "the user's own inline-table open.rules survives the collision"; fi

# claimed() also assumes the parent it walks into is always a table. If the
# user has instead assigned opener a plain scalar, stepping into it for the
# markdown key breaks out of the walk exactly like a missing key would, so
# claimed() still calls the namespace free - and the block's attempt to
# declare [[opener.markdown]] now fails as an overwrite of a scalar rather
# than a mutation of an immutable namespace, a different decoder error worth
# pinning on its own.
cat > "$WORK/yazi-opener-scalar.toml" <<'YOSC'
opener = "nope"
YOSC
run_yazi true "$WORK/yazi-opener-scalar.toml"
if parses "$WORK/yazi-opener-scalar.toml"
then ok "a scalar [opener] value does not corrupt the merged file"
else no "a scalar [opener] value does not corrupt the merged file"; fi
if grep -q 'opener = "nope"' "$WORK/yazi-opener-scalar.toml"
then ok "the user's own scalar opener value survives the collision"
else no "the user's own scalar opener value survives the collision"; fi

# The four cases above all exercise the tomllib path. The fallback regexes -
# used only when tomllib is unavailable (Python <3.11) - accept an
# optionally DOUBLE-quoted key, but TOML also allows a LITERAL-string key in
# SINGLE quotes, which is exactly as legal and exactly as ordinary a thing
# for a real user to write. The fallback regex simply does not match it: it
# calls the namespace free, and the managed block declares [mgr] a second
# time.
#
# This machine runs Python 3.12, so reaching that branch means forcing
# `import tomllib` to fail. A tomllib.py placed on PYTHONPATH - never inside
# $WORK, which is already the script's own directory and sits on sys.path
# for every other case in this section, so a shim there would poison all of
# them - shadows the real stdlib module and raises ImportError, tripping the
# script's own `except ImportError: tomllib = None`. The shim also drops a
# marker file the instant it runs, so the runner below can confirm the
# fallback was genuinely exercised instead of quietly parsing with the real
# tomllib and passing the check for the wrong reason.
NOTOMLLIB_DIR="$WORK/notomllib"
mkdir -p "$NOTOMLLIB_DIR"
cat > "$NOTOMLLIB_DIR/tomllib.py" <<'SHIM'
import os
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "shadow-hit"), "w").close()
raise ImportError("tomllib intentionally unavailable: forcing the no-tomllib fallback for a test")
SHIM

run_yazi_no_tomllib() {  # [no-tomllib fallback] runner: $1=hidden $2=path
  rm -f "$NOTOMLLIB_DIR/shadow-hit"
  SPECHUB_ARGS="$(args_yazi "$1")" PYTHONPATH="$NOTOMLLIB_DIR" python3 "$YAZI" "$2" 2>/dev/null
  [ -f "$NOTOMLLIB_DIR/shadow-hit" ] || {
    echo "FATAL: no-tomllib shim did not shadow the stdlib import - the fallback" >&2
    echo "       branch was never exercised, which would make the checks below" >&2
    echo "       pass for the wrong reason" >&2
    exit 1
  }
}

# [no-tomllib fallback] A single-quoted literal-string table header names the
# same top-level mgr table as [mgr]. Legal TOML, invisible to the
# double-quote-only regex.
cat > "$WORK/yazi-fallback-mgr-quoted.toml" <<'YFMQ'
['mgr']
sort_by = "natural"
YFMQ
run_yazi_no_tomllib true "$WORK/yazi-fallback-mgr-quoted.toml"
if parses "$WORK/yazi-fallback-mgr-quoted.toml"
then ok "[no-tomllib fallback] a single-quoted ['mgr'] header does not corrupt the merged file"
else no "[no-tomllib fallback] a single-quoted ['mgr'] header does not corrupt the merged file"; fi
if parses "$WORK/yazi-fallback-mgr-quoted.toml" && python3 - "$WORK/yazi-fallback-mgr-quoted.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
assert data.get("mgr", {}).get("sort_by") == "natural", data.get("mgr")
PYCHK
then ok "[no-tomllib fallback] the user's mgr setting survives a single-quoted ['mgr'] header"
else no "[no-tomllib fallback] the user's mgr setting survives a single-quoted ['mgr'] header"; fi

# [no-tomllib fallback] A single-quoted literal-string dotted key opens mgr
# implicitly, with no table header at all. Same failure mode, same regex gap.
cat > "$WORK/yazi-fallback-mgr-dotted.toml" <<'YFMD'
'mgr'.show_hidden = false
YFMD
run_yazi_no_tomllib true "$WORK/yazi-fallback-mgr-dotted.toml"
if parses "$WORK/yazi-fallback-mgr-dotted.toml"
then ok "[no-tomllib fallback] a single-quoted 'mgr'.show_hidden key does not corrupt the merged file"
else no "[no-tomllib fallback] a single-quoted 'mgr'.show_hidden key does not corrupt the merged file"; fi
if parses "$WORK/yazi-fallback-mgr-dotted.toml" && python3 - "$WORK/yazi-fallback-mgr-dotted.toml" <<'PYCHK'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
assert data.get("mgr", {}).get("show_hidden") is False, data.get("mgr")
PYCHK
then ok "[no-tomllib fallback] the user's dotted 'mgr'.show_hidden survives the merge"
else no "[no-tomllib fallback] the user's dotted 'mgr'.show_hidden survives the merge"; fi

echo "sidebar grouping"
# The renumber's whole job is to reproduce the order the sidebar draws. Get the
# grouping wrong and it writes a worse order than it found, so pin the two rules
# that are not obvious from reading it.
RENUM="$WORK/renumber"
awk "/^  cat > \"\\\$BIN\/spechub-herdr-renumber\" <<'H'\$/{f=1; next} f && /^H\$/{exit} f" \
  "$SETUP" > "$RENUM"
if python3 - "$RENUM" <<'PYCHK'
import sys, types
mod = types.ModuleType("r")
src = open(sys.argv[1]).read().replace('if __name__ == "__main__":\n    main()', '')
exec(compile(src, "r", "exec"), mod.__dict__)


def ws(wid, root, linked):
    return {"workspace_id": wid,
            "worktree": {"repo_root": root, "is_linked_worktree": linked}}


# A worktree stored above its parent must not drag the parent below it, and
# must not pull its whole group to the top either.
scrambled = [ws("wT", "/spechub", True), ws("w1", "/plug", False),
             ws("wQ", "/spechub", False), ws("wS", "/spechub", True)]
got = mod.grouped_order(scrambled)
assert got.index("wQ") < got.index("wT"), got
assert got.index("wQ") < got.index("wS"), got
assert got[0] == "w1", got

# Rows of one repo stay contiguous.
mixed = [ws("a", "/x", False), ws("b", "/y", False),
         ws("c", "/x", True), ws("d", "/y", True)]
got = mod.grouped_order(mixed)
assert got == ["a", "c", "b", "d"], got

# A group whose repo checkout was never opened still anchors somewhere sane.
orphan = [ws("only", "/z", True), ws("root", "/w", False)]
assert mod.grouped_order(orphan) == ["only", "root"], mod.grouped_order(orphan)
PYCHK
then ok "grouping puts a repo above its worktrees and keeps groups contiguous"
else no "grouping puts a repo above its worktrees and keeps groups contiguous"; fi

echo "copy and open from a remote machine"
# gh-dash's o, y and Y all fail on a machine with no display: xdg-open exits 1
# and the Go clipboard library finds no xclip to shell out to. These pin the
# two helpers that carry each one back to the terminal you are typing at.
extract() {  # extract <helper-name> -> path
  local name="$1" out="$WORK/$1"
  awk -v n="$name" '$0 == "  cat > \"$BIN/" n "\" <<'\''H'\''" {f=1; next} f && $0 == "H" {exit} f' \
    "$SETUP" > "$out"
  chmod +x "$out"
  printf '%s' "$out"
}
CLIPBIN="$WORK/remote-bin"
mkdir -p "$CLIPBIN" "$WORK/remote-home"
cp "$(extract spechub-clip)" "$CLIPBIN/spechub-clip"
cp "$(extract spechub-open)" "$CLIPBIN/spechub-open"
cp "$(extract xclip)"        "$CLIPBIN/xclip"
# No display, no clipboard, and only the extracted helpers on PATH: a bare VM.
bare() { env -i PATH="$CLIPBIN:/usr/bin:/bin" HOME="$WORK/remote-home" "$@"; }

osc=$(bare bash -c 'printf pr-42 | spechub-clip' 2>&1 >/dev/null)
back=$(bare spechub-clip --out 2>/dev/null)
# ESC ] 52 ; c ; <base64 of "pr-42"> BEL
if [ "$osc" = "$(printf '\033]52;c;cHItNDI=\a')" ] && [ "$back" = "pr-42" ]; then
  ok "spechub-clip copies over OSC 52 and replays it"
else
  no "spechub-clip OSC 52 round trip (got '$(printf '%s' "$osc" | cat -v)' / '$back')"
fi

# What gh-dash's clipboard library actually runs, argument for argument.
bare bash -c 'printf pr-43 | xclip -in -selection clipboard' >/dev/null 2>&1
if [ "$(bare xclip -out -selection clipboard 2>/dev/null)" = "pr-43" ]; then
  ok "the xclip stand-in speaks the flags gh-dash passes it"
else
  no "the xclip stand-in speaks the flags gh-dash passes it"
fi

# o is a gh-dash keybinding, not a $BROWSER setting: gh-dash runs $BROWSER
# with its output discarded and the dashboard still drawn, so the link route
# would have nowhere to draw. Run the real config writer and read the result.
GHKB="$WORK/ghdash.py"
awk "/^  SPECHUB_CFG=.*py \"\\\$GHDASH_CFG\" <<'PY'\$/{f=1; next} f && /^PY\$/{exit} f" \
  "$SETUP" > "$GHKB"
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  : > "$WORK/gh-tw.yaml"
  printf 'prSections:\n- {title: Mine, filters: "is:open"}\n' > "$WORK/gh-dash.yml"
  SPECHUB_CFG="$WORK/gh-tw.yaml" python3 "$GHKB" "$WORK/gh-dash.yml" >/dev/null 2>&1
  if python3 - "$WORK/gh-dash.yml" <<'GHCHK'
import sys, yaml
kb = (yaml.safe_load(open(sys.argv[1])) or {}).get("keybindings", {})
for view, path in (("prs", "/pull/"), ("issues", "/issues/")):
    binds = [k for k in kb.get(view, []) if k.get("key") == "o"]
    assert len(binds) == 1, (view, kb.get(view))
    cmd = binds[0]["command"]
    assert cmd.startswith("spechub-open "), cmd
    assert path in cmd, (view, cmd)
GHCHK
  then ok "apply_ghdash binds o to spechub-open for prs and issues"
  else no "apply_ghdash binds o to spechub-open for prs and issues"; fi
else
  ok "apply_ghdash keybindings skipped (no PyYAML)"
fi

# Re-applying must replace that binding, never stack a second o on top of it.
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  SPECHUB_CFG="$WORK/gh-tw.yaml" python3 "$GHKB" "$WORK/gh-dash.yml" >/dev/null 2>&1
  if [ "$(python3 -c '
import sys, yaml
kb = (yaml.safe_load(open(sys.argv[1])) or {}).get("keybindings", {})
print(sum(1 for v in ("prs", "issues") for k in kb.get(v, []) if k.get("key") == "o"))
' "$WORK/gh-dash.yml")" = "2" ]; then
    ok "re-applying does not stack a second o binding"
  else
    no "re-applying does not stack a second o binding"
  fi
fi

# D is the review keybinding: gh_dash.keybindings.review in the terminal
# workspace yaml, mirroring the o-binding checks above but for tuicr review.
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  printf 'gh_dash:\n  keybindings:\n    review: D\n' > "$WORK/gh-tw-review.yaml"
  printf 'prSections:\n- {title: Mine, filters: "is:open"}\n' > "$WORK/gh-dash-review.yml"
  SPECHUB_CFG="$WORK/gh-tw-review.yaml" python3 "$GHKB" "$WORK/gh-dash-review.yml" >/dev/null 2>&1
  if python3 - "$WORK/gh-dash-review.yml" <<'GHCHK'
import sys, yaml
kb = (yaml.safe_load(open(sys.argv[1])) or {}).get("keybindings", {})
binds = [k for k in kb.get("prs", []) if k.get("key") == "D"]
assert len(binds) == 1, kb.get("prs")
b = binds[0]
assert b.get("name") == "review (tuicr)", b
assert b.get("command", "").strip() == "cd {{.RepoPath}} && tuicr pr {{.PrNumber}}", b
GHCHK
  then ok "apply_ghdash binds D to review (tuicr) for prs"
  else no "apply_ghdash binds D to review (tuicr) for prs"; fi
else
  ok "apply_ghdash D keybinding skipped (no PyYAML)"
fi

# "tree diff" is the old name for the same D key. Re-applying over a config
# written before the rename must prune it rather than leave two D bindings
# stacked on the prs view.
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  printf 'keybindings:\n  prs:\n  - {key: D, name: tree diff, command: "gh pr diff {{.PrNumber}} --repo {{.RepoName}} | diffnav"}\n' \
    > "$WORK/gh-dash-review.yml"
  SPECHUB_CFG="$WORK/gh-tw-review.yaml" python3 "$GHKB" "$WORK/gh-dash-review.yml" >/dev/null 2>&1
  if python3 - "$WORK/gh-dash-review.yml" <<'GHCHK'
import sys, yaml
kb = (yaml.safe_load(open(sys.argv[1])) or {}).get("keybindings", {})
binds = [k for k in kb.get("prs", []) if k.get("key") == "D"]
assert len(binds) == 1, kb.get("prs")
assert binds[0].get("name") == "review (tuicr)", binds[0]
GHCHK
  then ok "re-applying prunes the old 'tree diff' D binding rather than stacking it"
  else no "re-applying prunes the old 'tree diff' D binding rather than stacking it"; fi
else
  ok "tree diff prune check skipped (no PyYAML)"
fi

# A machine with no terminal-workspace yaml still gets D and S. Every other
# setting reaches setup.sh through cfg_get, which defaults; this block reads
# the yaml itself, and without defaults of its own an absent file pruned both
# managed bindings and wrote nothing back. o kept working, so the dashboard
# looked configured while the two review keys were dead.
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  printf 'prSections:\n- {title: Mine, filters: "is:open"}\n' > "$WORK/gh-dash-nocfg.yml"
  SPECHUB_CFG="$WORK/does-not-exist.yaml" python3 "$GHKB" "$WORK/gh-dash-nocfg.yml" >/dev/null 2>&1
  if python3 - "$WORK/gh-dash-nocfg.yml" <<'GHCHK'
import sys, yaml
kb = (yaml.safe_load(open(sys.argv[1])) or {}).get("keybindings", {})
by_name = {k.get("name"): k for k in kb.get("prs", [])}
assert by_name["review (tuicr)"]["key"] == "D", kb.get("prs")
assert by_name["agent review"]["key"] == "S", kb.get("prs")
GHCHK
  then ok "with no terminal-workspace config, D and S still bind to their defaults"
  else no "with no terminal-workspace config, D and S still bind to their defaults"; fi
else
  ok "gh-dash default keybinding check skipped (no PyYAML)"
fi

# An empty string is how the config turns one of those keys off, so a default
# must not put it back. config.example.yaml says so about agent_review.
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  printf 'gh_dash:\n  keybindings:\n    agent_review: ""\n' > "$WORK/gh-tw-noagent.yaml"
  printf 'prSections:\n- {title: Mine, filters: "is:open"}\n' > "$WORK/gh-dash-noagent.yml"
  SPECHUB_CFG="$WORK/gh-tw-noagent.yaml" python3 "$GHKB" "$WORK/gh-dash-noagent.yml" >/dev/null 2>&1
  if python3 - "$WORK/gh-dash-noagent.yml" <<'GHCHK'
import sys, yaml
kb = (yaml.safe_load(open(sys.argv[1])) or {}).get("keybindings", {})
names = [k.get("name") for k in kb.get("prs", [])]
assert "agent review" not in names, names
assert "review (tuicr)" in names, names
GHCHK
  then ok "an empty keybinding in the config disables it rather than taking the default"
  else no "an empty keybinding in the config disables it rather than taking the default"; fi
else
  ok "gh-dash empty keybinding check skipped (no PyYAML)"
fi

# "gh_dash:" with nothing under it is what commenting the block out leaves
# behind, and yaml parses it to None. Every tw.get then raised AttributeError,
# so apply_ghdash died with a traceback and wrote no config at all.
if python3 -c 'import yaml' 2>/dev/null && [ -s "$GHKB" ]; then
  printf 'gh_dash:\n' > "$WORK/gh-tw-null.yaml"
  printf 'prSections:\n- {title: Mine, filters: "is:open"}\n' > "$WORK/gh-dash-null.yml"
  nullerr=$(SPECHUB_CFG="$WORK/gh-tw-null.yaml" python3 "$GHKB" "$WORK/gh-dash-null.yml" 2>&1 >/dev/null)
  if [ -z "$nullerr" ] && python3 - "$WORK/gh-dash-null.yml" <<'GHCHK'
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1])) or {}
names = [k.get("name") for k in cfg.get("keybindings", {}).get("prs", [])]
assert "review (tuicr)" in names, names
assert [s["title"] for s in cfg.get("prSections", [])] == ["Mine"], cfg.get("prSections")
GHCHK
  then ok "an empty gh_dash section falls back to defaults instead of raising"
  else no "an empty gh_dash section falls back to defaults instead of raising"; fi
else
  ok "gh-dash null section check skipped (no PyYAML)"
fi

# The route that always works: a terminal, and nothing else. script gives the
# helper a pty, which is what tells it to draw a link rather than give up.
screen=$(printf x | bare script -qec 'SPECHUB_OPEN_BRIDGE=off spechub-open https://example.com/pr/9' /dev/null 2>/dev/null)
if printf '%s' "$screen" | grep -q $'\033]8;;https://example.com/pr/9\033' \
   && [ "$(bare spechub-clip --out 2>/dev/null)" = "https://example.com/pr/9" ]; then
  ok "with a terminal and no browser, o draws a clickable link and copies it"
else
  no "with a terminal and no browser, o draws a clickable link and copies it"
fi

# The bridge is only taken once it has proved a browser is on the other end.
# With no relay answering at all, it must not even be asked - probing starts a
# browser as a side effect.
if [ "$(bare spechub-open --why 2>/dev/null)" != "bridge" ]; then
  ok "the bridge route is skipped when nothing has attached to it"
else
  no "the bridge route is skipped when nothing has attached to it"
fi

# A relay answering on its HTTP port is not a browser. The Playwriter
# extension attaches per tab, and /json/list is its own answer about that:
# [] means armed on nothing. Driving the bridge in that state is what let
# agent-browser fall back to a headless Chrome nobody could see.
#
# These two pin both halves against a stub relay. agent-browser must exist on
# PATH for the route to be considered, but must never be run to decide it - a
# stub that fails loudly proves the decision costs no browser.
printf '#!/bin/sh\necho "agent-browser must not run during routing" >&2\nexit 97\n' \
  > "$CLIPBIN/agent-browser"
chmod +x "$CLIPBIN/agent-browser"

cat > "$WORK/relay.py" <<'RELAY'
import http.server, socketserver, sys, threading
body = sys.argv[1].encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        payload = body if self.path == "/json/list" else b'{"Browser":"Stub/1.0"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
RELAY

# Sets $BURL and $RELAY_PID directly rather than printing the url: a command
# substitution runs in a subshell, so the pid to kill would not survive it.
relay_up() {  # relay_up <json-list-body>
  rm -f "$WORK/relay.port"
  python3 "$WORK/relay.py" "$1" > "$WORK/relay.port" 2>/dev/null &
  RELAY_PID=$!
  local i=0
  while [ ! -s "$WORK/relay.port" ] && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.1; done
  BURL="http://127.0.0.1:$(cat "$WORK/relay.port")"
}

relay_up '[]' 
if [ "$(bare env SPECHUB_BRIDGE_URL="$BURL" spechub-open --why 2>/dev/null)" != "bridge" ]; then
  ok "a relay with the extension armed on no tab is not treated as a browser"
else
  no "a relay with the extension armed on no tab is not treated as a browser"
fi
kill "$RELAY_PID" 2>/dev/null; wait "$RELAY_PID" 2>/dev/null
rm -f "$WORK/relay.port"

relay_up '[{"id":"1","type":"page","url":"https://example.com"}]'
if [ "$(bare env SPECHUB_BRIDGE_URL="$BURL" spechub-open --why 2>/dev/null)" = "bridge" ]; then
  ok "a relay with the extension armed on a tab is taken as the bridge route"
else
  no "a relay with the extension armed on a tab is taken as the bridge route"
fi
kill "$RELAY_PID" 2>/dev/null; wait "$RELAY_PID" 2>/dev/null
rm -f "$WORK/relay.port" "$CLIPBIN/agent-browser"

if [ "$(bare env SPECHUB_OPEN_CMD=echo spechub-open https://example.com 2>/dev/null)" \
     = "https://example.com" ]; then
  ok "spechub-open obeys \$SPECHUB_OPEN_CMD"
else
  no "spechub-open obeys \$SPECHUB_OPEN_CMD"
fi

# Nothing reachable is not the same as nothing done: the URL lands on the
# clipboard rather than being lost.
bare env SPECHUB_OPEN_BRIDGE=off spechub-open https://example.com/pr/7 >/dev/null 2>&1
if [ "$(bare spechub-clip --out 2>/dev/null)" = "https://example.com/pr/7" ]; then
  ok "spechub-open falls back to the clipboard when no browser is reachable"
else
  no "spechub-open falls back to the clipboard when no browser is reachable"
fi

echo "spechub-diff drops what diffnav cannot draw"
# delta dies on SIGABRT on a line hundreds of kilobytes long, and diffnav
# reports its child's death as "FATA signal: aborted (core dumped)" and quits.
# One committed source map therefore took a whole diff down. The helper drops
# that file and draws the rest, so these pin both halves: the long-lined file
# never reaches diffnav, and the file beside it still does.
DIFFBIN="$WORK/diff-bin"; DIFFREPO="$WORK/diff-repo"
mkdir -p "$DIFFBIN" "$DIFFREPO"
cp "$(extract spechub-diff)" "$DIFFBIN/spechub-diff"
# The stub keeps what it was handed, which is the whole point of the check.
cat > "$DIFFBIN/diffnav" <<'STUB'
#!/bin/sh
cat > "$SPECHUB_TEST_SEEN"
STUB
chmod +x "$DIFFBIN/diffnav"

if command -v git >/dev/null 2>&1; then
  (
    cd "$DIFFREPO" || exit 1
    git init -q . && git config user.email t@example.com && git config user.name t
    printf 'one\n' > small.txt
    printf 'x\n' > big.map
    git add -A && git commit -qm first
    printf 'two\n' > small.txt
    # 30000 characters on one line: over the 20000 default, under the size
    # that makes delta abort, so the check needs no huge fixture.
    awk 'BEGIN { s = ""; while (length(s) < 30000) s = s "abcdefghij"; print s }' > big.map
  ) >/dev/null 2>&1
  SEEN="$WORK/diff-seen"
  env -i PATH="$DIFFBIN:/usr/bin:/bin" HOME="$WORK" SPECHUB_TEST_SEEN="$SEEN" \
    sh -c "cd '$DIFFREPO' && spechub-diff auto" >/dev/null 2>&1
  if [ -s "$SEEN" ] \
     && grep -q '^diff --git a/small.txt' "$SEEN" \
     && ! grep -q '^diff --git a/big.map' "$SEEN" \
     && grep -qE '^skipped  big\.map  \(one line is 3000[0-9] chars' "$SEEN"; then
    ok "a file with a 30000-character line is dropped, named, and the rest is drawn"
  else
    no "a file with a 30000-character line is dropped, named, and the rest is drawn"
  fi

  # Nothing left to draw is not the same as nothing changed. The old code said
  # "No difference between these two", which is a claim about the repository
  # rather than about diffnav, and the file that was dropped went unmentioned.
  ( cd "$DIFFREPO" && git checkout -q -- small.txt ) >/dev/null 2>&1
  ALL=$(env -i PATH="$DIFFBIN:/usr/bin:/bin" HOME="$WORK" SPECHUB_TEST_SEEN="$SEEN" \
    sh -c "cd '$DIFFREPO' && printf x | spechub-diff auto" 2>&1)
  if printf '%s' "$ALL" | grep -q 'skipped  big.map' \
     && printf '%s' "$ALL" | grep -q 'too long for diffnav' \
     && ! printf '%s' "$ALL" | grep -q 'No difference between these two'; then
    ok "a diff of nothing but long-lined files says so instead of claiming no change"
  else
    no "a diff of nothing but long-lined files says so instead of claiming no change"
  fi
  # A limit that is not a positive whole number reaches awk as a string, and
  # awk then compares every line length against text: never true, so the guard
  # silently switches itself off and the abort it exists to prevent comes back.
  ( cd "$DIFFREPO" && printf 'three\n' > small.txt ) >/dev/null 2>&1
  BAD=$(env -i PATH="$DIFFBIN:/usr/bin:/bin" HOME="$WORK" SPECHUB_TEST_SEEN="$SEEN" \
    SPECHUB_DIFF_LINE_LIMIT=abc \
    sh -c "cd '$DIFFREPO' && spechub-diff auto" 2>&1 >/dev/null)
  if printf '%s' "$BAD" | grep -q 'not a' \
     && ! grep -q '^diff --git a/big.map' "$SEEN"; then
    ok "a non-numeric line limit is refused out loud and the guard stays on"
  else
    no "a non-numeric line limit is refused out loud and the guard stays on"
  fi
else
  skip "spechub-diff long-line checks (git not installed)"
  skip "spechub-diff all-skipped check (git not installed)"
  skip "spechub-diff line limit validation (git not installed)"
fi

echo "spechub-view"
# tuicr's <leader>v hands the focused file to this, and what comes back has to
# be a terminal program so `q` returns to tuicr. These pin which one each file
# type reaches, with stubs standing in for the real viewers.
VIEWBIN="$WORK/view-bin"
mkdir -p "$VIEWBIN" "$WORK/viewfiles"
cp "$(extract spechub-view)" "$VIEWBIN/spechub-view"
for stub in spechub-md yazi; do
  printf '#!/bin/sh\necho "%s $*"\n' "$stub" > "$VIEWBIN/$stub"
  chmod +x "$VIEWBIN/$stub"
done
viewrun() { env -i PATH="$VIEWBIN:/usr/bin:/bin" "$VIEWBIN/spechub-view" "$@"; }

: > "$WORK/viewfiles/notes.md"
: > "$WORK/viewfiles/NOTES.markdown"
: > "$WORK/viewfiles/main.rs"

if [ "$(viewrun "$WORK/viewfiles/notes.md" 2>/dev/null)" \
     = "spechub-md $WORK/viewfiles/notes.md" ]; then
  ok "spechub-view sends markdown to spechub-md"
else
  no "spechub-view sends markdown to spechub-md"
fi

# The suffix match must not be case-exact, or a .markdown from a different
# editor silently lands in the file manager instead of the renderer.
if [ "$(viewrun "$WORK/viewfiles/NOTES.markdown" 2>/dev/null)" \
     = "spechub-md $WORK/viewfiles/NOTES.markdown" ]; then
  ok "spechub-view recognises .markdown as well as .md"
else
  no "spechub-view recognises .markdown as well as .md"
fi

if [ "$(viewrun "$WORK/viewfiles/main.rs" 2>/dev/null)" \
     = "yazi $WORK/viewfiles/main.rs" ]; then
  ok "spechub-view sends everything else to yazi"
else
  no "spechub-view sends everything else to yazi"
fi

# A path tuicr could not resolve must say so and fail, not open the file
# manager on the current directory as if nothing were wrong.
viewrun "$WORK/viewfiles/gone.rs" >/dev/null 2>&1
if [ "$?" = "1" ]; then
  ok "spechub-view fails on a path that does not exist"
else
  no "spechub-view fails on a path that does not exist"
fi

viewrun >/dev/null 2>&1
if [ "$?" = "2" ]; then
  ok "spechub-view with no argument reports usage"
else
  no "spechub-view with no argument reports usage"
fi

# Neither viewer installed is not a reason to show nothing.
rm -f "$VIEWBIN/yazi" "$VIEWBIN/spechub-md"
printf 'body-line\n' > "$WORK/viewfiles/plain.txt"
if env -i PATH="$VIEWBIN:/usr/bin:/bin" PAGER=cat \
     "$VIEWBIN/spechub-view" "$WORK/viewfiles/plain.txt" 2>/dev/null \
     | grep -q "body-line"; then
  ok "spechub-view falls back to a pager when no viewer is installed"
else
  no "spechub-view falls back to a pager when no viewer is installed"
fi

echo "why a gh-dash action failed"
# gh-dash runs gh for every action it takes and throws the command's stderr
# away, so GitHub refusing one arrives as "exit status 1" in the footer for two
# seconds. Approving your own pull request is the everyday case: GitHub always
# refuses it, and the dashboard looks like it did nothing at all. spechub-gh
# goes on PATH under the name gh and carries the refusal to a notification.
GHBIN="$WORK/gh-bin"; SHIMDIR="$WORK/gh-shim"
mkdir -p "$GHBIN" "$SHIMDIR"
cp "$(extract spechub-gh)" "$SHIMDIR/gh"

# Stands in for the real gh: reports what it was handed, fails when told to.
cat > "$GHBIN/gh" <<'T'
#!/usr/bin/env bash
echo "real gh got: $*"
[ "${GH_EXIT:-0}" = "0" ] || echo "Can not approve your own pull request." >&2
exit "${GH_EXIT:-0}"
T
# Records the notification the shim raises, so a check can read it back.
cat > "$GHBIN/herdr" <<'T'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NOTES"
T
chmod +x "$GHBIN/gh" "$GHBIN/herdr"

NOTES="$WORK/notes"
# The shim first, the stand-in gh behind it: the arrangement spechub-dash makes.
run_gh() {
  local code="$1"; shift
  env PATH="$SHIMDIR:$GHBIN:/usr/bin:/bin" NOTES="$NOTES" GH_EXIT="$code" gh "$@"
}

: > "$NOTES"
out=$(run_gh 3 pr view 7 2>"$WORK/gh-err"); rc=$?
if [ "$rc" = "3" ] && [ "$out" = "real gh got: pr view 7" ] \
   && grep -q "Can not approve" "$WORK/gh-err"; then
  ok "the gh shim passes arguments, both streams and the exit code through"
else
  no "the gh shim passes arguments, both streams and the exit code through (rc=$rc, out='$out')"
fi

if grep -q "notification show" "$NOTES" \
   && grep -q "Can not approve your own pull request." "$NOTES"; then
  ok "a failed pull request action says why, in a notification"
else
  no "a failed pull request action says why, in a notification (got '$(cat "$NOTES")')"
fi

: > "$NOTES"
run_gh 0 pr comment 7 --body hello >/dev/null 2>&1
if [ ! -s "$NOTES" ]; then
  ok "an action that worked stays quiet"
else
  no "an action that worked stays quiet (got '$(cat "$NOTES")')"
fi

# The dashboard is not an action. It owns the terminal for as long as it runs,
# and a notification about its exit code would be noise.
: > "$NOTES"
run_gh 4 dash --config /dev/null >/dev/null 2>&1
rc=$?
if [ "$rc" = "4" ] && [ ! -s "$NOTES" ]; then
  ok "gh dash itself is handed straight to the real gh"
else
  no "gh dash itself is handed straight to the real gh (rc=$rc, notes='$(cat "$NOTES")')"
fi

# gh's own plumbing fails for reasons a notification cannot help with, and
# spechub-dash calls gh repo view before the dashboard even starts.
: > "$NOTES"
run_gh 1 repo view --json nameWithOwner >/dev/null 2>&1
if [ ! -s "$NOTES" ]; then
  ok "a failure outside pr and issue raises nothing"
else
  no "a failure outside pr and issue raises nothing (got '$(cat "$NOTES")')"
fi

# None of the above reaches gh-dash unless spechub-dash puts the shim first.
if grep -q 'PATH="\$SHIM:\$PATH"' "$(extract spechub-dash)"; then
  ok "spechub-dash puts the gh shim at the front of \$PATH"
else
  no "spechub-dash puts the gh shim at the front of \$PATH"
fi

echo "spechub-md --preview"
# yazi's previewer runs spechub-md in a pane, not a terminal: no tty on any of
# the three streams, COLUMNS set by the caller instead of a tty query, and no
# room for a pager. --preview does not exist yet, so every check below pins
# the contract the previewer needs rather than the mechanism.
MD="$(extract spechub-md)"
cat > "$WORK/preview.md" <<'MD1'
# Preview me

Some ordinary prose, nothing fancy.
MD1

# The regression check: must exit 0 and must never fall through to the usage
# line, with nothing resembling a tty anywhere in the pipeline.
preview_out="$WORK/preview.out"
preview_err="$WORK/preview.err"
COLUMNS=100 "$MD" --preview "$WORK/preview.md" </dev/null >"$preview_out" 2>"$preview_err"
preview_rc=$?
if [ "$preview_rc" -eq 0 ] \
   && ! grep -q 'usage: spechub-md' "$preview_out" "$preview_err"
then
  ok "--preview exits 0 and never prints the usage line"
else
  no "--preview exits 0 and never prints the usage line (rc=$preview_rc)"
fi

# COLUMNS, not a tty query, sets the render width. A fake glow that reports
# the -w it was handed makes the width visible without needing a real render.
mkdir -p "$WORK/fakebin"
cat > "$WORK/fakebin/glow" <<'FAKEGLOW'
#!/usr/bin/env bash
w=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-w" ]; then w="$2"; shift 2; continue; fi
  shift
done
echo "WIDTH:$w"
FAKEGLOW
chmod +x "$WORK/fakebin/glow"

width_for() {
  # tput reads $COLUMNS from the environment before it ever asks terminfo, so
  # on a machine with a real $TERM the old tput-only code already tracked
  # COLUMNS by accident - measured here, `COLUMNS=133 tput cols` prints 133
  # even with no COLUMNS-aware code at all. TERM has to go for this check to
  # tell the fix apart from that accident: with no TERM, tput has nothing to
  # answer with but its hardcoded 80.
  env -u TERM PATH="$WORK/fakebin:$PATH" COLUMNS="$1" "$MD" --preview "$WORK/preview.md" \
    </dev/null 2>/dev/null | grep -oE '^WIDTH:[0-9]+' | cut -d: -f2
}
w40=$(width_for 40)
w120=$(width_for 120)
if [ -n "$w40" ] && [ -n "$w120" ] \
   && [ "$w40" -lt 60 ] && [ "$w120" -gt "$w40" ] && [ "$w120" -gt 100 ]
then
  ok "COLUMNS drives the render width glow is asked for (40->$w40, 120->$w120)"
else
  no "COLUMNS drives the render width glow is asked for (40->'$w40', 120->'$w120')"
fi

# A preview pane cannot page. Stand-ins for less, more and $PAGER each leave a
# sentinel if they run; none of them may.
cat > "$WORK/fakebin/less" <<'FAKELESS'
#!/usr/bin/env bash
touch "$SENTINEL_DIR/less"
FAKELESS
cat > "$WORK/fakebin/more" <<'FAKEMORE'
#!/usr/bin/env bash
touch "$SENTINEL_DIR/more"
FAKEMORE
cat > "$WORK/fakebin/fake-pager" <<'FAKEPAGER'
#!/usr/bin/env bash
touch "$SENTINEL_DIR/pager"
FAKEPAGER
chmod +x "$WORK/fakebin/less" "$WORK/fakebin/more" "$WORK/fakebin/fake-pager"
mkdir -p "$WORK/sentinels"
SENTINEL_DIR="$WORK/sentinels" PATH="$WORK/fakebin:$PATH" PAGER="$WORK/fakebin/fake-pager" \
  "$MD" --preview "$WORK/preview.md" </dev/null >/dev/null 2>&1
if [ -z "$(ls -A "$WORK/sentinels" 2>/dev/null)" ]; then
  ok "--preview never invokes a pager"
else
  no "--preview invoked a pager: $(ls "$WORK/sentinels" | tr '\n' ' ')"
fi

# No temp residue. A fixture with no mermaid fence never exercises the
# diagram code path, so it cannot see a diagram tempfile leak - use one that
# actually has a diagram. mermaid-ascii's working copy is written under the
# system temp directory as tmpXXXXXXXX.mmd, a name that does not start with
# "spechub-md", so watch that pattern too rather than one glob, and respect
# $TMPDIR since that is where the code actually writes, not always /tmp.
cat > "$WORK/residue-diagram.md" <<'MD1B'
# Residue check

```mermaid
graph LR
  A[This is a very long node label for width] --> B[Another quite long label here too]
  B --> C[Yet another sufficiently long label]
```
MD1B
TMP_DIR="${TMPDIR:-/tmp}"
tmp_before=$(find "$TMP_DIR" -maxdepth 1 \( -name 'spechub-md*' -o -name '*.mmd' \) 2>/dev/null | sort)
COLUMNS=40 "$MD" --preview "$WORK/residue-diagram.md" </dev/null >/dev/null 2>&1
tmp_after=$(find "$TMP_DIR" -maxdepth 1 \( -name 'spechub-md*' -o -name '*.mmd' \) 2>/dev/null | sort)
# $TMP_DIR is shared with whatever else is running, so only new entries count
# - an unrelated process tidying up its own stale debris between the two
# snapshots is not this check's business, and must not fail it.
new_files=$(comm -13 <(echo "$tmp_before") <(echo "$tmp_after"))
if [ -z "$new_files" ]; then
  ok "--preview leaves no spechub-md*/.mmd residue in $TMP_DIR"
else
  no "--preview leaves residue in $TMP_DIR: $(echo "$new_files" | tr '\n' ' ')"
fi

# The previewer command lines in setup.sh are the actual contract: whatever
# flag they pass, the helper must accept. Derived from setup.sh rather than
# hardcoded, so this keeps catching the next flag that drifts.
preview_flags=$(grep "run = 'piper" "$SETUP" | grep 'spechub-md' \
  | grep -oE -- '--[a-z][a-z-]*' | sort -u)
if [ -z "$preview_flags" ]; then
  no "found no previewer flags to check - setup.sh's piper line may have changed shape"
else
  agree_broken=""
  for flag in $preview_flags; do
    out=$("$MD" "$flag" "$WORK/preview.md" </dev/null 2>&1)
    rc=$?
    if [ "$rc" -ne 0 ] || printf '%s' "$out" | grep -q 'usage: spechub-md'; then
      agree_broken="$agree_broken $flag"
    fi
  done
  if [ -z "$agree_broken" ]; then
    ok "every flag the yazi previewer passes ($preview_flags) is accepted"
  else
    no "flags the previewer passes but the helper rejects:$agree_broken"
  fi
fi

# The usage line is the fallback documentation: it must list every flag the
# helper actually accepts, and the header comment above it must cover preview.
usage_text=$("$MD" </dev/null 2>&1)
if printf '%s' "$usage_text" | grep -q -- '--preview' \
   && printf '%s' "$usage_text" | grep -q -- '--diagram' \
   && printf '%s' "$usage_text" | grep -q -- '--serve' \
   && printf '%s' "$usage_text" | grep -q -- '--numbered' \
   && printf '%s' "$usage_text" | grep -q -- '--toggle-line-numbers'
then
  ok "usage line lists every flag the helper accepts"
else
  no "usage line is missing a flag it should list: $usage_text"
fi

header_block=$(awk '/^#/{print; next} {exit}' "$MD")
if printf '%s' "$header_block" | grep -q -- '--preview' \
   && printf '%s' "$header_block" | grep -q -- '--numbered'; then
  ok "the header comment documents --preview and --numbered"
else
  no "the header comment does not document --preview and --numbered"
fi

# A diagram too wide for the pane must collapse to a placeholder, not spill
# raw box-drawing art past the pane width. Needs glow, mermaid-ascii and perl
# for real; note and move on when any is missing rather than counting it - a
# missing perl must never read as a pass just because there's nothing to strip.
if command -v glow >/dev/null 2>&1 && command -v mermaid-ascii >/dev/null 2>&1 \
   && command -v perl >/dev/null 2>&1; then
  cat > "$WORK/wide.md" <<'MD2'
# Wide diagram

```mermaid
graph LR
  A[This is a very long node label for width] --> B[Another quite long label here too]
  B --> C[Yet another sufficiently long label]
```
MD2
  pane=40
  wide_out=$(COLUMNS=$pane "$MD" --preview "$WORK/wide.md" </dev/null 2>/dev/null)
  # The pane renders ANSI fine, so colour is not the thing under test - strip
  # it before measuring, or a styled line always reads as "too wide" no matter
  # what it draws. CSI (colour, cursor moves) ends in a letter; OSC (hyperlinks,
  # title-setting) ends in BEL or ESC \. A renderer also pads a line out to the
  # pane width with trailing spaces, so drop those too before counting.
  stripped=$(printf '%s\n' "$wide_out" | perl -pe '
    s/\x1b\][^\x07\x1b]*(\x07|\x1b\\)//g;
    s/\x1b\[[0-9;?]*[A-Za-z]//g;
    s/[ \t]+$//;
  ')
  # Tied to the pane, not to 80: a leaked drawing lands well past the pane
  # (measured: a raw box-drawing splice at COLUMNS=40 comes out ~45 wide),
  # while legitimate wrapped prose and the placeholder line itself top out
  # in the mid-30s. A small margin over the pane catches the leak without
  # flagging real output.
  margin=$((pane + 2))
  too_wide=$(printf '%s\n' "$stripped" | awk -v m="$margin" '{ if (length($0) > m) print }')
  if [ -n "$wide_out" ] && [ -n "$stripped" ] && [ -z "$too_wide" ] \
     && printf '%s' "$wide_out" | grep -qi 'diagram'
  then
    ok "a wide diagram collapses to a placeholder in a ${pane}-column preview"
  else
    no "a wide diagram collapses to a placeholder in a ${pane}-column preview"
  fi
else
  printf '  note: glow, mermaid-ascii or perl not installed - skipping wide-diagram preview check\n'
fi

echo "spechub-md line numbers"
# The preview pane renders markdown, and a rendered heading has no line number
# a reader can quote back in a review. A flag file carries the choice between
# the two views, so the key binding, the helper and these checks all name one
# place. XDG_STATE_HOME moves it, which is what keeps this off the real one.
LNSTATE="$WORK/state"
LNFLAG="$LNSTATE/spechub/md-line-numbers"
cat > "$WORK/numbers.md" <<'MDN'
# Heading

first paragraph

- a list item
MDN

rm -rf "$LNSTATE"
XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
toggle_rc=$?
if [ "$toggle_rc" -eq 0 ] && [ -e "$LNFLAG" ]; then
  ok "--toggle-line-numbers turns line numbers on"
else
  no "--toggle-line-numbers turns line numbers on (rc=$toggle_rc)"
fi

XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
if [ ! -e "$LNFLAG" ]; then
  ok "--toggle-line-numbers turns line numbers off again"
else
  no "--toggle-line-numbers turns line numbers off again"
fi

# The toggle has to work on a machine that has never had a state directory,
# which is every machine the first time. Creating it is the toggle's job.
rm -rf "$LNSTATE"
XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
if [ -e "$LNFLAG" ]; then
  ok "--toggle-line-numbers creates the state directory it needs"
else
  no "--toggle-line-numbers creates the state directory it needs"
fi
rm -rf "$LNSTATE"

# --numbered is the deterministic view: source, numbered, whatever the flag
# says. The opener menu and every check below go through it rather than
# through the flag, so neither depends on which way the toggle was left.
if command -v less >/dev/null 2>&1; then
  num_out=$(COLUMNS=100 "$MD" --numbered "$WORK/numbers.md" </dev/null 2>/dev/null)
  # Source, not a render: glow eats the leading # of a heading, so a literal
  # one on the first numbered line is what tells the two views apart.
  if printf '%s\n' "$num_out" | head -1 | grep -qE '^  1  # Heading$'; then
    ok "--numbered prints the source with its line number"
  else
    no "--numbered prints the source with its line number (got '$(printf '%s\n' "$num_out" | head -1)')"
  fi

  # Every line, not just the first: a gutter that skips blank lines makes
  # every number after the first blank line wrong.
  src_lines=$(awk 'END { print NR }' "$WORK/numbers.md")
  out_lines=$(printf '%s\n' "$num_out" | awk 'END { print NR }')
  numbered_all=$(printf '%s\n' "$num_out" | awk '!/^ *[0-9]+ /  { print }')
  if [ "$src_lines" = "$out_lines" ] && [ -z "$numbered_all" ]; then
    ok "--numbered numbers every source line, blank ones included"
  else
    no "--numbered numbers every source line ($src_lines source, $out_lines out)"
  fi

  # The number a reader quotes has to be the file's own. Line 5 of the fixture
  # is the list item, and nothing about the view may shift that.
  if printf '%s\n' "$num_out" | grep -qE '^  5  - a list item$'; then
    ok "--numbered numbers agree with the source file's own lines"
  else
    no "--numbered numbers agree with the source file's own lines"
  fi
else
  printf '  note: less not installed - skipping the --numbered checks\n'
fi

# The flag is what the key binding flips, so the pane has to follow it.
XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
prev_on=$(XDG_STATE_HOME="$LNSTATE" COLUMNS=100 "$MD" --preview "$WORK/numbers.md" </dev/null 2>/dev/null)
if printf '%s\n' "$prev_on" | head -1 | grep -qE '^  1  # Heading$'; then
  ok "--preview shows numbered source while the flag is set"
else
  no "--preview shows numbered source while the flag is set (got '$(printf '%s\n' "$prev_on" | head -1)')"
fi

XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
prev_off=$(XDG_STATE_HOME="$LNSTATE" COLUMNS=100 "$MD" --preview "$WORK/numbers.md" </dev/null 2>/dev/null)
if [ -n "$prev_off" ] && ! printf '%s\n' "$prev_off" | head -1 | grep -qE '^ *1  '; then
  ok "--preview goes back to the rendered view once the flag is cleared"
else
  no "--preview goes back to the rendered view once the flag is cleared"
fi

# A pane cannot page, and the numbered view is still a pane. The stand-ins
# from the --preview section are still on PATH under $WORK/fakebin.
rm -f "$WORK/sentinels"/*
XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
SENTINEL_DIR="$WORK/sentinels" PATH="$WORK/fakebin:$PATH" PAGER="$WORK/fakebin/fake-pager" \
  XDG_STATE_HOME="$LNSTATE" "$MD" --preview "$WORK/numbers.md" </dev/null >/dev/null 2>&1
if [ -z "$(ls -A "$WORK/sentinels" 2>/dev/null)" ]; then
  ok "the numbered preview never invokes a pager"
else
  no "the numbered preview invoked a pager: $(ls "$WORK/sentinels" | tr '\n' ' ')"
fi

# The gutter is right-aligned, and a file long enough to need three digits is
# what makes that visible: line 1 has to be pushed across to sit under line
# 100, or the source starts in a different column on either side of it.
seq 1 120 | sed 's/^/line /' > "$WORK/long-source.md"
long_out=$(COLUMNS=100 "$MD" --numbered "$WORK/long-source.md" </dev/null 2>/dev/null)
if printf '%s\n' "$long_out" | grep -qE '^  1  line 1$' \
   && printf '%s\n' "$long_out" | grep -qE '^100  line 100$'; then
  ok "the gutter is right-aligned to the widest line number"
else
  no "the gutter is not right-aligned (line 1: '$(printf '%s\n' "$long_out" | head -1)')"
fi

# --diagram asks for one drawing, which is a different question from which of
# the two views the pane is showing. The flag must not answer it: a reader who
# left line numbers on and then asked for a diagram still wants the diagram.
cat > "$WORK/numbers-diagram.md" <<'MDD'
# Diagram fixture

```mermaid
graph LR
  A[One] --> B[Two]
```
MDD
rm -rf "$LNSTATE"
diag_off=$(COLUMNS=100 "$MD" --preview --diagram 1 "$WORK/numbers-diagram.md" </dev/null 2>/dev/null)
XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
diag_on=$(XDG_STATE_HOME="$LNSTATE" COLUMNS=100 "$MD" --preview --diagram 1 "$WORK/numbers-diagram.md" </dev/null 2>/dev/null)
# The same fixture with no diagram asked for still follows the flag, so a pass
# here cannot be the flag quietly doing nothing at all.
plain_on=$(XDG_STATE_HOME="$LNSTATE" COLUMNS=100 "$MD" --preview "$WORK/numbers-diagram.md" </dev/null 2>/dev/null)
if [ -n "$diag_off" ] && [ "$diag_on" = "$diag_off" ] \
   && printf '%s\n' "$plain_on" | grep -qE '^  1  # Diagram fixture$'; then
  ok "--diagram outranks the line-numbers flag"
else
  no "--diagram is overridden by the line-numbers flag"
fi
rm -rf "$LNSTATE"

# A wrapped line makes the gutter lie about which line you are on, so the pane
# chops instead. The fixture line is far wider than the pane asked for.
{ printf 'short\n'; printf 'x%.0s' $(seq 1 300); printf '\n'; } > "$WORK/wide-source.md"
XDG_STATE_HOME="$LNSTATE" "$MD" --toggle-line-numbers >/dev/null 2>&1
narrow=$(XDG_STATE_HOME="$LNSTATE" COLUMNS=40 "$MD" --preview "$WORK/wide-source.md" </dev/null 2>/dev/null)
overflow=$(printf '%s\n' "$narrow" | awk 'length($0) > 40 { print }')
if [ -n "$narrow" ] && [ -z "$overflow" ]; then
  ok "the numbered preview chops to COLUMNS so the gutter stays honest"
else
  no "the numbered preview spills past COLUMNS: $(printf '%s\n' "$overflow" | head -1 | cut -c1-60)"
fi
rm -rf "$LNSTATE"

echo "spechub-md --html"
# Every browser route needs the same primitive: the whole document on stdout,
# built without a server. --serve already renders exactly this document, so
# these pin it as something a caller can capture and hand on rather than curl
# for - which is the only shape that works when the browser is on a different
# machine and no forward port reaches this one.
cat > "$WORK/html.md" <<'MDH'
# Browser me

Prose before the diagram.

```mermaid
graph LR
  A[start] --> B[end]
```
MDH

html_out="$WORK/html.out"
html_err="$WORK/html.err"
"$MD" --html "$WORK/html.md" </dev/null >"$html_out" 2>"$html_err"
html_rc=$?

if [ "$html_rc" -eq 0 ] \
   && head -1 "$html_out" | grep -qi '<!doctype html' \
   && grep -qi '</html>' "$html_out" \
   && ! grep -q 'usage: spechub-md' "$html_out" "$html_err"
then
  okr "--html writes a whole document to stdout and exits 0"
else
  nor "--html writes a whole document to stdout and exits 0 (rc=$html_rc)"
  # Captured and then thrown away is how this cost an afternoon: the helper
  # said exactly what it wanted and no one could see it.
  [ -s "$html_err" ] && printf '        stderr: %s\n' "$(head -3 "$html_err")"
fi

# Rendered, not passed through. Markdown source reaching the browser raw is
# the failure this catches.
if grep -q '<h1' "$html_out" && grep -q 'Prose before the diagram' "$html_out"; then
  okr "--html renders the markdown body"
else
  nor "--html renders the markdown body"
fi

# mermaid.js reads <pre class="mermaid"> holding raw diagram source. An
# escaped code block leaves --&gt; in place of the arrow and draws nothing,
# which looks like a mermaid bug rather than a rendering one.
if grep -q '<pre class="mermaid">' "$html_out" \
   && grep -q 'A\[start\] --> B\[end\]' "$html_out" \
   && ! grep -q 'language-mermaid' "$html_out"
then
  okr "--html hands mermaid fences over unescaped"
else
  nor "--html hands mermaid fences over unescaped"
fi

# The one thing --html cannot inherit from --serve. --serve answers for
# /mermaid.js itself off the vendored copy; a document standing on its own has
# no server behind it, so a relative src fetches from whatever host the page
# ended up on and finds nothing there.
if grep -q '<script src="https://' "$html_out" \
   && ! grep -q 'src="/mermaid.js"' "$html_out"
then
  okr "--html names a mermaid source reachable with no server behind the page"
else
  nor "--html names a mermaid source reachable with no server behind the page"
fi

# A document is not a server. Hold the serve port and the document must still
# come out: a caller pushing one into a browser over CDP should never have to
# find a free port first, and must never be left waiting on one.
cat > "$WORK/holdport.py" <<'HOLD'
import socket, sys, time
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(1)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
time.sleep(30)
HOLD
rm -f "$WORK/held.port"
python3 "$WORK/holdport.py" "$WORK/held.port" >/dev/null 2>&1 &
HOLD_PID=$!
i=0
while [ ! -s "$WORK/held.port" ] && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.1; done
held=$(cat "$WORK/held.port" 2>/dev/null)
if [ -n "$held" ] \
   && SPECHUB_MD_PORT="$held" timeout 20 "$MD" --html "$WORK/html.md" \
        </dev/null 2>/dev/null | grep -qi '</html>'
then
  okr "--html renders with the serve port already taken, and returns"
else
  nor "--html renders with the serve port already taken, and returns"
fi
kill "$HOLD_PID" 2>/dev/null; wait "$HOLD_PID" 2>/dev/null
rm -f "$WORK/held.port"

# --preview, --serve and --html are three answers to "where does this end up",
# and a caller that gives two of them meant something the helper cannot do.
# Saying so beats silently picking one.
excl_broken=""
for other in --serve --preview; do
  timeout 10 "$MD" --html "$other" "$WORK/html.md" </dev/null >/dev/null 2>&1 \
    && excl_broken="$excl_broken $other"
done
if [ -z "$excl_broken" ]; then
  ok "--html refuses to combine with --serve or --preview"
else
  no "--html silently combines with:$excl_broken"
fi

echo "spechub-md --browser"
# Where the browser is decides how the page reaches it, and spechub-open
# already answers that for URLs. These pin that --browser asks it rather than
# working the question out a second time, and that each answer gets the
# delivery it needs: a document handed over the CDP link when the browser is
# on the far end of the bridge, a served page when it can reach this machine.
BRBIN="$WORK/browser-bin"
mkdir -p "$BRBIN"
cat > "$BRBIN/spechub-open" <<'SO'
#!/bin/sh
if [ "$1" = "--why" ]; then echo "$SPECHUB_TEST_ROUTE"; exit 0; fi
echo "spechub-open $*" >> "$SPECHUB_TEST_LOG"
SO
# Records what it was asked to do, and keeps whatever came down stdin so the
# payload can be decoded and inspected rather than taken on trust. It answers
# the way a browser does - with the title of the page it is now holding - so
# the helper's own check has something real to read. $SPECHUB_TEST_LIE makes it
# hold something else instead, which is a bridge that took the page and did not
# keep it.
cat > "$BRBIN/agent-browser" <<'AB'
#!/bin/sh
echo "agent-browser $*" >> "$SPECHUB_TEST_LOG"
# The real listing marks the active tab with an arrow and indents the rest.
# Which line carries the arrow is the whole point: switching to the wrong index
# raises somebody else's tab.
case "$*" in
  *"tab list"*)
    printf '  [0] Google - https://www.google.com/\n'
    printf '\342\206\222 [1]  - about:blank\n'
    exit 0 ;;
esac
for a in "$@"; do
  if [ "$a" = "--stdin" ]; then
    cat > "$SPECHUB_TEST_PUSH"
    if [ -n "${SPECHUB_TEST_LIE:-}" ]; then printf '"%s"\n' "$SPECHUB_TEST_LIE"; exit 0; fi
    python3 - "$SPECHUB_TEST_PUSH" <<'EOF'
import base64, pathlib, re, sys
js = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r'"([A-Za-z0-9+/=]{200,})"', js)
doc = base64.b64decode(m.group(1)).decode() if m else ""
t = re.search(r"<title>(.*?)</title>", doc)
print('"%s"' % (t.group(1) if t else ""))
EOF
    exit 0
  fi
done
exit 0
AB
chmod +x "$BRBIN/spechub-open" "$BRBIN/agent-browser"

br_log="$WORK/browser.log"
br_push="$WORK/browser.push"
rm -f "$br_log" "$br_push"
PATH="$BRBIN:$PATH" SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$br_log" \
  SPECHUB_TEST_PUSH="$br_push" timeout 30 "$MD" --browser "$WORK/html.md" \
  </dev/null >/dev/null 2>&1
br_rc=$?

if [ "$br_rc" -eq 0 ] && grep -q 'agent-browser.*eval' "$br_log" 2>/dev/null; then
  okr "--browser hands the page to agent-browser on the bridge route"
else
  nor "--browser hands the page to agent-browser on the bridge route (rc=$br_rc)"
fi

# The payload has to be the rendered document, not the markdown and not a
# path: the far end cannot read this machine's disk, which is the whole point.
if [ -s "$br_push" ] && python3 - "$br_push" <<'DECODE'
import base64, pathlib, re, sys
js = pathlib.Path(sys.argv[1]).read_text()
m = re.search(r'"([A-Za-z0-9+/=]{200,})"', js)
if not m:
    sys.exit("no base64 payload found")
doc = base64.b64decode(m.group(1)).decode()
for want in ("<!doctype html", "<pre class=\"mermaid\">", "</html>"):
    if want not in doc.lower() and want not in doc:
        sys.exit(f"payload missing {want!r}")
DECODE
then
  okr "--browser pushes the whole rendered document, diagrams included"
else
  nor "--browser pushes the whole rendered document, diagrams included"
fi

# A document delivered over CDP needs no port here, and must not leave a
# server running behind it - the caller got its page and is done.
if ! grep -q 'spechub-md-serve' /proc/*/cmdline 2>/dev/null \
   || ! pgrep -f "spechub-md-serve.*$WORK/html.md" >/dev/null 2>&1
then
  ok "--browser on the bridge route leaves no server behind"
else
  no "--browser on the bridge route leaves no server behind"
  pkill -f "spechub-md-serve.*$WORK/html.md" 2>/dev/null
fi

# Every other route has a browser that can reach this machine, so the page is
# served rather than pushed, and agent-browser must stay out of it entirely.
rm -f "$br_log" "$br_push"
br_port=6717
PATH="$BRBIN:$PATH" SPECHUB_TEST_ROUTE=link SPECHUB_TEST_LOG="$br_log" \
  SPECHUB_TEST_PUSH="$br_push" SPECHUB_MD_PORT="$br_port" \
  "$MD" --browser "$WORK/html.md" </dev/null >/dev/null 2>&1 &
BR_PID=$!
br_body=""
for i in $(seq 40); do
  br_body=$(curl -fsS -m 1 "http://127.0.0.1:$br_port/" 2>/dev/null) && break
  sleep 0.25
done
kill "$BR_PID" 2>/dev/null; wait "$BR_PID" 2>/dev/null
pkill -f "spechub-md-serve.*$WORK/html.md" 2>/dev/null

if printf '%s' "$br_body" | grep -qi '</html>' \
   && ! grep -q 'agent-browser' "$br_log" 2>/dev/null
then
  okr "--browser serves the page when the browser can reach this machine"
else
  nor "--browser serves the page when the browser can reach this machine"
fi

# The page goes into a tab of its own, and never over a page that is already
# there. The Playwriter extension attaches per tab through chrome.debugger, and
# rewriting a real document detaches it: measured on a live bridge, pushing
# over an https page left /json/list empty and the bridge unusable until it was
# armed again by hand. A fresh about:blank tab survives the same rewrite,
# because the document it replaces has the same origin.
rm -f "$br_log" "$br_push"
PATH="$BRBIN:$PATH" SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$br_log" \
  SPECHUB_TEST_PUSH="$br_push" timeout 30 "$MD" --browser "$WORK/html.md" \
  </dev/null >/dev/null 2>&1
if grep -q 'tab new' "$br_log" 2>/dev/null; then
  okr "--browser writes into a tab of its own, leaving the armed tab armed"
else
  nor "--browser rewrites a live page, which detaches the extension" \
      "--browser writes into a tab of its own, leaving the armed tab armed"
fi

# A tab created over CDP is created in the background, so writing into it is
# only half the job - it still has to be brought forward, or the page is real,
# correct, and never seen. agent-browser carries Page.bringToFront on its tab
# switch, so the tab just written into is switched to explicitly.
if grep -qE 'agent-browser .*tab 1$' "$br_log" 2>/dev/null; then
  okr "--browser brings the tab it wrote into to the front"
elif grep -qE 'agent-browser .*tab [0-9]+$' "$br_log" 2>/dev/null; then
  nor "--browser raises the wrong tab: $(grep -oE 'tab [0-9]+$' "$br_log" | tail -1)"
else
  nor "--browser leaves the tab in the background, where nobody sees it" \
      "--browser brings the tab it wrote into to the front"
fi

# "It said it opened but it did not" has to be impossible to say twice. An exit
# status only means the command ran; the page is confirmed by asking the far
# end what it is now holding.
rm -f "$br_log" "$br_push"
PATH="$BRBIN:$PATH" SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$br_log" \
  SPECHUB_TEST_PUSH="$br_push" SPECHUB_TEST_LIE="something else entirely" \
  timeout 30 "$MD" --browser "$WORK/html.md" </dev/null >/dev/null 2>&1
if [ "$?" -ne 0 ]; then
  ok "--browser fails when the far end is not holding the page"
else
  no "--browser reports success without checking the page arrived"
fi

# A preview pane is still not a browser.
if ! timeout 10 "$MD" --browser --preview "$WORK/html.md" </dev/null >/dev/null 2>&1; then
  ok "--browser refuses to combine with --preview"
else
  no "--browser refuses to combine with --preview"
fi

echo "spechub-md browser key in the pager"
# Reading a document and wanting it in a browser is the same moment, so the
# key belongs where the reading happens. less cannot run a command and hand it
# the filename cleanly, but lesskey's quit action takes the first character of
# its extra string as an exit status - so the key quits with a value less
# never produces on its own, and spechub-md acts on that.
KEYBIN="$WORK/key-bin"
mkdir -p "$KEYBIN"
# Records the keys file it was handed, and exits with whatever the test wants
# less to have returned.
cat > "$KEYBIN/less" <<'FAKELESS2'
#!/bin/sh
printf '%s' "${LESSKEYIN:-}" > "$SPECHUB_TEST_LESSKEYIN"
[ -n "${LESSKEYIN:-}" ] && [ -f "$LESSKEYIN" ] && cp "$LESSKEYIN" "$SPECHUB_TEST_KEYS"
exit "${SPECHUB_TEST_LESS_RC:-0}"
FAKELESS2
chmod +x "$KEYBIN/less"

key_seen="$WORK/key.lesskeyin"
key_file="$WORK/key.keys"
key_log="$WORK/key.log"

run_pager() {  # run_pager <less-exit-status>
  rm -f "$key_seen" "$key_file" "$key_log"
  PATH="$KEYBIN:$BRBIN:$PATH" \
    SPECHUB_TEST_LESS_RC="$1" \
    SPECHUB_TEST_LESSKEYIN="$key_seen" SPECHUB_TEST_KEYS="$key_file" \
    SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$key_log" \
    SPECHUB_TEST_PUSH="$WORK/key.push" \
    timeout 40 "$MD" "$WORK/html.md" </dev/null >/dev/null 2>&1
}

run_pager 0
if [ -s "$key_seen" ]; then
  ok "the pager is handed a lesskey file"
else
  no "the pager is handed a lesskey file"
fi

# The binding has to be quit-with-a-status, not a shell escape: less expands %
# to the file it was given, which here is the rendered temp copy rather than
# the markdown the reader asked for.
if grep -q '^#command' "$key_file" 2>/dev/null \
   && grep -qE '^b[[:space:]]+quit[[:space:]]+.' "$key_file" 2>/dev/null
then
  ok "the lesskey file binds b to quit with an exit status"
else
  no "the lesskey file binds b to quit with an exit status"
fi

# Quitting normally must not open anything. This is the check that would catch
# the browser firing every time somebody just finished reading.
if ! grep -q 'agent-browser' "$key_log" 2>/dev/null; then
  ok "quitting the pager normally opens no browser"
else
  no "quitting the pager normally opens no browser"
fi

# 65 is "A", the first character of the extra string in the binding above.
run_pager 65
if grep -q 'agent-browser' "$key_log" 2>/dev/null; then
  okr "the pager's browser status opens the browser"
else
  nor "the pager's browser status opens the browser"
fi

# Somebody else's pager gets none of this: the binding is a less feature, and
# handing LESSKEYIN to a program that does not read it is at best noise.
cat > "$KEYBIN/otherpager" <<'OTHERP'
#!/bin/sh
printf '%s' "${LESSKEYIN:-}" > "$SPECHUB_TEST_LESSKEYIN"
exit 65
OTHERP
chmod +x "$KEYBIN/otherpager"
rm -f "$key_seen" "$key_log"
PATH="$KEYBIN:$BRBIN:$PATH" PAGER="otherpager" \
  SPECHUB_TEST_LESSKEYIN="$key_seen" SPECHUB_TEST_KEYS="$key_file" \
  SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$key_log" \
  SPECHUB_TEST_PUSH="$WORK/key.push" \
  timeout 40 "$MD" "$WORK/html.md" </dev/null >/dev/null 2>&1
if [ ! -s "$key_seen" ] && ! grep -q 'agent-browser' "$key_log" 2>/dev/null; then
  ok "a pager that is not less gets no lesskey file and no browser status"
else
  no "a pager that is not less gets no lesskey file and no browser status"
fi

# The key is a preference, not a constant - b is taken in less for back-a-page,
# and somebody who wants that back needs a way to move this.
rm -f "$key_file"
PATH="$KEYBIN:$BRBIN:$PATH" SPECHUB_MD_BROWSER_KEY=w \
  SPECHUB_TEST_LESS_RC=0 \
  SPECHUB_TEST_LESSKEYIN="$key_seen" SPECHUB_TEST_KEYS="$key_file" \
  SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$key_log" \
  SPECHUB_TEST_PUSH="$WORK/key.push" \
  timeout 40 "$MD" "$WORK/html.md" </dev/null >/dev/null 2>&1
if grep -qE '^w[[:space:]]+quit' "$key_file" 2>/dev/null; then
  ok "\$SPECHUB_MD_BROWSER_KEY moves the key"
else
  no "\$SPECHUB_MD_BROWSER_KEY moves the key"
fi

# The one that proves the mechanism rather than our half of it: a real less,
# a real keypress, and the exit status the binding is supposed to produce.
# Needs a terminal, which is what script(1) is for.
if command -v script >/dev/null 2>&1 && command -v less >/dev/null 2>&1; then
  lk_real="$WORK/real.lesskey"
  printf '#command\nb quit A\n' > "$lk_real"
  printf 'one\ntwo\nthree\n' > "$WORK/real.txt"
  rm -f "$WORK/real.fifo" "$WORK/real.out"; mkfifo "$WORK/real.fifo"
  ( LESSKEYIN="$lk_real" timeout 20 \
      script -qec "stty rows 20 cols 60; less -R $WORK/real.txt; echo RC=\$?" \
        /dev/null < "$WORK/real.fifo" > "$WORK/real.out" 2>&1 & )
  exec 7>"$WORK/real.fifo"
  sleep 3; printf 'b' >&7; sleep 3
  exec 7>&-
  real_rc=$(tr -d '\000' < "$WORK/real.out" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
              | grep -oE 'RC=[0-9]+' | tail -1)
  if [ "$real_rc" = "RC=65" ]; then
    ok "a real less quits with 65 when the bound key is pressed"
  else
    no "a real less quits with 65 when the bound key is pressed (got '$real_rc')"
  fi
else
  printf '  note: script or less not installed - skipping the real-less check\n'
fi

echo "spechub-md line-numbers key in the pager"
# The reader is where somebody actually wants a line number: they pressed
# Enter to read the document, and the file list with its own # binding is no
# longer in front of them. So the key means the same thing in both places.
#
# lesskey reads a leading # as a comment, so this binding has to be escaped.
# Unescaped it is silently dropped and the key does nothing but ring the
# terminal bell - which is exactly how this arrived as a bug report.
if command -v script >/dev/null 2>&1 && command -v less >/dev/null 2>&1; then
  press_less() {  # press_less <lesskey-body> <key> -> prints RC=<n>
    printf '#command\n%s\n' "$1" > "$WORK/hash.lesskey"
    printf 'one\ntwo\nthree\n' > "$WORK/hash.txt"
    rm -f "$WORK/hash.fifo" "$WORK/hash.out"; mkfifo "$WORK/hash.fifo"
    ( LESSKEYIN="$WORK/hash.lesskey" timeout 20 \
        script -qec "stty rows 20 cols 60; less -R $WORK/hash.txt; echo RC=\$?" \
          /dev/null < "$WORK/hash.fifo" > "$WORK/hash.out" 2>&1 & )
    exec 8>"$WORK/hash.fifo"
    # q after it, always: a binding that does not fire leaves less sitting
    # there, and a test that reads no exit status at all cannot tell that
    # apart from one that never started.
    sleep 3; printf '%s' "$2" >&8; sleep 3
    # In a subshell: when the binding did fire, less is already gone and the
    # fifo has no reader, and a SIGPIPE here would kill the command
    # substitution this runs inside before it ever reads the exit status.
    ( printf 'q' >&8 ) 2>/dev/null || true
    sleep 2
    exec 8>&-
    tr -d '\000' < "$WORK/hash.out" | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
      | grep -oE 'RC=[0-9]+' | tail -1
  }

  esc_rc=$(press_less '\# quit B' '#')
  if [ "$esc_rc" = "RC=66" ]; then
    ok "a real less quits with 66 when the escaped # binding is pressed"
  else
    no "a real less quits with 66 when the escaped # binding is pressed (got '$esc_rc')"
  fi

  # The other half, and the one that makes the escape load-bearing rather than
  # decorative: written bare, the binding is a comment and the key does nothing.
  # RC=0 is the q above doing the quitting: the # went nowhere, which on a
  # real terminal is the bell and nothing else.
  bare_rc=$(press_less '# quit B' '#')
  if [ "$bare_rc" = "RC=0" ]; then
    ok "a bare # binding is read as a comment and never fires"
  else
    no "a bare # binding fired, so nothing here is testing the escape (got '$bare_rc')"
  fi
else
  printf '  note: script or less not installed - skipping the real-less # checks\n'
fi

# A pager stand-in that answers once with the status under test and then gets
# out of the way. Without the counter the round trip never ends: every re-exec
# pages again, and a stand-in that always returns 66 flips views forever.
RTBIN="$WORK/rt-bin"
mkdir -p "$RTBIN"
cat > "$RTBIN/less" <<'RTLESS'
#!/bin/sh
n=$(cat "$SPECHUB_TEST_COUNT" 2>/dev/null || echo 0)
n=$((n + 1)); printf '%s' "$n" > "$SPECHUB_TEST_COUNT"
for a in "$@"; do
  case "$a" in -*) ;; *) [ -f "$a" ] && cp "$a" "$SPECHUB_TEST_DIR/page.$n" ;; esac
done
[ -n "${LESSKEYIN:-}" ] && [ -f "$LESSKEYIN" ] && cp "$LESSKEYIN" "$SPECHUB_TEST_DIR/keys.$n"
[ "$n" = "1" ] && exit "${SPECHUB_TEST_LESS_RC:-0}"
exit 0
RTLESS
chmod +x "$RTBIN/less"

RTDIR="$WORK/rt"
rt_run() {  # rt_run <less-exit-status> [extra spechub-md flag]
  rm -rf "$RTDIR"; mkdir -p "$RTDIR"
  printf '0' > "$RTDIR/count"
  PATH="$RTBIN:$BRBIN:$PATH" \
    SPECHUB_TEST_LESS_RC="$1" SPECHUB_TEST_COUNT="$RTDIR/count" \
    SPECHUB_TEST_DIR="$RTDIR" \
    SPECHUB_TEST_ROUTE=bridge SPECHUB_TEST_LOG="$RTDIR/log" \
    SPECHUB_TEST_PUSH="$RTDIR/push" \
    timeout 60 "$MD" ${2:+"$2"} "$WORK/numbers.md" </dev/null >/dev/null 2>&1
}

# What the helper actually writes, as opposed to what a hand-written fixture
# proves above.
rt_run 0
if [ -f "$RTDIR/keys.1" ] \
   && grep -qE '^\\# +quit +B' "$RTDIR/keys.1" \
   && [ "$(grep -c '^#' "$RTDIR/keys.1")" = "1" ]; then
  ok "the lesskey file binds # escaped, and its only bare # line is #command"
else
  no "the lesskey file does not bind # escaped: $(cat "$RTDIR/keys.1" 2>/dev/null | tr '\n' '|')"
fi

# 66 is "B", the first character of the extra string in that binding.
rt_run 66
if [ -f "$RTDIR/page.2" ] && head -1 "$RTDIR/page.2" | grep -qE '^  1  # Heading$'; then
  ok "the reader's # status reopens the same file as numbered source"
else
  no "the reader's # status does not reopen it numbered (got '$(head -1 "$RTDIR/page.2" 2>/dev/null)')"
fi

# And back, so one key is the whole switch rather than a one-way door.
rt_run 66 --numbered
if [ -f "$RTDIR/page.1" ] && head -1 "$RTDIR/page.1" | grep -qE '^  1  # Heading$' \
   && [ -f "$RTDIR/page.2" ] && ! head -1 "$RTDIR/page.2" | grep -qE '^ *[0-9]+  '; then
  ok "pressing it again in the numbered view returns to the rendered one"
else
  no "the numbered view does not return to the rendered one (got '$(head -1 "$RTDIR/page.2" 2>/dev/null)')"
fi

# The browser key is not collateral: both bindings live in the same lesskey
# file, and the numbered view is still a document somebody may want to open.
rt_run 65 --numbered
if grep -q 'agent-browser' "$RTDIR/log" 2>/dev/null; then
  okr "b still reaches the browser from the numbered view"
else
  nor "b no longer reaches the browser from the numbered view" \
      "b still reaches the browser from the numbered view"
fi

echo "yazi keymap merge safety"
# The same key, in the other place ;v can land you. The keymap lives in its own
# file, so this writer has its own collision to worry about: prepend_keymap can
# be written either as an array-of-tables or as an inline array under [mgr],
# and a file containing both forms is invalid TOML - which yazi answers by
# throwing the whole keymap away and falling back to presets.
KEYMAP="$WORK/keymap.py"
awk "/^    py \"\\\$HOME\/\.config\/yazi\/keymap\.toml\" <<'PY'\$/{f=1; next} f && /^PY\$/{exit} f" \
  "$SETUP" > "$KEYMAP"
run_keymap() {  # run_keymap <browser-key> <line-numbers-key> <path> [download-target]
  SPECHUB_ARGS="$1|$2|D|${4-}|e|$BEGIN_MARK|$END_MARK" python3 "$KEYMAP" "$3" 2>/dev/null
}

if [ -s "$KEYMAP" ]; then
  ok "the yazi keymap writer is extractable from setup.sh"
else
  no "the yazi keymap writer is extractable from setup.sh"
fi

# No file at all is the ordinary case - the user has never written one.
rm -f "$WORK/km-fresh.toml"
run_keymap b "#" "$WORK/km-fresh.toml"
if parses "$WORK/km-fresh.toml" && python3 - "$WORK/km-fresh.toml" <<'PYKM'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
binds = data.get("mgr", {}).get("prepend_keymap", [])
hit = [b for b in binds if b.get("on") == "b"]
if not hit:
    sys.exit("no b binding")
run = hit[0].get("run", "")
if "spechub-md --browser" not in run:
    sys.exit(f"binding does not reach the browser: {run!r}")
# %h is the hovered file. $0 names the shell and $@ is empty, both measured -
# a binding using them opens the browser on nothing at all.
if "%h" not in run:
    sys.exit(f"binding does not pass the hovered file: {run!r}")
PYKM
then
  ok "a fresh keymap.toml binds b to the browser on the hovered file"
else
  no "a fresh keymap.toml binds b to the browser on the hovered file"
fi

# The line-numbers key is two actions, not one: flipping the flag changes
# nothing a reader can see until the pane is drawn again.
if python3 - "$WORK/km-fresh.toml" <<'PYLN'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
binds = data.get("mgr", {}).get("prepend_keymap", [])
hit = [b for b in binds if b.get("on") == "#"]
if not hit:
    sys.exit("no # binding")
run = hit[0].get("run")
if not isinstance(run, list):
    sys.exit(f"binding is one action, so the pane never redraws: {run!r}")
if not any("--toggle-line-numbers" in step for step in run):
    sys.exit(f"binding does not flip the flag: {run!r}")
if not any(step.startswith("peek") for step in run):
    sys.exit(f"binding does not redraw the pane: {run!r}")
if run.index(next(s for s in run if "--toggle-line-numbers" in s)) > \
   run.index(next(s for s in run if s.startswith("peek"))):
    sys.exit(f"the pane is redrawn before the flag is flipped: {run!r}")
# A detached shell races the redraw: whichever wins decides what the reader
# sees, so the flip has to finish first.
if "--block" not in next(s for s in run if "--toggle-line-numbers" in s):
    sys.exit(f"the flip is detached and races the redraw: {run!r}")
PYLN
then
  ok "a fresh keymap.toml binds # to flip line numbers and redraw the pane"
else
  no "a fresh keymap.toml binds # to flip line numbers and redraw the pane"
fi

cp "$WORK/km-fresh.toml" "$WORK/km-twice.toml"
run_keymap b "#" "$WORK/km-twice.toml"
if diff -q "$WORK/km-fresh.toml" "$WORK/km-twice.toml" >/dev/null; then
  ok "re-applying the yazi keymap is idempotent"
else
  no "re-applying the yazi keymap is idempotent"
fi

# A keymap the user wrote by hand, in the array-of-tables form, with no
# prepend_keymap of their own.
cat > "$WORK/km-hand.toml" <<'KMHAND'
[[mgr.append_keymap]]
on = "T"
run = "plugin toggle-pane"
desc = "Toggle the preview pane"

[input]
keymap = []
KMHAND
run_keymap b "#" "$WORK/km-hand.toml"
if parses "$WORK/km-hand.toml" \
   && grep -q 'toggle-pane' "$WORK/km-hand.toml" \
   && grep -q 'spechub-md --browser' "$WORK/km-hand.toml"
then
  ok "a hand-written keymap survives the merge and still gains the binding"
else
  no "a hand-written keymap survives the merge and still gains the binding"
fi

# The collision that matters: prepend_keymap already written as an inline
# array. Adding [[mgr.prepend_keymap]] alongside it redefines the same key and
# the file stops parsing, so the binding has to be given up instead.
cat > "$WORK/km-claimed.toml" <<'KMCLAIM'
[mgr]
prepend_keymap = [
  { on = "<C-y>", run = "plugin something", desc = "Mine" },
]
KMCLAIM
run_keymap b "#" "$WORK/km-claimed.toml"
if parses "$WORK/km-claimed.toml" && grep -q 'C-y' "$WORK/km-claimed.toml"; then
  ok "a keymap already claiming prepend_keymap stays valid TOML"
else
  no "a keymap already claiming prepend_keymap stays valid TOML"
fi

first_km=$(grep -c "$BEGIN_MARK" "$WORK/km-hand.toml")
if [ "$first_km" = "1" ]; then
  ok "managed yazi keymap blocks do not accumulate"
else
  no "managed yazi keymap blocks do not accumulate ($first_km)"
fi

# The download key is the one binding written from a config value rather than
# always. No target means no key, because a machine with no Tailscale would
# otherwise carry a binding that can only fail.
rm -f "$WORK/km-nodl.toml"
run_keymap b "#" "$WORK/km-nodl.toml"
if parses "$WORK/km-nodl.toml" && ! grep -q 'tailscale file cp' "$WORK/km-nodl.toml"; then
  ok "no download_target writes no download key"
else
  no "no download_target writes no download key"
fi

rm -f "$WORK/km-dl.toml"
run_keymap b "#" "$WORK/km-dl.toml" my-laptop
if parses "$WORK/km-dl.toml" && python3 - "$WORK/km-dl.toml" <<'PYDL'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
binds = data.get("mgr", {}).get("prepend_keymap", [])
hit = [b for b in binds if b.get("on") == "D"]
if not hit:
    sys.exit("no download binding")
run = hit[0].get("run", "")
if "tailscale file cp" not in run:
    sys.exit(f"binding does not send over Taildrop: {run!r}")
if "my-laptop:" not in run:
    sys.exit(f"binding does not name the target: {run!r}")
# %* is an [opener] placeholder. A keybinding passes the two characters
# through, and tailscale answers `open %*: no such file or directory`.
# Measured on yazi 26.8.15.
if "%*" in run:
    sys.exit(f"binding uses a placeholder yazi never expands: {run!r}")
if "%h" not in run:
    sys.exit(f"binding does not pass the hovered file: {run!r}")
# A send reports progress, and a refused one reports why. Detached, both go
# nowhere and the user sees only yazi's exit code.
if "--block" not in run:
    sys.exit(f"the send is detached, so its error goes nowhere: {run!r}")
PYDL
then
  ok "download_target binds the key to Taildrop on the hovered file"
else
  no "download_target binds the key to Taildrop on the hovered file"
fi

# A binding the user wrote by hand on a key this writer claims. yazi accepts
# both, lists both in its help, and runs one of them - so the user gets two
# entries saying different things and no way to tell which one fires.
cat > "$WORK/km-hand.toml" <<'T'
[[mgr.prepend_keymap]]
on = "e"
run = 'shell --block -- my-own-editor "%h"'
desc = "Mine, on a key this script claims"

[[mgr.prepend_keymap]]
on = "D"
run = 'shell --block -- tailscale file cp "%h" old-laptop:'
desc = "Mine, on a key this script claims only with a target"

[[mgr.prepend_keymap]]
on = "<C-y>"
run = 'shell --block -- my-own-tool "%h"'
desc = "Mine, on a key this script never claims"

[input]
cursor_blink = true
T
cp "$WORK/km-hand.toml" "$WORK/km-hand-out.toml"
run_keymap b "#" "$WORK/km-hand-out.toml" my-laptop
if parses "$WORK/km-hand-out.toml" && python3 - "$WORK/km-hand-out.toml" <<'PYH'
import sys, tomllib
data = tomllib.load(open(sys.argv[1], "rb"))
binds = data.get("mgr", {}).get("prepend_keymap", [])
for key in ("e", "D", "b", "#"):
    hit = [b for b in binds if b.get("on") == key]
    if len(hit) != 1:
        sys.exit(f"{len(hit)} bindings on {key}, expected exactly 1")
if "my-own-editor" in open(sys.argv[1]).read():
    sys.exit("the hand-written binding on a claimed key survived")
if "old-laptop" in open(sys.argv[1]).read():
    sys.exit("the hand-written download binding survived")
if not [b for b in binds if b.get("on") == "<C-y>"]:
    sys.exit("a hand-written binding on an unclaimed key was dropped")
# The table after the last binding belongs to the file, not to the binding.
if not data.get("input", {}).get("cursor_blink"):
    sys.exit("a table following a dropped binding went with it")
PYH
then
  ok "a hand-written binding on a claimed key is replaced, not stacked"
else
  no "a hand-written binding on a claimed key is replaced, not stacked"
fi

# The download key is only claimed when a target is configured, so with none
# the user's own binding on that key has to survive untouched.
cp "$WORK/km-hand.toml" "$WORK/km-hand-nodl.toml"
run_keymap b "#" "$WORK/km-hand-nodl.toml"
if parses "$WORK/km-hand-nodl.toml" && grep -q 'old-laptop' "$WORK/km-hand-nodl.toml"
then ok "with no download target, a hand-written binding on that key survives"
else no "with no download target, a hand-written binding on that key survives"; fi

cp "$WORK/km-hand-out.toml" "$WORK/km-hand-twice.toml"
run_keymap b "#" "$WORK/km-hand-twice.toml" my-laptop
if diff -q "$WORK/km-hand-out.toml" "$WORK/km-hand-twice.toml" >/dev/null
then ok "dropping a claimed hand-written binding is idempotent"
else no "dropping a claimed hand-written binding is idempotent"; fi

# yazi spells `on` four ways, and reading only the double-quoted scalar leaves
# the other three standing beside the managed binding.
cat > "$WORK/km-spellings.toml" <<'T'
[[mgr.prepend_keymap]]
on = [ "b" ]
run = 'shell --block -- my-own-browser "%h"'
desc = "A one-element array"

[[mgr.prepend_keymap]]
on = 'e'
run = 'shell --block -- my-own-editor "%h"'
desc = "Single-quoted"

[[mgr.prepend_keymap]]
on = "#"  # mine, with a trailing comment
run = 'shell --block -- my-own-numbers "%h"'
desc = "A trailing comment after the key"

[[mgr.prepend_keymap]]
on = [ "g", "c" ]
run = 'shell --block -- my-own-sequence "%h"'
desc = "A real multi-key sequence, which collides with nothing"
T
run_keymap b "#" "$WORK/km-spellings.toml"
if parses "$WORK/km-spellings.toml" && python3 - "$WORK/km-spellings.toml" <<'PYSP'
import sys, tomllib
raw = open(sys.argv[1]).read()
binds = tomllib.loads(raw).get("mgr", {}).get("prepend_keymap", [])
for key in ("b", "e", "#"):
    hit = [x for x in binds if x.get("on") == key or x.get("on") == [key]]
    if len(hit) != 1:
        sys.exit(f"{len(hit)} bindings on {key}, expected exactly 1")
for gone in ("my-own-browser", "my-own-editor", "my-own-numbers"):
    if gone in raw:
        sys.exit(f"{gone} survived on a claimed key")
if "my-own-sequence" not in raw:
    sys.exit("a multi-key sequence was dropped, though it collides with nothing")
PYSP
then
  ok "every spelling of a claimed key is replaced, and a multi-key sequence is not"
else
  no "every spelling of a claimed key is replaced, and a multi-key sequence is not"
fi


echo "tuicr config merge safety"
# tuicr's config is flat, so every key this script writes is top level and a
# value the user set by hand before the script managed it is a duplicate. TOML
# forbids that, and tuicr answers an unparseable config by ignoring it.
TUICR_CFG_PY="$WORK/tuicr-config.py"
awk "/^    py \"\\\$HOME\/\.config\/tuicr\/config\.toml\" <<'PY'\$/{f=1; next} f && /^PY\$/{exit} f" \
  "$SETUP" > "$TUICR_CFG_PY"
if [ -s "$TUICR_CFG_PY" ]; then
  ok "the tuicr config writer is extractable from setup.sh"
else
  no "the tuicr config writer is extractable from setup.sh"
fi

# run_tuicr <from-fork> <appearance> <path>
run_tuicr() { SPECHUB_ARGS="$1|30|true|$2|$BEGIN_MARK|$END_MARK" python3 "$TUICR_CFG_PY" "$3" 2>/dev/null; }

cat > "$WORK/tuicr-hand.toml" <<'T'
# Local build, wired up before this script ever managed these.
show_file_line_stats = true
file_list_width = 40
no_update_check = true

# Pinned, not detected.
appearance = "light"

# Mine, and nothing to do with this script.
my_own_setting = "untouched"
T

cp "$WORK/tuicr-hand.toml" "$WORK/tuicr-fork.toml"
run_tuicr true dark "$WORK/tuicr-fork.toml"
tuicr_read=$(python3 - "$WORK/tuicr-fork.toml" <<'PYT'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], 'rb'))
print(d.get('show_file_line_stats'), d.get('file_list_width'),
      d.get('no_update_check'), d.get('appearance'), d.get('my_own_setting'))
PYT
)
if [ "$tuicr_read" = "True 30 True dark untouched" ]
then ok "a hand-written value is replaced by the managed one, and an unmanaged key survives"
else no "expected 'True 30 True dark untouched', parsed: ${tuicr_read:-nothing (invalid TOML)}"; fi

# The comment that introduced a replaced key has to leave with it, or the file
# is left with a heading over settings that are no longer there.
if ! grep -q 'wired up before' "$WORK/tuicr-fork.toml" \
  && ! grep -q 'Pinned, not detected' "$WORK/tuicr-fork.toml" \
  && grep -q 'Mine, and nothing to do' "$WORK/tuicr-fork.toml"
then ok "a comment introducing a replaced key leaves with it"
else no "a comment introducing a replaced key leaves with it"; fi

cp "$WORK/tuicr-fork.toml" "$WORK/tuicr-twice.toml"
run_tuicr true dark "$WORK/tuicr-twice.toml"
if diff -q "$WORK/tuicr-fork.toml" "$WORK/tuicr-twice.toml" >/dev/null
then ok "re-applying the tuicr config is idempotent"
else no "re-applying the tuicr config is idempotent"; fi

# A stock release warns on every start about a key it does not know, so the
# three fork-only keys are not written - and a hand-written one is therefore
# not this script's to remove.
cp "$WORK/tuicr-hand.toml" "$WORK/tuicr-stock.toml"
run_tuicr false "" "$WORK/tuicr-stock.toml"
stock_read=$(python3 - "$WORK/tuicr-stock.toml" <<'PYS'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], 'rb'))
print(d.get('file_list_width'), d.get('appearance'))
PYS
)
if [ "$stock_read" = "40 light" ]
then ok "with the stock release and no appearance, both hand-written values are left alone"
else no "expected '40 light', parsed: ${stock_read:-nothing (invalid TOML)}"; fi

# A fresh machine, with nothing written yet.
rm -f "$WORK/tuicr-fresh.toml"
run_tuicr true dark "$WORK/tuicr-fresh.toml"
fresh_read=$(python3 - "$WORK/tuicr-fresh.toml" <<'PYF'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], 'rb'))
print(d.get('file_list_width'), d.get('appearance'))
PYF
)
if [ "$fresh_read" = "30 dark" ]
then ok "a fresh tuicr config gets the managed keys"
else no "expected '30 dark', parsed: ${fresh_read:-nothing (invalid TOML)}"; fi

# Every key this writer produces is top level, so the block has to go ABOVE the
# first table header. Appended at the end it lands inside whatever section came
# last: tuicr then reports an unknown key in that section and never sees the
# setting, and a name the section already uses makes the file invalid outright.
cat > "$WORK/tuicr-tables.toml" <<'T'
appearance = "light"
my_own_setting = "untouched"

# Mine, and it introduces the section below it.
[export]
legend = false
appearance = "light"
T
cp "$WORK/tuicr-tables.toml" "$WORK/tuicr-tables-out.toml"
run_tuicr true dark "$WORK/tuicr-tables-out.toml"
tables_read=$(python3 - "$WORK/tuicr-tables-out.toml" <<'PYTT'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], 'rb'))
print(d.get('appearance'), d.get('my_own_setting'),
      (d.get('export') or {}).get('appearance'), (d.get('export') or {}).get('legend'))
PYTT
)
if [ "$tables_read" = "dark untouched light False" ]
then ok "the managed block lands above the first table, not inside it"
else no "expected 'dark untouched light False', parsed: ${tables_read:-nothing (invalid TOML)}"; fi

if grep -q 'Mine, and it introduces' "$WORK/tuicr-tables-out.toml"
then ok "the comment introducing the user's table stays with that table"
else no "the comment introducing the user's table stays with that table"; fi

cp "$WORK/tuicr-tables-out.toml" "$WORK/tuicr-tables-twice.toml"
run_tuicr true dark "$WORK/tuicr-tables-twice.toml"
if diff -q "$WORK/tuicr-tables-out.toml" "$WORK/tuicr-tables-twice.toml" >/dev/null
then ok "re-applying over a file with tables is idempotent"
else no "re-applying over a file with tables is idempotent"; fi

echo "the opener route"
# The opener is a service on the user's laptop that takes a page and puts it in
# the default browser there. It is not the bridge: no tab to arm, no extension,
# and the browser it reaches is the one the user actually uses. These pin that
# the route is decided by asking it - never by finding a token on disk - and
# that a document handed over is only called delivered when the opener says so.
OWORK="$WORK/opener"
mkdir -p "$OWORK/bin" "$OWORK/home/.config/spechub"
cp "$(extract spechub-open)" "$OWORK/bin/spechub-open"
cp "$(extract spechub-clip)" "$OWORK/bin/spechub-clip"
cp "$(extract spechub-md)"   "$OWORK/bin/spechub-md"
chmod +x "$OWORK/bin"/*
OTOKEN="$OWORK/home/.config/spechub/opener.token"

# A stand-in for the opener that speaks the same protocol and writes down what
# it was asked to do. $OWORK/mode steers the answer, because "opened a tab",
# "reused the one already open" and "did not manage it" are three different
# things the helper has to tell apart.
cat > "$OWORK/opener.py" <<'OPENER'
import http.server, json, pathlib, socketserver, sys
work = pathlib.Path(sys.argv[1])
token = sys.argv[2]
log = work / "opener.log"

class H(http.server.BaseHTTPRequestHandler):
    def note(self, *parts):
        with log.open("a") as f:
            f.write(" ".join(parts) + "\n")

    def reply(self, code, obj):
        # Compact, because the real opener answers with JSON.stringify and a
        # stand-in that formats differently would be testing the wrong thing.
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        if self.headers.get("X-Spechub-Token") == token:
            return True
        self.note("UNAUTHED", self.path)
        self.reply(401, {"error": "bad or missing token"})
        return False

    def mode(self):
        f = work / "mode"
        return f.read_text().strip() if f.exists() else "open"

    def do_GET(self):
        if not self.authed():
            return
        if self.path == "/health":
            self.note("health")
            return self.reply(200, {"opener": 1, "docs": 0, "mermaid": (work / "mermaid").exists()})
        if self.path == "/bridge/health":
            self.note("bridge-health")
            return self.reply(200, {"tasks": {"Playwriter-Relay": "Running"}})
        self.reply(404, {"error": "no"})

    def do_POST(self):
        if not self.authed():
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.path.startswith("/open"):
            url = json.loads(body or b"{}").get("url", "")
            self.note("open", url)
            if self.mode() == "fail":
                return self.reply(500, {"opened": False})
            return self.reply(200, {"opened": True, "url": url})
        if self.path.startswith("/asset/mermaid.js"):
            (work / "mermaid").write_text("yes")
            self.note("mermaid", str(len(body)))
            return self.reply(200, {"cached": True})
        if self.path.startswith("/bridge/restart"):
            what = json.loads(body or b"{}").get("what", "")
            self.note("bridge-restart", what)
            return self.reply(200, {"restarted": ["Playwriter-Relay"]})
        if self.path.startswith("/doc"):
            (work / "pushed.html").write_bytes(body)
            self.note("doc", self.path.split("?", 1)[-1])
            m = self.mode()
            if m == "fail":
                return self.reply(200, {"url": "x", "opened": False, "reused": False})
            if m == "reuse":
                return self.reply(200, {"url": "x", "reused": True, "opened": False})
            return self.reply(200, {"url": "x", "reused": False, "opened": True})
        self.reply(404, {"error": "no"})

    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
OPENER

# Sets $OURL and $OPENER_PID rather than printing: a command substitution runs
# in a subshell and the pid to kill would not survive it.
opener_up() {
  rm -f "$OWORK/opener.port" "$OWORK/opener.log" "$OWORK/mode" "$OWORK/mermaid"
  python3 "$OWORK/opener.py" "$OWORK" "$(cat "$OTOKEN")" > "$OWORK/opener.port" 2>/dev/null &
  OPENER_PID=$!
  local i=0
  while [ ! -s "$OWORK/opener.port" ] && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.1; done
  OURL="http://127.0.0.1:$(cat "$OWORK/opener.port")"
}
opener_down() {
  kill "$OPENER_PID" 2>/dev/null
  wait "$OPENER_PID" 2>/dev/null
  rm -f "$OWORK/opener.port"
}
obare() { env -i PATH="$OWORK/bin:/usr/bin:/bin" HOME="$OWORK/home" "$@"; }

# A token on disk is not a service that is up. With nothing listening, the
# route must fall through rather than be taken on the strength of a file.
printf 'test-token-0123456789' > "$OTOKEN"
if [ "$(obare env SPECHUB_OPENER_URL=http://127.0.0.1:1 spechub-open --why 2>/dev/null)" != "opener" ]; then
  ok "a token with nothing answering is not the opener route"
else
  no "a token with nothing answering is not the opener route"
fi

opener_up

# And a service that is up is no use without the credential it will demand, so
# the probe has to carry it. No token file at all must not take the route.
mv "$OTOKEN" "$OTOKEN.away"
if [ "$(obare env SPECHUB_OPENER_URL="$OURL" spechub-open --why 2>/dev/null)" != "opener" ]; then
  ok "an opener that is up but has no token here is not the opener route"
else
  no "an opener that is up but has no token here is not the opener route"
fi
mv "$OTOKEN.away" "$OTOKEN"

# A wrong token is the same as no token: the probe is answered 401 and the
# route is not taken.
printf 'wrong-token' > "$OTOKEN"
if [ "$(obare env SPECHUB_OPENER_URL="$OURL" spechub-open --why 2>/dev/null)" != "opener" ]; then
  ok "a token the opener rejects is not the opener route"
else
  no "a token the opener rejects is not the opener route"
fi
printf 'test-token-0123456789' > "$OTOKEN"

if [ "$(obare env SPECHUB_OPENER_URL="$OURL" spechub-open --why 2>/dev/null)" = "opener" ]; then
  ok "a healthy opener holding the same token is the opener route"
else
  no "a healthy opener holding the same token is the opener route"
fi

if [ "$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_OPEN_OPENER=off spechub-open --why 2>/dev/null)" != "opener" ]; then
  ok "\$SPECHUB_OPEN_OPENER=off gives the opener route up"
else
  no "\$SPECHUB_OPEN_OPENER=off gives the opener route up"
fi

# Both reachable at once is the interesting case: the bridge drives a browser
# for an agent and needs a tab armed by hand, the opener reaches the browser
# the user actually uses. The opener wins.
printf '#!/bin/sh\nexit 0\n' > "$OWORK/bin/agent-browser"
chmod +x "$OWORK/bin/agent-browser"
relay_up '[{"id":"1","type":"page","url":"https://example.com"}]'
if [ "$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL="$BURL" spechub-open --why 2>/dev/null)" = "opener" ]; then
  ok "with both reachable the opener outranks the bridge"
else
  no "with both reachable the opener outranks the bridge"
fi
kill "$RELAY_PID" 2>/dev/null; wait "$RELAY_PID" 2>/dev/null
rm -f "$WORK/relay.port" "$OWORK/bin/agent-browser"

obare env SPECHUB_OPENER_URL="$OURL" spechub-open "https://example.com/pr/7" >/dev/null 2>&1
if grep -q '^open https://example.com/pr/7$' "$OWORK/opener.log" 2>/dev/null; then
  ok "the opener route hands the URL to the opener"
else
  no "the opener route hands the URL to the opener"
fi

# An opener that took the request and did not open anything is not a success.
# The link screen is the fallback, and a pty is what tells the helper it has
# somewhere to draw it.
printf 'fail' > "$OWORK/mode"
screen=$(printf x | obare env SPECHUB_OPENER_URL="$OURL" \
  script -qec 'spechub-open https://example.com/pr/8' /dev/null 2>/dev/null)
if printf '%s' "$screen" | grep -q $'\033]8;;https://example.com/pr/8\033'; then
  ok "an opener that did not open it falls back to a link you can click"
else
  no "an opener that did not open it falls back to a link you can click"
fi
rm -f "$OWORK/mode"

# --- the document path -----------------------------------------------------
cat > "$OWORK/doc.md" <<'MD'
# Opener test

```mermaid
graph LR
  A --> B
```
MD

obare env SPECHUB_OPENER_URL="$OURL" spechub-md --browser "$OWORK/doc.md" >/dev/null 2>&1
pushed="$OWORK/pushed.html"
if [ -s "$pushed" ] \
   && grep -q '<title>doc.md</title>' "$pushed" \
   && grep -q 'class="mermaid"' "$pushed" \
   && grep -q 'graph LR' "$pushed"; then
  okr "--browser pushes the whole rendered document to the opener, diagrams included"
else
  nor "--browser pushes the whole rendered document to the opener, diagrams included"
fi

# The opener serves the page, so a relative src resolves against it - and
# unlike --serve that holds whether or not this machine vendored anything.
if grep -q '<script src="/mermaid.js"></script>' "$pushed"; then
  okr "a document bound for the opener asks it for mermaid rather than a CDN"
else
  nor "a document bound for the opener asks it for mermaid rather than a CDN"
fi

# The key is what lets the opener recognise the same file again, so it has to
# be the absolute path - and hex-encoded, because a path may hold anything a
# query string cannot carry.
want_key=$(printf '%s' "$OWORK/doc.md" | od -An -v -tx1 | tr -d ' \n')
if grep -q "key=$want_key" "$OWORK/opener.log"; then
  ok "--browser keys the document by its absolute path, hex-encoded"
else
  no "--browser keys the document by its absolute path, hex-encoded"
fi

# Serving would leave a port behind on a machine whose ports nobody can reach.
if ! pgrep -f 'spechub-md-serve' >/dev/null 2>&1; then
  ok "--browser on the opener route leaves no server behind"
else
  no "--browser on the opener route leaves no server behind"
fi

printf 'reuse' > "$OWORK/mode"
out=$(obare env SPECHUB_OPENER_URL="$OURL" spechub-md --browser "$OWORK/doc.md" 2>&1 >/dev/null)
if printf '%s' "$out" | grep -q 'updated in the tab already open'; then
  ok "a re-render the opener reused is reported as an update, not a new tab"
else
  no "a re-render the opener reused is reported as an update, not a new tab (got '$out')"
fi

# Exit status 0 is not a page that arrived. The opener answers with what it
# did, and anything short of opening or reusing is a failure worth saying.
printf 'fail' > "$OWORK/mode"
if ! obare env SPECHUB_OPENER_URL="$OURL" spechub-md --browser "$OWORK/doc.md" >/dev/null 2>&1; then
  ok "--browser fails when the opener does not confirm the page reached a browser"
else
  no "--browser fails when the opener does not confirm the page reached a browser"
fi
rm -f "$OWORK/mode"

# Vendored mermaid goes up once, so a diagram draws without reaching a CDN.
mkdir -p "$OWORK/home/.local/share/spechub"
printf 'pretend-this-is-mermaid' > "$OWORK/home/.local/share/spechub/mermaid.min.js"
obare env SPECHUB_OPENER_URL="$OURL" spechub-md --browser "$OWORK/doc.md" >/dev/null 2>&1
if grep -q '^mermaid ' "$OWORK/opener.log"; then
  ok "the vendored mermaid is uploaded to an opener that has none"
else
  no "the vendored mermaid is uploaded to an opener that has none"
fi
before=$(grep -c '^mermaid ' "$OWORK/opener.log")
obare env SPECHUB_OPENER_URL="$OURL" spechub-md --browser "$OWORK/doc.md" >/dev/null 2>&1
if [ "$(grep -c '^mermaid ' "$OWORK/opener.log")" = "$before" ]; then
  ok "an opener that already holds mermaid is not sent it again"
else
  no "an opener that already holds mermaid is not sent it again"
fi

# The token can go missing between the route being chosen and the document
# being sent. That guard is unreachable through the real spechub-open, which
# will not name the opener route without a token, so the route is stubbed to
# reach it - and it must refuse rather than fall through to serving a port
# nobody on the far side can reach.
mkdir -p "$OWORK/stub"
cat > "$OWORK/stub/spechub-open" <<'SO'
#!/bin/sh
[ "$1" = "--why" ] && { echo opener; exit 0; }
exit 0
SO
chmod +x "$OWORK/stub/spechub-open"
mv "$OTOKEN" "$OTOKEN.away"
if ! env -i PATH="$OWORK/stub:$OWORK/bin:/usr/bin:/bin" HOME="$OWORK/home" \
     SPECHUB_OPENER_URL="$OURL" timeout 20 "$OWORK/bin/spechub-md" --browser "$OWORK/doc.md" \
     >/dev/null 2>&1; then
  ok "--browser refuses rather than guessing when there is no opener token"
else
  no "--browser refuses rather than guessing when there is no opener token"
fi
mv "$OTOKEN.away" "$OTOKEN"

opener_down

# vm-free-port.sh gained a second port to clear, and must still refuse every
# other one - the guardrails inside it only reason correctly about sockets
# this setup put there.
FREEPORT="$(dirname "$SETUP")/../playwriter-bridge/vm-free-port.sh"
# --- spechub-bridge: seeing and fixing the bridge from here ----------------
# Restarting the relay or the tunnel is a Windows scheduled task, so this
# machine cannot do it directly. It asks the opener, which can. When the opener
# is not reachable either, the paste-ready handoff block is the answer - and it
# has to survive being written, because it is pasted verbatim into a shell on
# the other machine.
cp "$(extract spechub-bridge)" "$OWORK/bin/spechub-bridge"
chmod +x "$OWORK/bin/spechub-bridge"
opener_up

out=$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
        spechub-bridge status 2>&1)
if printf '%s' "$out" | grep -q '^relay:   not reachable' \
   && printf '%s' "$out" | grep -q '^opener:  reachable'; then
  ok "spechub-bridge status separates what this machine sees from what the opener sees"
else
  no "spechub-bridge status separates what this machine sees from what the opener sees (got '$out')"
fi

# Only the opener can see the laptop's scheduled tasks from here.
if printf '%s' "$out" | grep -q '^tasks:.*Playwriter-Relay'; then
  ok "spechub-bridge status reads the laptop's tasks through the opener"
else
  no "spechub-bridge status reads the laptop's tasks through the opener"
fi

mv "$OTOKEN" "$OTOKEN.away"
out=$(obare env SPECHUB_OPENER_URL="$OURL" spechub-bridge status 2>&1)
if printf '%s' "$out" | grep -q 'no token at'; then
  ok "spechub-bridge status names a missing token rather than calling it unreachable"
else
  no "spechub-bridge status names a missing token rather than calling it unreachable"
fi
mv "$OTOKEN.away" "$OTOKEN"

if ! obare env SPECHUB_OPENER_URL="$OURL" spechub-bridge fix nonsense >/dev/null 2>&1; then
  ok "spechub-bridge fix refuses a target it does not know"
else
  no "spechub-bridge fix refuses a target it does not know"
fi

obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
  spechub-bridge fix relay >/dev/null 2>&1
if grep -q '^bridge-restart relay$' "$OWORK/opener.log"; then
  ok "spechub-bridge fix asks the opener to restart the task named"
else
  no "spechub-bridge fix asks the opener to restart the task named"
fi

# Accepted is not recovered. With the relay still not answering here, this must
# report failure rather than the request having been taken.
if ! obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
     spechub-bridge fix relay >/dev/null 2>&1; then
  ok "spechub-bridge fix fails when the restart did not bring the relay back"
else
  no "spechub-bridge fix fails when the restart did not bring the relay back"
fi


# --- clearing this machine's ports before the laptop is asked to restart -----
# A tunnel that will not rebind is usually held from this side: the VM's sshd
# still owns the forward channel of a session that dropped. Restarting the task
# on the laptop then fails exactly the way it failed before, because nothing
# here let go of the port. So the clearing happens first - and for both ports,
# because the opener's 19989 is forwarded by its own task and wedges on its own.
#
# The clearer is recorded into the opener's log rather than a log of its own, so
# "before" is a thing the test can see rather than assume.
cat > "$OWORK/bin/free-port-stub" <<FP
#!/bin/sh
# Advertises --port the way the shipped clearer does, so the caller's
# older-version check reads this stub as current and still clears both ports.
case "\${1:-}" in --port) ;; esac
printf 'free-port [%s]\n' "\$*" >> "$OWORK/opener.log"
exit 0
FP
chmod +x "$OWORK/bin/free-port-stub"

: > "$OWORK/opener.log"
obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
  SPECHUB_FREE_PORT="$OWORK/bin/free-port-stub" spechub-bridge fix both >/dev/null 2>&1
fp_count=$(grep -c '^free-port ' "$OWORK/opener.log")
last_fp=$(grep -n '^free-port ' "$OWORK/opener.log" | tail -1 | cut -d: -f1)
first_restart=$(grep -n '^bridge-restart ' "$OWORK/opener.log" | head -1 | cut -d: -f1)
if [ "$fp_count" = "2" ] \
   && grep -qxF 'free-port [--port 19989]' "$OWORK/opener.log" \
   && grep -qE '^free-port \[(|--port 19988)\]$' "$OWORK/opener.log" \
   && [ -n "$last_fp" ] && [ -n "$first_restart" ] && [ "$last_fp" -lt "$first_restart" ]; then
  ok "spechub-bridge fix clears 19988 and 19989 here before asking for a restart"
else
  no "spechub-bridge fix clears 19988 and 19989 here before asking for a restart (log: $(tr '\n' '|' < "$OWORK/opener.log"))"
fi

# fix relay touches no tunnel, so clearing a forwarded port would be tearing
# down a working connection to fix something else.
: > "$OWORK/opener.log"
obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
  SPECHUB_FREE_PORT="$OWORK/bin/free-port-stub" spechub-bridge fix relay >/dev/null 2>&1
if ! grep -q '^free-port ' "$OWORK/opener.log" \
   && grep -q '^bridge-restart relay$' "$OWORK/opener.log"; then
  ok "spechub-bridge fix relay leaves the forwarded ports alone"
else
  no "spechub-bridge fix relay leaves the forwarded ports alone (log: $(tr '\n' '|' < "$OWORK/opener.log"))"
fi

# The clearer ships with spechub and may simply not be installed on a machine
# that got the terminal workspace some other way. That is worth saying, but it
# is not a reason to refuse the restart - which may be all that was needed.
: > "$OWORK/opener.log"
err=$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
        SPECHUB_FREE_PORT="$OWORK/no-such-clearer" spechub-bridge fix both 2>&1 >/dev/null)
if grep -q '^bridge-restart both$' "$OWORK/opener.log" \
   && printf '%s' "$err" | grep -qF "$OWORK/no-such-clearer"; then
  ok "a missing port clearer is a warning, not a refusal to restart"
else
  no "a missing port clearer is a warning, not a refusal to restart (err: $err)"
fi

# An installed clearer that predates --port is the awkward case between the two
# above: it exists, so the missing-file warning never fires, but it only knows
# how to free 19988. Called bare it would clear the bridge port twice and never
# touch 19989 - and worse, the caller would read two successes and believe both
# ports were freed. The version is the thing to report; guessing is not.
cat > "$OWORK/bin/free-port-old" <<'FP'
#!/bin/sh
printf 'oldclearer [%s]\n' "$*" >> OWORKLOG
exit 0
FP
sed -i "s|OWORKLOG|$OWORK/opener.log|" "$OWORK/bin/free-port-old"
chmod +x "$OWORK/bin/free-port-old"

: > "$OWORK/opener.log"
err=$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
        SPECHUB_FREE_PORT="$OWORK/bin/free-port-old" spechub-bridge fix both 2>&1 >/dev/null)
if ! grep -q '^oldclearer ' "$OWORK/opener.log" \
   && printf '%s' "$err" | grep -qi 'older' \
   && printf '%s' "$err" | grep -qF "$OWORK/bin/free-port-old" \
   && grep -q '^bridge-restart both$' "$OWORK/opener.log"; then
  ok "a clearer with no --port support is reported as older, not called bare"
else
  no "a clearer with no --port support is reported as older, not called bare (log: $(tr '\n' '|' < "$OWORK/opener.log"), err: $(printf '%s' "$err" | tr '\n' '|'))"
fi

# The other way the same clearer announces its age: it takes the flag, sees an
# argument it does not know, and exits 64 - the usage code. That is not "the
# port could not be freed", and retrying without the flag would clear the wrong
# port. Same verdict, reached from the exit status instead of the text.
cat > "$OWORK/bin/free-port-usage64" <<'FP'
#!/bin/sh
printf 'usage64 [%s]\n' "$*" >> OWORKLOG
case "${1:-}" in
  --port) exit 64 ;;
esac
exit 0
FP
sed -i "s|OWORKLOG|$OWORK/opener.log|" "$OWORK/bin/free-port-usage64"
chmod +x "$OWORK/bin/free-port-usage64"

: > "$OWORK/opener.log"
err=$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL=http://127.0.0.1:1 \
        SPECHUB_FREE_PORT="$OWORK/bin/free-port-usage64" spechub-bridge fix both 2>&1 >/dev/null)
if ! grep -qE '^usage64 \[\]$' "$OWORK/opener.log" \
   && printf '%s' "$err" | grep -qi 'older' \
   && printf '%s' "$err" | grep -qF "$OWORK/bin/free-port-usage64" \
   && grep -q '^bridge-restart both$' "$OWORK/opener.log"; then
  ok "a clearer that exits 64 on --port is reported as older, not retried bare"
else
  no "a clearer that exits 64 on --port is reported as older, not retried bare (log: $(tr '\n' '|' < "$OWORK/opener.log"), err: $(printf '%s' "$err" | tr '\n' '|'))"
fi

# Two tunnels, two verdicts. A relay that came back says nothing about the
# opener, and an opener that stayed down is the half that leaves this machine
# unable to reach a browser at all - so it has to be checked, and named.
relay_up '[{"id":"1","type":"page","url":"https://example.com"}]'
: > "$OWORK/opener.log"
( sleep 2; kill "$OPENER_PID" 2>/dev/null ) &
killer=$!
out=$(obare env SPECHUB_OPENER_URL="$OURL" SPECHUB_BRIDGE_URL="$BURL" \
        SPECHUB_FREE_PORT="$OWORK/bin/free-port-stub" spechub-bridge fix both 2>&1)
rc=$?
wait "$killer" 2>/dev/null
kill "$RELAY_PID" 2>/dev/null; wait "$RELAY_PID" 2>/dev/null
rm -f "$WORK/relay.port"
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q '19989'; then
  ok "spechub-bridge fix fails and names 19989 when the opener did not come back"
else
  no "spechub-bridge fix fails and names 19989 when the opener did not come back (rc=$rc, out: $(printf '%s' "$out" | tr '\n' '|'))"
fi

opener_down

block=$(obare env SPECHUB_OPENER_URL=http://127.0.0.1:1 spechub-bridge fix both 2>&1)
if printf '%s' "$block" | grep -q 'BEGIN VM-SIDE HANDOFF' \
   && printf '%s' "$block" | grep -q 'END VM-SIDE HANDOFF'; then
  ok "spechub-bridge hands over a block when it cannot reach the opener either"
else
  no "spechub-bridge hands over a block when it cannot reach the opener either"
fi

# The block is pasted verbatim into PowerShell, so a $ the writing shell ate is
# a command that silently does nothing on the other machine.
if printf '%s' "$block" | grep -q 'Start-ScheduledTask -TaskName \$_\.TaskName'; then
  ok "the handoff block keeps its PowerShell variables intact"
else
  no "the handoff block keeps its PowerShell variables intact"
fi

# What is asserted is the allowlist, not the outcome of clearing: whether 19989
# is currently held depends on whether a tunnel is up, which is not this test's
# business. Exit 2 is the argument refusal, so an accepted port is anything but.
if [ -f "$FREEPORT" ]; then
  bash "$FREEPORT" --port 19989 >/dev/null 2>&1; a=$?
  bash "$FREEPORT" --port 19988 >/dev/null 2>&1; b=$?
  bash "$FREEPORT" --port 22 >/dev/null 2>&1; c=$?
  bash "$FREEPORT" --port >/dev/null 2>&1; d=$?
  bash "$FREEPORT" --wat >/dev/null 2>&1; e=$?
  # 64 is the argument refusal and nothing else uses it, so an accepted port is
  # anything but 64 - whatever it then decides about the socket it found.
  if [ "$a" != "64" ] && [ "$b" != "64" ] && [ "$c" = "64" ] && [ "$d" = "64" ] && [ "$e" = "64" ]; then
    ok "vm-free-port.sh accepts the bridge and opener ports and refuses every other"
  else
    no "vm-free-port.sh accepts the bridge and opener ports and refuses every other ($a/$b/$c/$d/$e)"
  fi
fi



echo "the opener's bridge restart"
# The two forwards are separate scheduled tasks - Playwriter-Tunnel-<host>
# carries the relay's 19988, Playwriter-OpenerTunnel-<host> the opener's 19989 -
# because ExitOnForwardFailure means one wedged port on a shared connection
# would take both down. That split is why "restart the tunnel" cannot mean one
# pattern: 'Playwriter-Tunnel*' does not match the opener's task name, so a fix
# that only asked for it would leave the opener's forward dead and the VM with
# no way to reach a browser.
#
# This drives the real opener.js. It shells out to powershell.exe by name, so a
# recording stand-in first on PATH shows which task patterns it asked for, on a
# machine that has no PowerShell at all.
OPENER_JS="$ROOT/assets/playwriter-bridge/opener.js"
if ! command -v node >/dev/null 2>&1; then
  skip "the opener restarts both tunnel tasks for what=tunnel"
  skip "the opener restarts only the relay for what=relay"
  skip "the opener restarts everything for what=both"
else
NWORK="$WORK/opener-node"
mkdir -p "$NWORK/bin" "$NWORK/state/playwriter-bridge"
NTOKEN="node-token-0123456789"
printf '%s' "$NTOKEN" > "$NWORK/state/playwriter-bridge/opener.token"
PSLOG="$NWORK/powershell.log"

cat > "$NWORK/bin/powershell.exe" <<PSFAKE
#!/bin/sh
# Every argument on its own line, so the -Command text can be grepped whole.
# Answers the way Get-ScheduledTask piped into ForEach-Object does: task names,
# one per line.
{ echo "--- invocation ---"; for a in "\$@"; do printf '%s\n' "\$a"; done; } >> "$PSLOG"
echo Playwriter-Relay
exit 0
PSFAKE
chmod +x "$NWORK/bin/powershell.exe"

NPORT=$(python3 -c 'import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
env PATH="$NWORK/bin:$PATH" LOCALAPPDATA="$NWORK/state" SPECHUB_OPENER_PORT="$NPORT" \
  node "$OPENER_JS" >/dev/null 2>&1 &
NODE_PID=$!
i=0
while [ "$i" -lt 80 ] && ! curl -fsS -m 2 -H "X-Spechub-Token: $NTOKEN" \
      "http://127.0.0.1:$NPORT/health" >/dev/null 2>&1; do
  i=$((i + 1)); sleep 0.1
done

nrestart() {  # nrestart <what> -> every PowerShell command it caused, on stdout
  : > "$PSLOG"
  curl -fsS -m 15 -X POST -H "X-Spechub-Token: $NTOKEN" \
    -H 'Content-Type: application/json' --data "$(printf '{"what":"%s"}' "$1")" \
    "http://127.0.0.1:$NPORT/bridge/restart" >/dev/null 2>&1
  cat "$PSLOG" 2>/dev/null
}

asked=$(nrestart tunnel)
if printf '%s' "$asked" | grep -qF 'Playwriter-Tunnel*' \
   && printf '%s' "$asked" | grep -qF 'Playwriter-OpenerTunnel*'; then
  ok "the opener restarts both tunnel tasks for what=tunnel"
else
  no "the opener restarts both tunnel tasks for what=tunnel (asked: $(printf '%s' "$asked" | tr '\n' '|'))"
fi

# The relay is not a tunnel. Restarting it must not take either forward down
# with it, which is the whole reason for asking for one thing at a time.
asked=$(nrestart relay)
if printf '%s' "$asked" | grep -qF 'Playwriter-Relay' \
   && ! printf '%s' "$asked" | grep -qF 'Tunnel'; then
  ok "the opener restarts only the relay for what=relay"
else
  no "the opener restarts only the relay for what=relay (asked: $(printf '%s' "$asked" | tr '\n' '|'))"
fi

# both means the relay and both tunnels - not everything under the prefix. The
# opener itself runs as Playwriter-Opener, so a bare 'Playwriter-*' stops the
# process that is serving this very request: the VM never gets a reply, and the
# one service that could have restarted anything is now down. Every task-name
# pattern asked for is matched against Playwriter-Opener here, so a future
# 'Playwriter-Opener*' is caught the same way the wildcard is.
asked=$(nrestart both)
cmd=$(printf '%s\n' "$asked" | grep -F 'Get-ScheduledTask')
selfkill=""
for pat in $(printf '%s' "$cmd" | grep -o "'[^']*'" | tr -d "'"); do
  case "Playwriter-Opener" in $pat) selfkill="$selfkill $pat" ;; esac
done
if printf '%s' "$cmd" | grep -qF 'Playwriter-Relay' \
   && printf '%s' "$cmd" | grep -qF 'Playwriter-Tunnel*' \
   && printf '%s' "$cmd" | grep -qF 'Playwriter-OpenerTunnel*' \
   && [ -z "$selfkill" ]; then
  ok "what=both restarts the relay and both tunnels, never the opener itself"
else
  no "what=both restarts the relay and both tunnels, never the opener itself (self-killing patterns:${selfkill:- none}; asked: $(printf '%s' "$cmd" | tr '\n' '|'))"
fi

kill "$NODE_PID" 2>/dev/null
wait "$NODE_PID" 2>/dev/null
fi


echo "the neovim unsaved-changes dot"
# The one component that writes into a config directory the user built, so
# every guard around that matters more here than anywhere else: it starts off,
# it writes a whole file of its own rather than editing one of theirs, it
# refuses a file of that name it did not write, and turning it off deletes it.
#
# apply runs for real, with every other component switched off so nothing
# reaches the network. HOME, $BIN, the config and git's global config all
# point inside $WORK, because apply writes files and uninstall deletes them.
NWORK="$WORK/nvim-run"
mkdir -p "$NWORK/home/.local/bin" "$NWORK/home/.config/spechub" \
         "$NWORK/home/.config/nvim/lua/config" "$NWORK/home/.config/nvim/lua/plugins"
NPLUG="$NWORK/home/.config/nvim/lua/plugins/spechub.lua"
nw() {
  env HOME="$NWORK/home" \
      SPECHUB_TW_BIN="$NWORK/home/.local/bin" \
      SPECHUB_TW_CONFIG="$NWORK/home/.config/spechub/terminal-workspace.yaml" \
      GIT_CONFIG_GLOBAL="$NWORK/gitconfig" \
      bash "$SETUP" "$@" 2>&1
}
cat > "$NWORK/home/.config/spechub/terminal-workspace.yaml" <<'NCFG'
enabled: true
herdr: {enabled: false}
gh_dash: {enabled: false}
diffnav: {enabled: false}
delta: {enabled: false}
tuicr: {enabled: false}
lazygit: {enabled: false}
yazi: {enabled: false}
markdown: {enabled: false}
remote: {enabled: false}
neovim: {enabled: true}
NCFG

# apply refuses to run at all off x86_64, so there is nothing to assert there.
case "$(uname -m)" in
  x86_64|amd64) NVIM_APPLY=1 ;;
  *) NVIM_APPLY=0
     printf '  note: apply installs x86_64 binaries only, so the neovim checks\n'
     printf '        that run it are skipped on %s\n' "$(uname -m)" ;;
esac
okn() { if [ "$NVIM_APPLY" = "1" ]; then ok "$1"; else skip "$1"; fi; }
non() { if [ "$NVIM_APPLY" = "1" ]; then no "$1"; else skip "${2:-${1%% (*}}"; fi; }

# No LazyVim yet. The dot is appended to LazyVim's own lualine section, so a
# file written here would sit in the config doing nothing, and the user would
# have no idea why the statusline never changed.
out=$(nw apply)
if [ ! -e "$NPLUG" ] && printf '%s' "$out" | grep -q "LazyVim"; then
  okn "apply writes no plugin file on a machine with no LazyVim, and says so"
else
  non "apply writes no plugin file on a machine with no LazyVim, and says so (said: $(flat "$out"))" \
      "apply writes no plugin file on a machine with no LazyVim, and says so"
fi

echo 'require("lazy").setup({ spec = { { "LazyVim/LazyVim", import = "lazyvim.plugins" } } })' \
  > "$NWORK/home/.config/nvim/lua/config/lazy.lua"

out=$(nw apply)
if [ -f "$NPLUG" ] \
   && grep -q 'lualine_c' "$NPLUG" \
   && grep -q 'vim.bo.modified' "$NPLUG" \
   && grep -q '#f38ba8' "$NPLUG"; then
  okn "apply writes the lualine dot once LazyVim is present"
else
  non "apply writes the lualine dot once LazyVim is present (said: $(flat "$out"))" \
      "apply writes the lualine dot once LazyVim is present"
fi

# Every other writer in this script is idempotent, and a plugin spec appended
# twice would draw two dots.
cp "$NPLUG" "$NWORK/first.lua" 2>/dev/null
nw apply >/dev/null
if [ "$NVIM_APPLY" != "1" ] || diff -q "$NWORK/first.lua" "$NPLUG" >/dev/null; then
  okn "re-applying the neovim component leaves the same file"
else
  non "re-applying the neovim component leaves the same file"
fi

# The colour is a config key rather than a constant, because the dot has to
# match whatever theme the user runs.
python3 - "$NWORK/home/.config/spechub/terminal-workspace.yaml" <<'PYCOL'
import sys, yaml
p = sys.argv[1]
c = yaml.safe_load(open(p))
c["neovim"]["unsaved_dot_color"] = "#00ff00"
yaml.safe_dump(c, open(p, "w"), sort_keys=False)
PYCOL
nw apply >/dev/null
if [ "$NVIM_APPLY" != "1" ] || grep -q '#00ff00' "$NPLUG"; then
  okn "unsaved_dot_color reaches the written file"
else
  non "unsaved_dot_color reaches the written file"
fi

# nvim runs the file as lua, so a broken heredoc is a config error on the
# user's machine and nothing this script can catch for them.
if [ "$NVIM_APPLY" = "1" ] && command -v nvim >/dev/null 2>&1; then
  if nvim --headless \
       -c "lua local f, e = loadfile('$NPLUG'); if e then vim.cmd('cq') end" \
       -c q >/dev/null 2>&1; then
    ok "the written plugin file is valid lua"
  else
    no "the written plugin file is valid lua"
  fi
else
  skip "the written plugin file is valid lua"
fi

# The name is ours by convention alone. A file of that name this script did
# not write belongs to the user, and neither apply nor disable may touch it.
printf -- '-- mine\n' > "$NPLUG"
nw apply >/dev/null
if [ "$(cat "$NPLUG")" = "-- mine" ]; then
  okn "apply leaves a spechub.lua the user wrote by hand alone"
else
  non "apply leaves a spechub.lua the user wrote by hand alone"
fi

out=$(nw disable neovim)
if [ "$(cat "$NPLUG" 2>/dev/null)" = "-- mine" ] \
   && printf '%s' "$out" | grep -q "by hand"; then
  ok "disable leaves a spechub.lua the user wrote by hand alone"
else
  no "disable leaves a spechub.lua the user wrote by hand alone (said: $(flat "$out"))"
fi

# Back to a file this script owns, so the deletion paths have something of
# ours to delete.
rm -f "$NPLUG"
nw apply >/dev/null
out=$(nw disable neovim)
if [ ! -e "$NPLUG" ] && printf '%s' "$out" | grep -qF "neovim.enabled: false"; then
  okn "disable deletes the plugin file and names the config edit that keeps it off"
else
  non "disable deletes the plugin file and names the config edit that keeps it off (said: $(flat "$out"))" \
      "disable deletes the plugin file and names the config edit that keeps it off"
fi

nw apply >/dev/null
out=$(nw uninstall)
if [ ! -e "$NPLUG" ]; then
  okn "uninstall deletes the plugin file too"
else
  non "uninstall deletes the plugin file too (said: $(flat "$out"))" \
      "uninstall deletes the plugin file too"
fi

# LazyVim loads every file under lua/plugins, so a lualine override the user
# wrote in a file of their own does exactly what this component does. Writing
# on top of it draws two dots side by side, and neither file looks wrong on
# its own - the only place the collision is visible is the statusline.
rm -f "$NPLUG"
cat > "$NWORK/home/.config/nvim/lua/plugins/mine.lua" <<'NLUA'
return {
  {
    "nvim-lualine/lualine.nvim",
    opts = function(_, opts)
      table.insert(opts.sections.lualine_c, {
        function()
          return vim.bo.modified and "*" or ""
        end,
      })
    end,
  },
}
NLUA
out=$(nw apply)
if [ ! -e "$NPLUG" ] && printf '%s' "$out" | grep -qF "mine.lua"; then
  okn "apply writes no dot when the user's own lualine override already draws one, and names the file"
else
  non "apply writes no dot when the user's own lualine override already draws one, and names the file (said: $(flat "$out"))" \
      "apply writes no dot when the user's own lualine override already draws one, and names the file"
fi

# A lualine override that says nothing about a modified buffer is a different
# thing entirely, and must not block the dot.
cat > "$NWORK/home/.config/nvim/lua/plugins/mine.lua" <<'NLUA'
return { { "nvim-lualine/lualine.nvim", opts = { options = { globalstatus = true } } } }
NLUA
out=$(nw apply)
if [ -f "$NPLUG" ]; then
  okn "an unrelated lualine override does not block the dot"
else
  non "an unrelated lualine override does not block the dot (said: $(flat "$out"))" \
      "an unrelated lualine override does not block the dot"
fi
# The order that bites: install first, write your own override later. The guard
# has to remove the dot this component already wrote, or the user keeps exactly
# the two dots it exists to prevent.
cat > "$NWORK/home/.config/nvim/lua/plugins/mine.lua" <<'NLUA'
return {
  {
    "nvim-lualine/lualine.nvim",
    opts = function(_, opts)
      table.insert(opts.sections.lualine_c, {
        function()
          return vim.bo.modified and "*" or ""
        end,
      })
    end,
  },
}
NLUA
out=$(nw apply)
if [ ! -e "$NPLUG" ] && printf '%s' "$out" | grep -qF "was removed"; then
  okn "apply removes the dot it wrote earlier once the user's own override appears"
else
  non "apply removes the dot it wrote earlier once the user's own override appears (said: $(flat "$out"))" \
      "apply removes the dot it wrote earlier once the user's own override appears"
fi

rm -f "$NWORK/home/.config/nvim/lua/plugins/mine.lua" "$NPLUG"


echo "disable answers for every component"
# The config names ten components. `disable` has a branch for seven of them,
# and the other three - yazi, markdown, remote - fall through a case with no
# default arm, so the script exits 0 having done nothing and said nothing. A
# silent success on a request that was never carried out is the one outcome a
# user cannot recover from: they believe the component is off.
#
# Everything below runs setup.sh for real, so HOME, $BIN, the config path and
# git's global config all have to point inside $WORK. uninstall deletes files
# and unsets git settings, and a leak here would edit the machine running the
# suite.
UWORK="$WORK/tw-run"
mkdir -p "$UWORK/home/.local/bin" "$UWORK/home/.config/spechub"
tw() {
  env HOME="$UWORK/home" \
      SPECHUB_TW_BIN="$UWORK/home/.local/bin" \
      SPECHUB_TW_CONFIG="$UWORK/home/.config/spechub/terminal-workspace.yaml" \
      GIT_CONFIG_GLOBAL="$UWORK/gitconfig" \
      bash "$SETUP" "$@" 2>&1
}

cp "$ROOT/assets/terminal-workspace/config.example.yaml" \
   "$UWORK/home/.config/spechub/terminal-workspace.yaml"

# The three components with no branch. Turning one of these off is a config
# edit, so the only useful answer is to refuse and say which edit to make.
for comp in yazi markdown remote; do
  out=$(tw disable "$comp"); rc=$?
  if [ "$rc" != "0" ] \
     && printf '%s' "$out" | grep -qF "$comp.enabled: false" \
     && printf '%s' "$out" | grep -q 'apply'; then
    ok "disable $comp refuses and names the config edit that turns it off"
  else
    no "disable $comp refuses and names the config edit that turns it off (rc=$rc, said: $(flat "$out"))"
  fi
done

# A name that is not a component at all takes the same silent path today.
out=$(tw disable bogus); rc=$?
missing=""
for c in herdr delta diffnav gh_dash harlequin lazygit neovim tuicr; do
  printf '%s' "$out" | grep -qF "$c" || missing="$missing $c"
done
if [ "$rc" != "0" ] && [ -z "$missing" ]; then
  ok "disable rejects an unknown component and lists the eight it supports"
else
  no "disable rejects an unknown component and lists the eight it supports (rc=$rc, unlisted:${missing:- none}; said: $(flat "$out"))"
fi

# tuicr gained a disable branch without reaching the usage line, so the one
# place a user goes to find out what they may type still omits it.
out=$(tw disable); rc=$?
missing=""
for c in herdr delta diffnav gh_dash harlequin lazygit neovim tuicr; do
  printf '%s' "$out" | grep -qF "$c" || missing="$missing $c"
done
if [ "$rc" != "0" ] && [ -z "$missing" ]; then
  ok "the usage line for disable lists all eight supported components"
else
  no "the usage line for disable lists all eight supported components (rc=$rc, unlisted:${missing:- none}; said: $(flat "$out"))"
fi


echo "outdated reports what a machine is missing"
# Every check here is offline: SPECHUB_TW_OFFLINE=1 skips the release lookups,
# so nothing in the suite touches the network. The version comparison itself is
# covered by the table check below rather than by a live call, because a
# passing suite must not depend on GitHub being up.
OWORK="$WORK/tw-outdated"
mkdir -p "$OWORK/home/.config/spechub" "$OWORK/home/.config/herdr"
otw() {
  env HOME="$OWORK/home" \
      SPECHUB_TW_BIN="$OWORK/home/.local/bin" \
      SPECHUB_TW_CONFIG="$OWORK/home/.config/spechub/terminal-workspace.yaml" \
      SPECHUB_TW_OFFLINE=1 \
      bash "$SETUP" "$@" 2>&1
}
cp "$ROOT/assets/terminal-workspace/config.example.yaml" \
   "$OWORK/home/.config/spechub/terminal-workspace.yaml"
STAMPF="$OWORK/home/.config/spechub/terminal-workspace.applied"
OHERDR="$OWORK/home/.config/herdr/config.toml"

# No stamp and no managed block: apply has never run here at all. Listing what
# is behind would claim a workspace exists, so the one true thing is that none
# of it is installed.
out=$(otw outdated); rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -q '^missing	workspace	'; then
  ok "outdated says the workspace was never applied on a machine it has not touched"
else
  no "outdated with no stamp and no managed block (rc=$rc, said: $(flat "$out"))"
fi

# A managed block but no stamp: an older version applied here, before the stamp
# existed. Nothing can be compared, and saying so beats guessing.
printf '%s\n%s\n' "$BEGIN_MARK" "$END_MARK" > "$OHERDR"
out=$(otw outdated); rc=$?
if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q 'no stamp'; then
  ok "outdated says so rather than guessing when an older apply left no stamp"
else
  no "outdated with a managed block and no stamp (rc=$rc, said: $(flat "$out"))"
fi

# A stamp from a version that predates harlequin. That is the finding the whole
# feature exists for.
python3 - "$ROOT/assets/terminal-workspace/config.example.yaml" "$STAMPF" <<'PYSTAMP'
import sys
import yaml
keys = [k for k in (yaml.safe_load(open(sys.argv[1])) or {}) if k != "harlequin"]
open(sys.argv[2], "w").write("\n".join(keys) + "\n")
PYSTAMP
out=$(otw outdated); rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -q '^new	harlequin	'; then
  ok "outdated reports a component the last apply never saw"
else
  no "outdated does not report harlequin as new (rc=$rc, said: $(flat "$out"))"
fi

# The same stamp, but the block is now in the user's yaml, which is what
# upgrade leaves behind. The row stays, because apply still has to install the
# component; only the detail moves, because "not in your config" is now false.
printf '\nharlequin:\n  enabled: true\n' \
  >> "$OWORK/home/.config/spechub/terminal-workspace.yaml"
out=$(otw outdated); rc=$?
if [ "$rc" = "1" ] && printf '%s' "$out" | grep -q '^new	harlequin	new component, run apply'; then
  ok "a new component that upgrade already added reads as one to install, not one to add"
else
  no "outdated still says harlequin is not in the config (rc=$rc, said: $(flat "$out"))"
fi
cp "$ROOT/assets/terminal-workspace/config.example.yaml" \
   "$OWORK/home/.config/spechub/terminal-workspace.yaml"

# A stamp that names every shipped component. Nothing is new, nothing is
# reachable offline, so there is nothing to say.
python3 - "$ROOT/assets/terminal-workspace/config.example.yaml" "$STAMPF" <<'PYSTAMP'
import sys
import yaml
open(sys.argv[2], "w").write(
    "\n".join(yaml.safe_load(open(sys.argv[1])) or {}) + "\n")
PYSTAMP
out=$(otw outdated); rc=$?
if [ "$rc" = "0" ] && [ -z "$out" ]; then
  ok "outdated says nothing when the stamp matches what ships"
else
  no "outdated should be silent and exit 0 (rc=$rc, said: $(flat "$out"))"
fi

# A fork build comes from a local checkout, so a release archive would replace
# it with the stock binary and drop the patches it carries. outdated already
# skips it, and naming it on upgrade has to skip it too.
printf 'tuicr:\n  build_from_fork: true\n' \
  > "$OWORK/home/.config/spechub/terminal-workspace.yaml"
# A curl that always fails, so this check cannot reach the network even if the
# guard it tests regresses. SPECHUB_TW_OFFLINE gates the version lookups and
# not install_binary, which is the call a regression here would reach.
NOCURL="$WORK/nocurl"; mkdir -p "$NOCURL"
printf '#!/usr/bin/env bash\nexit 1\n' > "$NOCURL/curl"; chmod +x "$NOCURL/curl"
out=$(env HOME="$OWORK/home" \
          SPECHUB_TW_BIN="$OWORK/home/.local/bin" \
          SPECHUB_TW_CONFIG="$OWORK/home/.config/spechub/terminal-workspace.yaml" \
          SPECHUB_TW_OFFLINE=1 PATH="$NOCURL:$PATH" \
          bash "$SETUP" upgrade tuicr 2>&1); rc=$?
cp "$ROOT/assets/terminal-workspace/config.example.yaml" \
   "$OWORK/home/.config/spechub/terminal-workspace.yaml"
if printf '%s' "$out" | grep -q 'fork' && ! printf '%s' "$out" | grep -q 'tuicr installed'; then
  ok "upgrade refuses to overwrite a tuicr built from a fork"
else
  no "upgrade tuicr overwrote a fork build (rc=$rc, said: $(flat "$out"))"
fi

# Exit 2 is the code /spechub:setup reads as "cannot tell", and it is the only
# one that leaves the user unbothered. Without PyYAML nothing here can be
# compared, so exiting 1 would offer an upgrade for findings that do not exist.
NOYAML="$WORK/noyaml"; mkdir -p "$NOYAML"
cat > "$NOYAML/python3" <<'NOYSTUB'
#!/usr/bin/env bash
# A python3 that has everything except PyYAML.
if [ "${1:-}" = "-c" ]; then
  case "${2:-}" in *"import yaml"*) exit 1 ;; esac
fi
exec /usr/bin/python3 "$@"
NOYSTUB
chmod +x "$NOYAML/python3"
out=$(env HOME="$OWORK/home" \
          SPECHUB_TW_BIN="$OWORK/home/.local/bin" \
          SPECHUB_TW_CONFIG="$OWORK/home/.config/spechub/terminal-workspace.yaml" \
          SPECHUB_TW_OFFLINE=1 PATH="$NOYAML:$PATH" \
          bash "$SETUP" outdated 2>&1); rc=$?
if [ "$rc" = "2" ]; then
  ok "outdated exits 2 rather than 1 when it cannot read the config at all"
else
  no "outdated should exit 2 without PyYAML (rc=$rc, said: $(flat "$out"))"
fi

# version_table lives inside setup.sh, so the rows have to be lifted out of the
# source rather than called. Both directions of the check read this.
TABLE_ROWS=$(sed -n '/^version_table()/,/^}/p' "$SETUP" | sed -n '/<</,/^T$/p' | grep -F '	')

# Every GitHub tool in the version table has to name the same repository and the
# same asset match as the install_binary call in apply. Two lists of the same
# facts is exactly how hdiff and hdash outlived themselves.
drift=""
while IFS=$'\t' read -r name _ src repo match; do
  [ "$src" = "github" ] || continue
  grep -qF "install_binary $name $repo $match" "$SETUP" || drift="$drift $name"
done <<< "$TABLE_ROWS"
# And the reverse. A tool apply installs but neither the table nor an arm of
# its own knows about is a tool `upgrade <name>` answers "not a tool this
# script installs" for, however plainly the docs say it can be refreshed.
unreachable=""
while read -r name; do
  [ "$name" = "ya" ] && continue        # yazi's own arm reinstalls it
  cut -f1 <<< "$TABLE_ROWS" | grep -qx "$name" && continue
  sed -n '/^upgrade_one()/,/^}/p' "$SETUP" | grep -qE "^ *$name\)" && continue
  unreachable="$unreachable $name"
done < <(grep -oE 'install_binary [a-z-]+ [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+ ' "$SETUP" \
         | awk '{print $2}' | sort -u)
if [ -z "$unreachable" ]; then ok "every tool apply installs is one upgrade can reach"
else no "upgrade cannot reach tools apply installs:$unreachable"; fi

if [ -n "$drift" ]; then no "version table and install_binary disagree:$drift"
elif [ -z "$TABLE_ROWS" ]; then
  no "the version table has no rows to check"
else ok "the version table matches what apply installs"; fi


echo "spechub-db opens a profile without rewriting the user's file"
# The profile file is the user's. Writing it once is a convenience; writing it
# twice would silently delete a connection string they typed.
DBHELPER="$WORK/db-helper"
awk -v n="spechub-db" '$0 == "  cat > \"$BIN/" n "\" <<'\''H'\''" {f=1; next} f && $0 == "H" {exit} f' \
  "$SETUP" > "$DBHELPER"
DBH="$WORK/db-home"; DBBIN="$WORK/db-bin"
mkdir -p "$DBH/.config/spechub" "$DBBIN"
# A stand-in for harlequin, so the launch is observable and nothing is
# installed to make it so. Without it the helper exits before it reads a
# profile at all, and the check below would pass on a file nothing opened.
cat > "$DBBIN/harlequin" <<'DBSTUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$HOME/harlequin-argv"
DBSTUB
chmod +x "$DBBIN/harlequin"
printf 'default_profile = "mine"\n\n[profiles.mine]\nadapter = "postgres"\n' \
  > "$DBH/.config/spechub/harlequin.toml"
before=$(cat "$DBH/.config/spechub/harlequin.toml")
env HOME="$DBH" PATH="$DBBIN:$PATH" bash "$DBHELPER" >/dev/null 2>&1
if [ "$before" = "$(cat "$DBH/.config/spechub/harlequin.toml")" ]
then ok "spechub-db never rewrites a profile file that already exists"
else no "spechub-db overwrote the user's profile file"; fi

# A path in the config is a path the script has to read, or the config is a
# place a user edits a line and sees nothing happen.
CPW="$WORK/tw-cfgpath"
mkdir -p "$CPW/home/.config/spechub" "$CPW/home/.local/bin"
cat > "$CPW/home/.config/spechub/terminal-workspace.yaml" <<YML
harlequin:
  config_path: "$CPW/home/my profiles.toml"
YML
# setup.sh runs an action the moment it is sourced, so take the functions above
# the case block and leave the action behind. write_helpers writes files and
# reaches no network, which is why it is safe to call where apply is not.
sed '/^case "$ACTION" in$/,$d' "$SETUP" > "$WORK/setup-funcs.sh"
(
  HOME="$CPW/home"
  SPECHUB_TW_BIN="$CPW/home/.local/bin"
  SPECHUB_TW_CONFIG="$CPW/home/.config/spechub/terminal-workspace.yaml"
  # shellcheck disable=SC1090
  . "$WORK/setup-funcs.sh"
  write_helpers
) >/dev/null 2>&1
if grep -qF "'$CPW/home/my profiles.toml'" "$CPW/home/.local/bin/spechub-db" 2>/dev/null
then ok "spechub-db takes its profile path from harlequin.config_path"
else no "spechub-db ignored harlequin.config_path (default line: $(grep -m1 '^DB_CFG_DEFAULT=' "$CPW/home/.local/bin/spechub-db" 2>/dev/null))"; fi

if grep -qF -- '-P mine' "$DBH/harlequin-argv" 2>/dev/null
then ok "spechub-db launches harlequin on the one profile it found"
else no "spechub-db launches harlequin on the one profile (argv: $(cat "$DBH/harlequin-argv" 2>/dev/null))"; fi


echo "uninstall clears every managed region"
# uninstall strips the herdr and tuicr managed regions and leaves the two it
# wrote into the yazi config, plus the keybindings it wrote into gh-dash. What
# is left keeps firing: yazi still routes markdown at spechub-md and gh-dash
# still binds keys to tuicr and spechub-open, all of them binaries uninstall
# has just deleted. The regions are marked, so removing them is the same edit
# already made to herdr's config, and the user's own settings around them must
# come through untouched.
mkdir -p "$UWORK/home/.config/yazi" "$UWORK/home/.config/gh-dash"

# Seeded through the writers themselves, so the region under test is exactly
# the one apply leaves behind. Neither fixture claims a namespace the yazi
# writer wants, so both get the full managed region.
cat > "$UWORK/home/.config/yazi/yazi.toml" <<'YUSER'
[log]
enabled = true

[input]
cursor_blink = true
YUSER
run_yazi true "$UWORK/home/.config/yazi/yazi.toml"

cat > "$UWORK/home/.config/yazi/keymap.toml" <<'KMUSER'
[[mgr.append_keymap]]
on = "T"
run = "plugin toggle-pane"
desc = "Toggle the preview pane"
KMUSER
# run_keymap is the yazi keymap writer extracted in the section above, not the
# herdr one from the top of this file.
run_keymap b "#" "$UWORK/home/.config/yazi/keymap.toml"

# gh-dash reads YAML that python rewrites wholesale, so a comment marker never
# survives a round trip. What identifies spechub's work there is the name on
# each keybinding, which apply already uses to replace its own entries.
cat > "$UWORK/home/.config/gh-dash/config.yml" <<'GHUSER'
prSections:
  - title: Mine
    filters: "is:open author:@me"
keybindings:
  prs:
    - key: X
      name: my own thing
      command: "echo mine"
    - key: D
      name: review (tuicr)
      command: "cd {{.RepoPath}} && tuicr pr {{.PrNumber}}\n"
    - key: o
      name: open in browser
      command: "spechub-open \"https://github.com/{{.RepoName}}/pull/{{.PrNumber}}\"\n"
  universal:
    - key: ctrl+q
      builtin: quit
    - key: pgup
      builtin: pageUp
    - key: pgdown
      builtin: pageDown
GHUSER

# The herdr config is seeded through its own writer, so the regions under test
# are exactly the ones apply leaves behind.
mkdir -p "$UWORK/home/.config/herdr"
: > "$UWORK/home/.config/herdr/config.toml"
SPECHUB_ARGS="$(args alt catppuccin catppuccin-latte herdr true priority)" \
  python3 "$HERDR_KEYMAP" "$UWORK/home/.config/herdr/config.toml"

if grep -qF "$BEGIN_MARK" "$UWORK/home/.config/yazi/yazi.toml" \
   && grep -qF "$BEGIN_MARK" "$UWORK/home/.config/yazi/keymap.toml" \
   && grep -q 'pane_scrollbars = false' "$UWORK/home/.config/herdr/config.toml"; then
  ok "the yazi and herdr fixtures carry a managed region before uninstall runs"
else
  no "the yazi and herdr fixtures carry a managed region before uninstall runs"
fi

uninstall_out=$(tw uninstall); uninstall_rc=$?

if ! grep -qF "$BEGIN_MARK" "$UWORK/home/.config/herdr/config.toml" \
   && ! grep -q 'pane_scrollbars' "$UWORK/home/.config/herdr/config.toml"; then
  ok "uninstall removes pane_scrollbars with the rest of the herdr managed block"
else
  no "uninstall removes pane_scrollbars with the rest of the herdr managed block (rc=$uninstall_rc, said: $(flat "$uninstall_out"))"
fi

# The theme and the toast each get a region of their own, and uninstall strips
# every region rather than only the two it knew about when it was written.
if ! grep -q 'light_name' "$UWORK/home/.config/herdr/config.toml" \
   && ! grep -q 'agent_panel_sort' "$UWORK/home/.config/herdr/config.toml" \
   && ! grep -q 'delivery' "$UWORK/home/.config/herdr/config.toml"; then
  ok "uninstall removes the theme, sort and toast regions too"
else
  no "uninstall removes the theme, sort and toast regions too (rc=$uninstall_rc, said: $(flat "$uninstall_out"))"
fi

if ! grep -qF "$BEGIN_MARK" "$UWORK/home/.config/yazi/yazi.toml" \
   && ! grep -qF "$END_MARK" "$UWORK/home/.config/yazi/yazi.toml" \
   && ! grep -qF 'spechub-md' "$UWORK/home/.config/yazi/yazi.toml"; then
  ok "uninstall removes the managed region from yazi.toml"
else
  no "uninstall removes the managed region from yazi.toml (rc=$uninstall_rc, said: $(flat "$uninstall_out"))"
fi

if parses "$UWORK/home/.config/yazi/yazi.toml" \
   && grep -q 'cursor_blink' "$UWORK/home/.config/yazi/yazi.toml" \
   && grep -q '\[log\]' "$UWORK/home/.config/yazi/yazi.toml"; then
  ok "the user's own yazi.toml settings survive uninstall"
else
  no "the user's own yazi.toml settings survive uninstall"
fi

if ! grep -qF "$BEGIN_MARK" "$UWORK/home/.config/yazi/keymap.toml" \
   && ! grep -qF "$END_MARK" "$UWORK/home/.config/yazi/keymap.toml" \
   && ! grep -qF 'spechub-md' "$UWORK/home/.config/yazi/keymap.toml"; then
  ok "uninstall removes the managed region from the yazi keymap"
else
  no "uninstall removes the managed region from the yazi keymap"
fi

if parses "$UWORK/home/.config/yazi/keymap.toml" \
   && grep -q 'toggle-pane' "$UWORK/home/.config/yazi/keymap.toml"; then
  ok "the user's own yazi keymap bindings survive uninstall"
else
  no "the user's own yazi keymap bindings survive uninstall"
fi

ghq() {  # ghq <python expression over the parsed config, printing PASS or FAIL>
  python3 - "$UWORK/home/.config/gh-dash/config.yml" <<PYGH
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1])) or {}
kb = cfg.get("keybindings", {}) or {}
prs = kb.get("prs", []) or []
universal = kb.get("universal", []) or []
names = [k.get("name") for k in prs]
builtins = [k.get("builtin") for k in universal]
sections = [s.get("title") for s in cfg.get("prSections", []) or []]
$1
PYGH
}

if ghq 'assert "review (tuicr)" not in names, names
assert "open in browser" not in names, names
assert "agent review" not in names, names' 2>/dev/null
then ok "uninstall removes the gh-dash keybindings it wrote"
else no "uninstall removes the gh-dash keybindings it wrote"; fi

if ghq 'assert "my own thing" in names, names
assert "Mine" in sections, sections
assert "quit" in builtins, builtins' 2>/dev/null
then ok "the user's own gh-dash keybindings and sections survive uninstall"
else no "the user's own gh-dash keybindings and sections survive uninstall"; fi

# page_keys is spechub's too. Leaving pgup and pgdown bound after uninstall
# leaves the dashboard scrolling by a keymap nobody owns any more.
if ghq 'assert "pageUp" not in builtins, builtins
assert "pageDown" not in builtins, builtins' 2>/dev/null
then ok "uninstall removes the gh-dash page keys it bound"
else no "uninstall removes the gh-dash page keys it bound"; fi


echo "spechub-edit sends a file to its own herdr tab"
# diffnav's "o" key runs $EDITOR in diffnav's own pane, and a herdr popup
# cannot host a second full-screen app. These pin both halves of the helper
# that carries the file out to a tab instead.
EDITBIN="$WORK/edit-bin"; EDITHOME="$WORK/edit-home"
mkdir -p "$EDITBIN" "$EDITHOME"
cp "$(extract spechub-edit)" "$EDITBIN/spechub-edit"
cp "$(extract spechub-herdr-tab)" "$EDITBIN/spechub-herdr-tab"
printf '#!/bin/sh\necho "editor ran: $*"\n' > "$EDITBIN/fake-editor"
chmod +x "$EDITBIN/fake-editor"
edit_env() { env -i PATH="$EDITBIN:/usr/bin:/bin" HOME="$EDITHOME" \
                 SPECHUB_EDIT_EDITOR="$EDITBIN/fake-editor" "$@"; }

# No herdr means no tab to open, and the file still has to reach the editor.
if [ "$(edit_env spechub-edit /tmp/x.ts 2>&1)" = "editor ran: /tmp/x.ts" ]
then ok "spechub-edit runs the editor in place when herdr is missing"
else no "spechub-edit runs the editor in place when herdr is missing"; fi

# spechub-edit is a wrapper, so the helper it hands the file to has to be
# there. A missing one must still open the file rather than do nothing.
mv "$EDITBIN/spechub-herdr-tab" "$WORK/herdr-tab.parked"
if [ "$(edit_env spechub-edit /tmp/x.ts 2>&1)" = "editor ran: /tmp/x.ts" ]
then ok "spechub-edit runs the editor in place when spechub-herdr-tab is missing"
else no "spechub-edit runs the editor in place when spechub-herdr-tab is missing"; fi
mv "$WORK/herdr-tab.parked" "$EDITBIN/spechub-herdr-tab"

# A stub herdr, so the tab call is checked without a running session. The path
# holds a space, because herdr pane run hands the string to a shell.
cat > "$EDITBIN/herdr" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$HOME/calls"
case "$1 $2" in
  "pane current") echo '{"result":{"pane":{"workspace_id":"w1","cwd":"/repo"}}}' ;;
  "tab create")   echo '{"result":{"root_pane":{"pane_id":"42"}}}' ;;
esac
STUB
chmod +x "$EDITBIN/herdr"

# The helper settles 0.3s before it calls `pane run`, so poll rather than
# guess at a sleep long enough to cover a loaded machine.
await_pane_run() {
  local i=0
  while ! grep -q 'pane run' "$EDITHOME/calls" 2>/dev/null && [ "$i" -lt 50 ]; do
    i=$((i + 1)); sleep 0.1
  done
}

edit_env spechub-edit "/repo/a file.ts" >/dev/null 2>&1
await_pane_run
if grep -q "pane run 42 .*fake-editor.*a\\\\ file.ts" "$EDITHOME/calls" 2>/dev/null
then ok "spechub-edit opens the file in a new herdr tab, path quoted"
else no "spechub-edit opens the file in a new herdr tab, path quoted"; fi

# The label is the basename, so the tab reads as the file rather than the path.
if grep -q 'tab create .*--label a file.ts' "$EDITHOME/calls" 2>/dev/null
then ok "spechub-edit labels the tab with the file's basename"
else no "spechub-edit labels the tab with the file's basename"; fi

# spechub-herdr-tab quotes every argument now, and the five keybindings that
# call it pass bare names. Those must reach the pane unchanged.
: > "$EDITHOME/calls"
edit_env spechub-herdr-tab diffpick spechub-diff pick >/dev/null 2>&1
await_pane_run
if grep -q 'pane run 42 spechub-diff pick' "$EDITHOME/calls" 2>/dev/null
then ok "spechub-herdr-tab leaves an unquoted command untouched"
else no "spechub-herdr-tab leaves an unquoted command untouched"; fi


echo "the config example only documents keys setup.sh reads"
# Both of these carry a comment admitting the script never reads them, which
# makes the example config a place a user can change a number and see nothing
# happen. The port belongs to spechub-md through $SPECHUB_MD_PORT, and the
# dynamic repo section is gh-dash's own setting.
CFGEX="$ROOT/assets/terminal-workspace/config.example.yaml"
if [ -f "$CFGEX" ]; then
  if ! grep -qE '^[[:space:]]*preview_port:' "$CFGEX"; then
    ok "config.example.yaml does not offer preview_port"
  else
    no "config.example.yaml still offers preview_port, which setup.sh never reads"
  fi
  if ! grep -qE '^[[:space:]]*dynamic_repo_section:' "$CFGEX"; then
    ok "config.example.yaml does not offer dynamic_repo_section"
  else
    no "config.example.yaml still offers dynamic_repo_section, which setup.sh never reads"
  fi
else
  no "config.example.yaml exists"
  no "config.example.yaml exists"
fi


if [ "$skipped" -gt 0 ]; then
  printf '\nResult: %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skipped"
else
  printf '\nResult: %d passed, %d failed\n' "$pass" "$fail"
fi
[ "$fail" -eq 0 ]
