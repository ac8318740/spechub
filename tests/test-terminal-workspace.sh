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

blocks=$(grep -c "$BEGIN_MARK" "$WORK/twice.toml")
if [ "$blocks" = "1" ]; then ok "exactly one managed block after two applies"
else no "expected 1 managed block, found $blocks"; fi

# prefix+1..9 needs no modifier, so opting out of the chord family must not
# cost you workspace numbers.
cp "$WORK/hand.toml" "$WORK/none.toml"
run_keymap none "$WORK/none.toml"
if parses "$WORK/none.toml" && grep -q 'switch_workspace' "$WORK/none.toml"
then ok "switch_workspace is bound even when the chord family is off"
else no "switch_workspace is bound even when the chord family is off"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
