#!/usr/bin/env bash
# SpecHub context-pressure nudge (Stop / SubagentStop hook).
#
# Measures how much context the session has consumed and, past a threshold,
# blocks the stop with a short message telling the agent to consider handing
# the work over before context runs out.
#
# Contract: JSON payload on stdin, JSON (or nothing) on stdout, ALWAYS exit 0.
# A hook that errors or writes junk to stdout breaks the stop, so every failure
# path here is a silent no-op.
#
# How the measurement works:
#
#   The transcript is JSONL. Each assistant record carries message.usage, whose
#   input_tokens + cache_read_input_tokens + cache_creation_input_tokens is the
#   context that turn actually sent to the model. cache_read already contains
#   the whole prior conversation, so the LAST such record is the current
#   context size - summing across records would multiply-count it.
#
#   Records with isSidechain true belong to a subagent running under this
#   session, not to this session's own context, so they are skipped. Malformed
#   lines are skipped rather than fatal; transcripts are appended live and the
#   tail can be a partial write.
#
# On SubagentStop the payload's agent_transcript_path is used, but only
# in-process teammates are nudged: a plain subagent cannot hand anything over,
# and blocking its stop just wastes a turn. The discriminator is taskKind in
# the sibling <transcript>.meta.json - NOT agent_type, which holds a teammate's
# own name and is therefore attacker-chosen from this hook's point of view.
#
# Thresholds come from workflow.handoff.nudge_warn / nudge_severe in
# spechub/project.yaml, defaulting to 200000 / 500000.
#
# Output is deliberately flat {"decision": "block", "reason": ...}: it is the
# one Stop-hook shape whose text reliably reaches the model across harnesses.
# hookSpecificOutput/additionalContext are SessionStart-shaped and are dropped
# here; systemMessage reaches only the user.

set -u

command -v python3 >/dev/null 2>&1 || exit 0

# Capture the hook payload from stdin before running python. The heredoc below
# becomes python's stdin (the program source), so the payload must travel via an
# env var, not sys.stdin.
SPECHUB_HOOK_INPUT="$(cat)"
export SPECHUB_HOOK_INPUT

python3 <<'PY'
import json, math, os, sys

DEFAULT_WARN = 200000
DEFAULT_SEVERE = 500000

# The ~40-word escape hatch is identical across tiers: the load-bearing
# instruction most likely to be tuned, kept in one place so warn and severe
# can never drift into authorising different behaviour.
ESCAPE_HATCH = (
    "Go ahead without asking only if you feel strongly it is right, or if "
    "you are partway through a long run of tasks and the user already "
    "agreed to a handoff earlier in this session, including in a handoff "
    "or compaction summary you resumed from."
)

# Shared tail appended after each tier's head: the escape hatch, plus the
# fallback instruction for when neither exception applies. Both tiers render
# the same tail so a future edit to either sentence cannot drift between
# warn and severe.
ASK_TAIL = ESCAPE_HATCH + " If neither holds, say what you found and carry on."


def bail():
    """Every failure path is a silent, successful no-op."""
    sys.exit(0)


try:
    data = json.loads(os.environ.get("SPECHUB_HOOK_INPUT", ""))
except Exception:
    bail()

if not isinstance(data, dict):
    bail()

# Our own injection caused this stop; nudging again would loop. The value is
# usually the JSON boolean true, but some hosts round-trip it through a
# string - treat any case-insensitive "true" the same way. Plain truthiness
# is wrong here: the string "false" is truthy.
_stop_hook_active = data.get("stop_hook_active")
if _stop_hook_active is True or (
    isinstance(_stop_hook_active, str)
    and _stop_hook_active.strip().lower() == "true"
):
    bail()


# --- which transcript, and are we allowed to nudge about it? ---------------

def teammate_transcript(path):
    """For a SubagentStop, return path only when the agent is an in-process
    teammate. The sibling meta file names the kind; anything else (an ordinary
    subagent, a missing or unreadable meta file) is not nudgeable."""
    if not path.endswith(".jsonl"):
        return None
    meta_path = path[: -len(".jsonl")] + ".meta.json"
    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return None
    if not isinstance(meta, dict):
        return None
    return path if meta.get("taskKind") == "in_process_teammate" else None


