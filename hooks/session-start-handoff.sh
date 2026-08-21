#!/usr/bin/env bash
# SpecHub handoff reload (consume-once, change-aware).
#
# When a session resumes after compaction (SessionStart source == "compact"),
# re-inject the handoff anchor written by /spechub:handoff, then retire it so it
# can never be injected twice.
#
# The compaction summary carries the conversation narrative; this anchor carries
# the load-bearing state the summary may have compressed away (next action, task
# ledger, agent-team file ownership, blockers).
#
# Active (pending) handoff lives at the fixed path spechub/HANDOFF.md, so this
# hook reads one known file with no CLI call. The file's frontmatter records the
# change it belongs to. On consume, the file is MOVED into that change's own
# folder, accumulating a per-change history:
#
#   spechub/changes/<change>/handoffs/<timestamp>.md   (when the change dir exists)
#   spechub/handoffs/<change>/<timestamp>.md           (ad-hoc, or change archived)
#
# Storing consumed handoffs inside the change dir means they travel with the
# change when /spechub:archive moves it. Names are timestamped with a numeric
# collision suffix (-2, -3, ...) so many handoffs accumulate without overwrite.
#
# No-op on a fresh startup, on --resume, on /clear, when no anchor exists, when
# the anchor is empty, or when the file lacks the spechub_handoff marker (so a
# user's own unrelated HANDOFF.md is never touched).
#
# Runs alongside session-start.sh as a second SessionStart hook. Claude Code
# aggregates additionalContext from every matching hook, so this adds to the
# orchestrator instruction injection rather than replacing it.

set -u

command -v python3 >/dev/null 2>&1 || exit 0

# Capture the hook payload from stdin before running python. The heredoc below
# becomes python's stdin (the program source), so the payload must travel via an
# env var, not sys.stdin.
SPECHUB_HOOK_INPUT="$(cat)"
export SPECHUB_HOOK_INPUT

python3 <<'PY'
import json, os, re, shutil, sys

try:
    data = json.loads(os.environ.get("SPECHUB_HOOK_INPUT", ""))
except Exception:
    sys.exit(0)

if data.get("source") != "compact":
    sys.exit(0)

active = os.path.join("spechub", "HANDOFF.md")
try:
    with open(active, encoding="utf-8") as f:
        raw = f.read()
except OSError:
    sys.exit(0)

if not raw.strip():
    sys.exit(0)


def parse_frontmatter(text):
    """Return (meta dict, body) for a simple --- key: value --- header.
    Returns (None, text) when there is no recognizable frontmatter."""
    if not text.startswith("---"):
        return None, text
    lines = text.split("\n")
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return None, text
    meta = {}
    for line in lines[1:end]:
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    return meta, body


meta, body = parse_frontmatter(raw)

# Only consume files this plugin wrote. A bare HANDOFF.md without the marker is
# left untouched.
if not meta or "spechub_handoff" not in meta:
    sys.exit(0)

if not body.strip():
    sys.exit(0)

# "map" is the current key; "change" is accepted for anchors written by
# pre-map versions of the handoff skill. The value feeds os.path.join, so
# sanitize it the same way as the stamp – a name with "/" or ".." must not
# route the archived handoff outside spechub/.
change = meta.get("map") or meta.get("change") or "ad-hoc"
change = re.sub(r"[^A-Za-z0-9._-]", "-", str(change))
if not change.strip("."):
    change = "ad-hoc"
created = meta.get("created") or ""

# Build a filesystem-safe stamp for the archived filename.
stamp = re.sub(r"[^A-Za-z0-9._-]", "-", created) if created else ""
if not stamp:
    from datetime import datetime, timezone
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")

# Route to the change's own folder when that change dir exists, so consumed
# handoffs travel with the change on /spechub:archive. Otherwise fall back to a
# neutral top-level handoffs dir (ad-hoc work, or a change already archived).
change_dir = os.path.join("spechub", "changes", change)
if change != "ad-hoc" and os.path.isdir(change_dir):
    archive_dir = os.path.join(change_dir, "handoffs")
else:
    archive_dir = os.path.join("spechub", "handoffs", change)

# Find a non-colliding destination: <stamp>.md, then <stamp>-2.md, -3.md, ...
dest = None
try:
    os.makedirs(archive_dir, exist_ok=True)
    candidate = os.path.join(archive_dir, stamp + ".md")
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(archive_dir, "{}-{}.md".format(stamp, n))
        n += 1
    dest = candidate
except OSError:
    dest = None

# Consume: move the active handoff into the archive. Best-effort - even if the
# move fails, we still inject below so the resume is not lost.
if dest:
    try:
        shutil.move(active, dest)
    except OSError:
        pass

preamble = (
    "The session was just compacted. The following SpecHub handoff captures "
    "load-bearing work state the summary may have compressed. Treat it as "
    "authoritative for what to do next.\n\n"
    "Resume now: when the user's next message is \"continue\" (or any short "
    "nudge), pick up the work immediately from the Next action below - do not "
    "wait for further instruction. If anything in this handoff or the "
    "compaction summary is ambiguous or underspecified, use the AskUserQuestion "
    "tool to resolve it before acting rather than guessing. Ask liberally: a "
    "wrong assumption taken after compaction is expensive to unwind.\n\n"
)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": preamble + body,
    }
}))
PY

exit 0
