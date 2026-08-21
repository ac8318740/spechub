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
show() {  # show <label> <git-args...>; refuses to launch on an empty diff
  local label="$1"; shift
  local tmp; tmp=$(mktemp); git "$@" > "$tmp" 2>/dev/null
  if grep -q '^diff --git' "$tmp"; then
    [ -n "$label" ] && echo "$label"; diffnav < "$tmp"
  else
    echo "Nothing to show: $label"; echo "  $(git log -1 --format='%h %s' 2>/dev/null)"
    echo; echo "Press any key..."; read -rsn1
  fi
  rm -f "$tmp"
}
if ! git diff --quiet; then show "" diff
elif ! git diff --cached --quiet; then show "(staged)" diff --cached
# -m --first-parent so a merge commit shows its diff instead of just a header
else show "(no pending changes - last commit)" show HEAD -m --first-parent; fi
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
#   spechub-md --diagram N FILE.md  one diagram alone, with horizontal scroll
#   spechub-md --serve FILE.md      serve it for a real browser, print the link
#
# Text, not images, is deliberate: herdr emits the kitty graphics protocol and
# no terminal reachable from Windows or Android renders that, and e-ink panels
# render text far better than bitmaps anyway. Installed by spechub.
set -uo pipefail

PORT="${SPECHUB_MD_PORT:-6419}"
SERVE=0; ONLY=0
[ "${1:-}" = "--serve" ] && { SERVE=1; shift; }
[ "${1:-}" = "--diagram" ] && { ONLY="${2:-1}"; shift 2; }
# Node labels set a diagram's width, so padding cannot rescue a wide one.
# Tightening still buys roughly a third of the height back.
PAD="${SPECHUB_MD_PAD:--x 2 -y 2}"
COLS=$(tput cols 2>/dev/null || echo 80)
FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "usage: spechub-md [--serve] FILE.md" >&2; exit 1; }

if [ "$SERVE" = "1" ]; then
  # exec -a names the process spechub-md-serve. Without it the running server
  # is just "python3 -" and there is nothing sensible to pkill.
  exec -a spechub-md-serve python3 - "$FILE" "$PORT" <<'PY'
import html, http.server, pathlib, re, socketserver, sys
import markdown