if data.get("hook_event_name") == "SubagentStop":
    raw_path = data.get("agent_transcript_path")
    if not isinstance(raw_path, str) or not raw_path:
        bail()
    transcript = teammate_transcript(raw_path)
    if transcript is None:
        bail()
else:
    transcript = data.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        bail()


# --- measure ---------------------------------------------------------------

def measure(path):
    """Context size from the last qualifying assistant record, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None

    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get("type") != "assistant":
            continue
        if rec.get("isSidechain") is True:
            continue
        message = rec.get("message")
        if not isinstance(message, dict):
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        total = 0
        for key in ("input_tokens", "cache_read_input_tokens",
                    "cache_creation_input_tokens"):
            value = usage.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                value = 0
            elif isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                # json.loads accepts bare NaN/Infinity, and a huge exponent
                # like 1e400 parses to inf. Both pass the float check above
                # and then int() raises - coerce to 0 instead of crashing.
                value = 0
            total += int(value)
        return total
    return None


tokens = measure(transcript)
if tokens is None:
    bail()


# --- thresholds ------------------------------------------------------------

def thresholds():
    """Read workflow.handoff.nudge_warn / nudge_severe from project.yaml.

    Hand-rolled because pyyaml is not guaranteed to be installed. Walks
    indentation to find the workflow: -> handoff: block and reads integer
    scalars from it. Anything unexpected falls back to the defaults."""
    warn, severe = DEFAULT_WARN, DEFAULT_SEVERE
    try:
        with open(os.path.join("spechub", "project.yaml"), encoding="utf-8", errors="replace") as f:
            lines = f.read().split("\n")
    except OSError:
        return warn, severe

    stack = []  # (indent, key) for the enclosing mappings
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        stripped = raw.lstrip(" ")
        if stripped.startswith("- ") or ":" not in stripped:
            continue
        indent = len(raw) - len(stripped)
        key, _, value = stripped.partition(":")
        key = key.strip().strip('"\'')
        value = value.split("#", 1)[0].strip().strip('"\'')

        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = [k for _, k in stack] + [key]

        if not value:
            stack.append((indent, key))
            continue

        if path == ["workflow", "handoff", "nudge_warn"]:
            try:
                warn = int(value)
            except ValueError:
                pass
        elif path == ["workflow", "handoff", "nudge_severe"]:
            try:
                severe = int(value)
            except ValueError:
                pass
    return warn, severe


warn_at, severe_at = thresholds()

# Floor both at 1 (a configured 0 would block every single turn), and never
# let severe sit below warn (severe < warn would create a dead zone where the
# severe nudge never fires, since the severe check only runs once tokens have
# already cleared warn).
warn_at = max(warn_at, 1)
severe_at = max(severe_at, warn_at)

if tokens < warn_at:
    bail()


# --- the nudge -------------------------------------------------------------

# Inside herdr the handoff skill can open a fresh session; outside it, staying
# in this session across a compaction is the only option available.
if os.environ.get("HERDR_ENV") == "1":
    route = "the handoff skill"
else:
    route = "the compact-and-continue skill"

used = "{:,}".format(tokens)

if tokens >= severe_at:
    limit = "{:,}".format(severe_at)
    head = (
        "Context check (urgent): this session has used about {used} tokens, "
        "past the {limit} severe mark, so it is close to the wall. Finish the "
        "step you are on, then hand the work over with {route} instead of "
        "starting anything new. Ask the user first, using the host's question "
        "tool, and say plainly that context is nearly gone so they can decide "
        "quickly."
    ).format(used=used, limit=limit, route=route)
else:
    limit = "{:,}".format(warn_at)
    head = (
        "Context check: this session has used about {used} tokens, past the "
        "{limit} mark. Think about whether now is a good moment to hand the "
        "work over with {route}. Do not decide that alone: ask the user with "
        "the host's question tool and let them choose."
    ).format(used=used, limit=limit, route=route)

reason = head + " " + ASK_TAIL

print(json.dumps({"decision": "block", "reason": reason}))
PY

exit 0
