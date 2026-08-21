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
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

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
  grep -q "exec -a $name" "$SETUP" && continue
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

# The retired-name check above only sees helpers named spechub-*. The names
# that actually rotted were hdiff and hdash, which predate that convention, so
# check the config example the way a reader uses it: every command it binds
# must be something this machine will actually have.
externals="yazi diffnav delta glow tuicr gh"
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
KEYMAP="$WORK/keymap.py"
awk "/^  SPECHUB_ARGS=.*py \"\\\$HERDR_CFG\" <<'PY'\$/{f=1; next} f && /^PY\$/{exit} f" \
  "$SETUP" > "$KEYMAP"
BEGIN_MARK="# >>> spechub terminal-workspace >>>"
END_MARK="# <<< spechub terminal-workspace <<<"
args() { echo "$1|~/.herdr/worktrees|alt+d|alt+i|alt+y|alt+shift+y|alt+shift+d|alt+shift+i|$BEGIN_MARK|$END_MARK"; }

cat > "$WORK/hand.toml" <<'T'
[keys]
focus_agent = "alt+1..9"
next_tab = ["prefix+n", "alt+right"]
my_own_setting = "untouched"

[[keys.command]]
key = "alt+d"
type = "popup"
command = "my-old-diff"

[theme]
name = "catppuccin"

[worktrees]
directory = "~/.herdr/worktrees"
T

run_keymap() { SPECHUB_ARGS="$(args "$1")" python3 "$KEYMAP" "$2" 2>/dev/null; }
parses() { python3 -c "import tomllib,sys; tomllib.load(open(sys.argv[1],'rb'))" "$1" 2>/dev/null; }

cp "$WORK/hand.toml" "$WORK/merged.toml"
run_keymap alt "$WORK/merged.toml"
if parses "$WORK/merged.toml"; then ok "merging onto a hand-written keymap stays valid TOML"
else no "merging onto a hand-written keymap stays valid TOML"; fi

count=$(grep -c '^\[\[keys.command\]\]' "$WORK/merged.toml")
if [ "$count" = "6" ]; then ok "managed custom commands replace, not duplicate ($count)"
else no "expected 6 [[keys.command]] blocks, found $count"; fi

if grep -q 'my_own_setting' "$WORK/merged.toml" && grep -q 'catppuccin' "$WORK/merged.toml"
then ok "unmanaged settings survive the merge"
else no "unmanaged settings survive the merge"; fi

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

# The route that always works: a terminal, and nothing else. script gives the
# helper a pty, which is what tells it to draw a link rather than give up.
screen=$(printf x | bare script -qec 'SPECHUB_OPEN_BRIDGE=off spechub-open https://example.com/pr/9' /dev/null 2>/dev/null)
if printf '%s' "$screen" | grep -q $'\033]8;;https://example.com/pr/9\033' \
   && [ "$(bare spechub-clip --out 2>/dev/null)" = "https://example.com/pr/9" ]; then
  ok "with a terminal and no browser, o draws a clickable link and copies it"
else
  no "with a terminal and no browser, o draws a clickable link and copies it"
fi

# The bridge is only taken once it has proved what it is attached to. With no
# agent-browser session running, it must not even be asked - probing starts a
# browser as a side effect.
if [ "$(bare spechub-open --why 2>/dev/null)" != "bridge" ]; then
  ok "the bridge route is skipped when nothing has attached to it"
else
  no "the bridge route is skipped when nothing has attached to it"
fi

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
   && printf '%s' "$usage_text" | grep -q -- '--serve'
then
  ok "usage line lists --preview, --diagram and --serve"
else
  no "usage line is missing a flag it should list: $usage_text"
fi

header_block=$(awk '/^#/{print; next} {exit}' "$MD")
if printf '%s' "$header_block" | grep -q -- '--preview'; then
  ok "the header comment documents --preview"
else
  no "the header comment does not document --preview"
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

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