src, port = pathlib.Path(sys.argv[1]), int(sys.argv[2])
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
    js = ('<script src="/mermaid.js"></script>' if VENDOR.exists() else
          '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>')
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(src.name)}</title><style>{CSS}</style></head><body>
{body}
{js}
<script>mermaid.initialize({{startOnLoad:true,securityLevel:"loose",
theme:matchMedia("(prefers-color-scheme:dark)").matches?"dark":"default"}});</script>
</body></html>""".encode()

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
    r = subprocess.run(["mermaid-ascii", "--file", path] + PAD,
                       capture_output=True, text=True)
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
        art_path = pathlib.Path(tempfile.gettempdir()) / f"spechub-md-art.{run}.{n}"
        art_path.write_text(art + "\n")
        return (f"\n```\n\x00SPECHUBART{n}\x00 {width} cols, pans sideways "
                f"with the arrow keys\n```")
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
  less -SR /tmp/spechub-md.$$.md
elif command -v glow >/dev/null 2>&1; then
  # glow drops all styling when stdout is not a terminal, and its output has
  # to be captured to splice the diagrams in, so it runs under a pty.
  SPECHUB_PID=$$ SPECHUB_COLS="$COLS" SPECHUB_STYLE="${SPECHUB_MD_STYLE:-}" \
    python3 - /tmp/spechub-md.$$.md /tmp/spechub-md-out.$$.md <<'PY'
import fcntl, os, pathlib, pty, re, struct, subprocess, sys, termios
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
pid = os.environ["SPECHUB_PID"]
cols = int(os.environ.get("SPECHUB_COLS") or 80)
# Leave glow on "auto": under a pty it picks its full palette. Pinning a
# named style here gives a noticeably flatter one.
style = os.environ.get("SPECHUB_STYLE") or ""

cmd = ["glow", "-w", str(cols - 2)] + (["--style", style] if style else []) + [str(src)]
master, slave = pty.openpty()
# glow reads the width from the pty, not just -w, so set it to match.
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 200, cols, 0, 0))
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
text = b"".join(chunks).decode("utf-8", "replace").replace("\r\n", "\n")
# A pty makes glow probe the terminal for its background colour. Those replies
# are meant for a real terminal, not a file, so drop them.
text = re.sub(r"\x1b\][01][01];\?(\x07|\x1b\\)", "", text)
text = re.sub(r"\x1b\[6n", "", text)

lines = []
for line in text.split("\n"):
    m = re.search(r"\x00SPECHUBART(\d+)\x00", line)
    if not m:
        lines.append(line); continue
    art = pathlib.Path(f"/tmp/spechub-md-art.{pid}.{m.group(1)}")
    lines.append(re.sub(r"\x00SPECHUBART\d+\x00", f"Diagram {m.group(1)}:", line))
    if art.exists():
        lines.extend("  " + l for l in art.read_text().splitlines())
        art.unlink()
dst.write_text("\n".join(lines) + "\n")
PY
  ${PAGER:-less -SR} /tmp/spechub-md-out.$$.md
  rm -f /tmp/spechub-md-out.$$.md /tmp/spechub-md-art.$$.*
else
  ${PAGER:-less -R} /tmp/spechub-md.$$.md
fi
rm -f /tmp/spechub-md.$$.md
H
  chmod +x "$BIN/spechub-md"

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
# A dev VM reached over SSH has no display and no clipboard of its own, so
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
# In order: an explicit override, a desktop on this machine, WSL, the
# Playwriter bridge to Chrome on the laptop, and last a link you can click.
# Installed by spechub.
set -uo pipefail

LOG="${XDG_CACHE_HOME:-$HOME/.cache}/spechub/open.log"
# An ambient $AGENT_BROWSER_CDP is a hint, never the thing we rely on. See
# the bridge branch below for what happened when it was.
BRIDGE="${SPECHUB_BRIDGE_URL:-${AGENT_BROWSER_CDP:-http://127.0.0.1:19988}}"

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
# where no one could see it. So ask what it is actually attached to.
bridge_attached() {
  [ "${SPECHUB_OPEN_BRIDGE:-auto}" != "off" ] || return 1
  command -v agent-browser >/dev/null 2>&1 || return 1
  # Only when a session is already running. Probing otherwise starts a
  # browser as a side effect of asking a question, which is how the stray
  # headless Chrome got there in the first place.
  [ -S "$HOME/.agent-browser/default.sock" ] || return 1
  curl -fsS -m 2 "$BRIDGE/json/version" >/dev/null 2>&1 || return 1
  case "$(timeout 10 agent-browser --cdp "$BRIDGE" get cdp-url 2>/dev/null)" in
    *"${BRIDGE##*/}"*) return 0 ;;
  esac
  return 1
}

route() {  # the route this machine will take, decided without taking it
  [ -n "${SPECHUB_OPEN_CMD:-}" ] && { echo "command"; return; }
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1 \
    && { echo "xdg-open"; return; }
  local opener
  for opener in wslview wsl-open explorer.exe; do
    command -v "$opener" >/dev/null 2>&1 && { echo "$opener"; return; }
  done
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

  say "helpers written: spechub-diff, spechub-dash, spechub-md"
  say "remote helpers written: spechub-clip, spechub-open"
  say "herdr helpers written: spechub-herdr-tab, spechub-herdr-renumber"
}

apply_herdr() {
  have herdr || { say "herdr not installed, skipping keymap"; return 0; }
  mkdir -p "$(dirname "$HERDR_CFG")"; touch "$HERDR_CFG"
  local mod wt diffkey dashkey filekey filetabkey difftabkey dashtabkey
  mod=$(cfg_get herdr.chord_modifier alt)
  wt=$(cfg_get herdr.worktrees_directory "~/.herdr/worktrees")
  diffkey=$(cfg_get diffnav.popup_key "alt+d")
  dashkey=$(cfg_get gh_dash.popup_key "alt+i")
  filekey=$(cfg_get yazi.popup_key "alt+y")
  filetabkey=$(cfg_get yazi.tab_key "alt+shift+y")
  difftabkey=$(cfg_get diffnav.tab_key "alt+shift+d")
  dashtabkey=$(cfg_get gh_dash.tab_key "alt+shift+i")
  [ "$(cfg_get diffnav.enabled true)" = "true" ] || { diffkey=""; difftabkey=""; }
  [ "$(cfg_get gh_dash.enabled true)" = "true" ] || { dashkey=""; dashtabkey=""; }
  [ "$(cfg_get yazi.enabled true)"    = "true" ] || { filekey=""; filetabkey=""; }

  SPECHUB_ARGS="$mod|$wt|$diffkey|$dashkey|$filekey|$filetabkey|$difftabkey|$dashtabkey|$BEGIN|$END" py "$HERDR_CFG" <<'PY'
import os, re, sys
path = sys.argv[1]
mod, wt, diffkey, dashkey, filekey, filetabkey, difftabkey, dashtabkey, begin, end = os.environ["SPECHUB_ARGS"].split("|")

# key, command, description, herdr custom-command type, popup size.
# type "shell" takes no size: herdr rejects width/height on a non-popup.
CUSTOM = [
    (diffkey,    "spechub-diff",                  "diff (diffnav)",     "popup", "90%"),
    (difftabkey, "spechub-herdr-tab diff spechub-diff", "diff (tab)",         "shell", None),
    (dashkey,    "spechub-dash",                  "PR dashboard",       "popup", "95%"),
    (dashtabkey, "spechub-herdr-tab dash spechub-dash", "PR dashboard (tab)", "shell", None),
    (filekey,    "yazi",                          "file tree",          "popup", "95%"),
    (filetabkey, "spechub-herdr-tab yazi yazi",         "file tree (tab)",    "shell", None),
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
        f'goto = ["prefix+g", "{m}+g"]',
        f'zoom = ["prefix+z", "{m}+z"]',
        f'last_pane = "{m}+a"',
        f'new_tab = ["prefix+c", "{m}+c"]',
        f'new_workspace = ["prefix+shift+n", "{m}+w"]',
        f'new_worktree = ["prefix+shift+g", "{m}+r"]',
        f'split_vertical = ["prefix+v", "{m}+e"]',
        f'split_horizontal = ["prefix+minus", "{m}+minus"]',
    ]

# herdr leaves switch_workspace unbound, so without this there is no way to
# reach a workspace by number at all. It is prefix-only, so it is written even
# when the chord family is off: opting out of alt chords should not cost you
# workspace numbers.
keys.append('switch_workspace = "prefix+1..9"')

# TOML forbids a duplicate key, so a hand-written keymap that already sets
# something this script manages would make the merged file unparseable and
# herdr would reject the lot. Drop our own keys from the user's [keys] table,
# and any [[keys.command]] bound to a key we are about to claim, before
# inserting. Anything we do not manage is left exactly as it was.
managed = {k.split("=", 1)[0].strip() for k in keys if "=" in k}
claimed = {key for key, *_ in CUSTOM if key}


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
        table = [ln for ln in table
                 if not (not ln.strip().startswith("#") and "=" in ln
                         and ln.split("=", 1)[0].strip() in managed)]
    kept.extend(table)
text = "\n".join(kept)
if text and not text.endswith("\n"):
    text += "\n"

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
    block += custom_blocks() + ["", "[worktrees]", f'directory = "{wt}"', end]
    text = text.rstrip("\n") + "\n\n" + "\n".join(block) + "\n"
else:
    tail = [begin] + custom_blocks() + ["", "[worktrees]", f'directory = "{wt}"', end]
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
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)
block = f"""{begin}
[[plugin.prepend_previewers]]
url = "*.md"
run = 'piper -- COLUMNS=$w spechub-md --preview "$1"'

