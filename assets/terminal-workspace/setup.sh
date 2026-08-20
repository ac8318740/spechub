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
  rm -f "$BIN"/spechub-files "$BIN"/spechub-files-tab "$BIN"/spechub-open \
        "$BIN"/spechub-yazi-tab
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
    """The order the sidebar draws: every repo's rows contiguous, each group
    anchored where its first member sits, stored order within a group."""
    groups, anchors = {}, {}
    for position, space in enumerate(spaces):
        root = (space.get("worktree") or {}).get("repo_root") or space["workspace_id"]
        groups.setdefault(root, []).append(space["workspace_id"])
        anchors.setdefault(root, position)
    order = []
    for root in sorted(groups, key=lambda key: anchors[key]):
        order.extend(groups[root])
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

  say "helpers written: spechub-diff, spechub-dash, spechub-md"
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
        # Jump to a workspace or tab by number. herdr leaves switch_workspace
        # unbound by default and puts switch_tab on prefix+1..9, so without
        # this there is no way to reach a workspace by number at all.
        'switch_workspace = "prefix+1..9"',
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
kbs = cfg.setdefault("keybindings", {})
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
    rm -f "$BIN"/spechub-*
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