[[plugin.prepend_previewers]]
url = "*.markdown"
run = 'piper -- COLUMNS=$w spechub-md --preview "$1"'

# The preview pane is narrow, so a wide diagram shows its placeholder there.
# Enter opens the same renderer full width, where more of them fit.
[opener]
markdown = [
  {{ run = 'spechub-md "$@"', block = true, desc = "Read (spechub-md)" }},
  {{ run = '${{EDITOR:-vi}} "$@"', block = true, desc = "Edit" }},
]

[[open.prepend_rules]]
url = "*.md"
use = "markdown"

[[open.prepend_rules]]
url = "*.markdown"
use = "markdown"

[mgr]
show_hidden = {hidden}
{end}"""
text = text.rstrip("\n")
open(path, "w").write((text + "\n\n" if text else "") + block + "\n")
PY
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
  # A dev VM reached over SSH has no display and no clipboard of its own, so
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
tw = (yaml.safe_load(open(src)) or {}).get("gh_dash", {}) if os.path.isfile(src) else {}
cfg = yaml.safe_load(open(dst)) or {} if os.path.isfile(dst) else {}
if tw.get("sections"):
    cfg["prSections"] = [{"title": s["title"], "filters": s["filters"]} for s in tw["sections"]]
if tw.get("repo_paths"):
    cfg["repoPaths"] = tw["repo_paths"]
kb = tw.get("keybindings", {}) or {}
MANAGED = ("tree diff", "agent review", "open in browser")
prs = [k for k in (cfg.get("keybindings", {}) or {}).get("prs", [])
       if k.get("name") not in MANAGED]
if kb.get("tree_diff"):
    prs.append({"key": kb["tree_diff"], "name": "tree diff",
                "command": "gh pr diff {{.PrNumber}} --repo {{.RepoName}} | diffnav\n"})
if kb.get("agent_review"):
    prs.append({"key": kb["agent_review"], "name": "agent review",
                "command": 'cd {{.RepoPath}} && claude "/code-review {{.PrNumber}}"\n'})
kbs = cfg.setdefault("keybindings", {})
# o built into gh-dash opens through $BROWSER, whose output it discards. That
# is enough for a machine with a desktop and nothing at all for one without,
# where the only way to reach a browser is to hand the terminal a link. Take
# the key so spechub-open gets a terminal to draw on. GH_HOST covers GitHub
# Enterprise, whose URLs are the same shape on a different host.
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
    for t in herdr delta diffnav tuicr yazi glow mermaid-ascii gh; do
      case "$t" in
        gh) k=gh_dash ;; glow|mermaid-ascii) k=markdown ;; *) k="$t" ;;
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
      diffnav|gh_dash|tuicr)
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
    # By prefix, which is why helpers are named spechub-*: anything this
    # script ever wrote goes, including helpers retired in an older version.
    herdr plugin unlink spechub.herdr-numbers >/dev/null 2>&1 || true
    rm -rf "$HOME/.config/spechub/herdr-numbers"
    rm -f "$BIN"/spechub-*
    # The xclip stand-in is the one managed file without the prefix.
    grep -q "Installed by spechub" "$BIN/xclip" 2>/dev/null && rm -f "$BIN/xclip"
    SPECHUB_ARGS="$BEGIN|$END" py "$HOME/.config/tuicr/config.toml" <<'PY'
import os, re, sys
p = sys.argv[1]
b, e = os.environ["SPECHUB_ARGS"].split("|")
if os.path.isfile(p):
    t = open(p).read()
    open(p, "w").write(re.sub(re.escape(b) + r".*?" + re.escape(e) + r"\n?", "", t, flags=re.S))
PY
    say "managed config and helpers removed. binaries left in place"
    ;;
  *) echo "usage: setup.sh [status|apply|disable <component>|uninstall]"; exit 1 ;;
esac
