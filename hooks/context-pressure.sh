#!/usr/bin/env bash
# SpecHub context-pressure nudge (Stop / SessionStart hook).
#
# Measures how much context the session has consumed and, past a threshold,
# blocks the stop with a short message telling the agent to consider handing
# the work over before context runs out.
#
# Contract: JSON payload on stdin, JSON (or nothing) on stdout, nothing on
# stderr, ALWAYS exit 0. A hook that errors or writes junk to stdout breaks the
# stop, so every failure path here is a silent no-op.
#
# Two events, and only two:
#
#   Stop          the session itself finished a turn - the only event that can
#                 produce a nudge.
#   SessionStart  used solely to reset this session's ladder state when the
#                 source is "compact"; it never emits anything.
#
#   A SubagentStop, should one ever arrive, is a silent no-op that creates no
#   state. Neither a plain subagent nor an in-process teammate can hand the
#   user's work over, so nudging one just wastes a turn - which is why the hook
#   is not registered for that event at all.
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
# The threshold ladder:
#
#   The hook fires at most once per rung per session, so a long session gets a
#   nudge when it crosses each rung rather than on every single stop.
#
#   The default rungs are workflow.handoff.nudge_warn and nudge_severe from
#   spechub/project.yaml (defaulting to 200000 / 500000), and then one rung
#   every workflow.handoff.nudge_step tokens (default 100000) above the last
#   one. Setting workflow.handoff.context_thresholds replaces the default rungs
#   entirely with the listed ones - written either block style (one "- item"
#   per line) or flow style ("[a, b]") - while nudge_step still extends the
#   ladder past the last listed rung. A listed rung is either a token count or
#   a percentage string such as "40%", which resolves against
#   workflow.handoff.context_window when that is set. With no context_window
#   configured, the window is inferred from the model id on the transcript
#   record: an id carrying the [1m] marker means 1,000,000; the haiku line and
#   the 4.x families (claude-opus-4-8, claude-haiku-4-5-..., claude-sonnet-4-5)
#   mean 200,000; anything else - the 5.x families, or no model id at all -
#   means 1,000,000. With an explicit ladder, nudge_severe no longer places a
#   rung: it only chooses the wording, which reads as severe once the rung that
#   fired is at or above it.
#
#   The hook fires when the highest rung at or below the current token count is
#   higher than the rung it last fired for this session, and then records that
#   rung.
#
# Per-session state:
#
#   State lives in SPECHUB_CONTEXT_PRESSURE_DIR, defaulting to a
#   spechub-context-pressure directory under TMPDIR (or /tmp), created when it
#   is missing. The session key is the payload's session_id, falling back to the
#   transcript's basename without its .jsonl suffix. Two files per key:
#
#     <key>.last   the rung this hook last fired, written only by this hook.
#                  Absent or unreadable means nothing has fired yet.
#     <key>.quiet  a marker the handoff and compact-and-continue skills leave
#                  behind once they finish. The hook only ever reads it: while
#                  it exists the hook stays silent for the rest of the session
#                  and leaves <key>.last untouched, because the work has already
#                  been handed over and there is nothing left to nudge about.
#
#   A state directory that cannot be created or written stays a silent no-op:
#   a nudge the hook cannot remember firing would repeat on every stop.
#
#   Both files are deleted when the session compacts. A compaction throws the
#   session's context away and rebuilds it much smaller, so the rung the hook
#   last fired describes context that no longer exists, and the quiet marker
#   records a handover the fresh context knows nothing about. The ladder
#   therefore starts over from the bottom after every compaction.
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

# Resolve the state directory here so python only has to read one variable.
SPECHUB_CONTEXT_PRESSURE_DIR="${SPECHUB_CONTEXT_PRESSURE_DIR:-${TMPDIR:-/tmp}/spechub-context-pressure}"
export SPECHUB_CONTEXT_PRESSURE_DIR

# stderr goes nowhere: a hook that writes to stderr is noise at best, and a
# traceback from an unforeseen payload must never reach the user. Every failure
# path inside is already a silent no-op; this is the backstop.
python3 2>/dev/null <<'PY'
import json, math, os, re, sys

DEFAULT_WARN = 200000
DEFAULT_SEVERE = 500000
DEFAULT_STEP = 100000

# What a percentage rung resolves against when project.yaml names no
# context_window. The model id on the transcript record is the only clue
# available: see window_for_model below for the rule these feed.
WINDOW_1M = 1000000
WINDOW_SMALL = 200000
WINDOW_DEFAULT = 1000000

# Model ids whose window is 200k unless the [1m] marker says otherwise: the
# haiku line, and the 4.x families (claude-opus-4-8, claude-sonnet-4-5, and so
# on). Anything else - the 5.x families, or no model id at all - takes the
# 1,000,000 default.
SMALL_WINDOW_MODEL = re.compile(r"haiku|-4-\d|-4\b")

# The agency clause is the load-bearing instruction, and it is identical
# across tiers: handing over or carrying on is the agent's own call, and the
# question tool is for the case where it genuinely cannot tell. Only the head
# above it differs, and only in how hard it leans towards handing over - so a
# severe nudge never halts an unattended run that the agent could have
# resolved itself.
AGENCY = (
    "The call is yours. If you have a strong view either way, act on it "
    "without asking. Either hand over, or say in one line what you found "
    "and carry on. Ask the user with the host's question tool if you don't "
    "know if handing off or continuing in this session would be better."
)

# The standing-agreement clause settles the one case the agent cannot read
# off its own context: a handoff the user already agreed to, which needs no
# second ask.
STANDING_AGREEMENT = (
    "If you are partway through a long run of tasks and the user already "
    "agreed to a handoff earlier in this session, including in a handoff "
    "or compaction summary you resumed from, hand over without asking."
)

# Shared tail appended after each tier's head: the agency clause, the
# standing agreement, and what to do when an answer does come back. Both
# tiers render the same tail, so a future edit to any of it cannot drift
# between warn and severe.
DECIDE_TAIL = (
    AGENCY
    + " " + STANDING_AGREEMENT
    + " If you do ask and the user would rather keep going, drop it for now"
    + " and raise the handoff again once the current run of work wraps up."
)


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


# --- state directory and session key ---------------------------------------

state_dir = os.environ.get("SPECHUB_CONTEXT_PRESSURE_DIR", "").strip()
if not state_dir:
    bail()


def key_part(value):
    """One component of the state key, safe to paste into a file name.

    Returns "" when nothing was supplied, and None when something was supplied
    that cannot name a file: a NUL byte, or a name that sanitises away to
    nothing. None is not a fallback case - a key the filesystem would reject
    means the hook could never record what it fired, so the caller gives up
    quietly rather than nudge on every stop from then on."""
    if not isinstance(value, str) or not value.strip():
        return ""
    if "\x00" in value:
        return None
    value = value.strip()
    # The host chooses these strings, so nothing may walk out of the state
    # directory: the key stays a single path component.
    for separator in ("/", "\\", os.sep, os.altsep or "/"):
        value = value.replace(separator, "_")
    value = os.path.basename(value)
    if not value or value in (".", ".."):
        return None
    return value


def transcript_key(path):
    """The fallback key: the transcript's basename without its .jsonl suffix."""
    if not isinstance(path, str) or not path:
        return ""
    basename = os.path.basename(path)
    if basename.endswith(".jsonl"):
        basename = basename[: -len(".jsonl")]
    return key_part(basename)


def session_key_for(path):
    """This session's state key, or None when nothing usable names a file."""
    key = key_part(data.get("session_id"))
    if key is None:
        return None
    if not key:
        key = transcript_key(path)
    return key or None


# --- events that never nudge -----------------------------------------------

# A subagent or an in-process teammate cannot hand the user's work over, so
# nudging one would only waste a turn. The hook is not registered for this
# event; should a payload arrive anyway it is a silent no-op that creates no
# state - in particular it never spends a rung on the session's own ladder.
if data.get("hook_event_name") == "SubagentStop":
    bail()

# A compaction throws this session's context away and rebuilds it much
# smaller, so the rung the hook last fired and the quiet marker a handover
# left behind no longer describe anything: delete both and start the ladder
# over. The hook stays silent on this event whatever happens - SessionStart
# output reaches the model as extra context, which is exactly what the
# compaction just cleared - and every other source leaves the state alone.
if data.get("hook_event_name") == "SessionStart":
    if data.get("source") == "compact":
        reset_key = session_key_for(data.get("transcript_path"))
        if reset_key:
            for suffix in (".last", ".quiet"):
                try:
                    os.remove(os.path.join(state_dir, reset_key + suffix))
                except Exception:
                    # Absent, unwritable, or a name the filesystem rejects:
                    # there is nothing to say about any of them.
                    pass
    bail()


# --- which transcript? -----------------------------------------------------

transcript = data.get("transcript_path")
if not isinstance(transcript, str) or not transcript:
    bail()


# --- measure ---------------------------------------------------------------

def measure(path):
    """Context size and model id from the last qualifying assistant record.

    Returns (tokens, model), or (None, None) when the transcript holds no
    qualifying record. The model id is whatever that record reported, and is
    None when it reported none."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None, None

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
        model = message.get("model")
        if not isinstance(model, str):
            model = None
        return total, model
    return None, None


tokens, model_id = measure(transcript)
if tokens is None:
    bail()


# --- configuration ---------------------------------------------------------

def flow_list(value):
    """Split a flow-style YAML list ("[a, b]") into its raw item strings."""
    inner = value.strip()
    if inner.startswith("["):
        inner = inner[1:]
    if inner.endswith("]"):
        inner = inner[:-1]
    items = []
    for part in inner.split(","):
        part = part.strip().strip('"\'')
        if part:
            items.append(part)
    return items


def read_config():
    """Read the workflow.handoff keys this hook understands from project.yaml.

    Hand-rolled because pyyaml is not guaranteed to be installed. Walks
    indentation to find the workflow: -> handoff: block and reads scalars from
    it, plus the block-style items under context_thresholds. Anything
    unexpected is left as None so the caller falls back to its defaults."""
    cfg = {
        "nudge_warn": None,
        "nudge_severe": None,
        "nudge_step": None,
        "context_window": None,
        "context_thresholds": None,
    }
    try:
        with open(os.path.join("spechub", "project.yaml"), encoding="utf-8", errors="replace") as f:
            lines = f.read().split("\n")
    except OSError:
        return cfg

    stack = []  # (indent, key) for the enclosing mappings
    # Indent of the context_thresholds key while its block-style items ("- x"
    # on their own lines) are being collected; None when not collecting.
    collecting = None
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        stripped = raw.lstrip(" ")
        indent = len(raw) - len(stripped)

        if collecting is not None:
            if stripped.startswith("- ") and indent >= collecting:
                item = stripped[2:].split("#", 1)[0].strip().strip('"\'')
                if item:
                    cfg["context_thresholds"].append(item)
                continue
            collecting = None

        if stripped.startswith("- ") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip().strip('"\'')
        value = value.split("#", 1)[0].strip().strip('"\'')

        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = [k for _, k in stack] + [key]

        if not value:
            stack.append((indent, key))
            if path == ["workflow", "handoff", "context_thresholds"]:
                cfg["context_thresholds"] = []
                collecting = indent
            continue

        if path[:2] != ["workflow", "handoff"] or len(path) != 3:
            continue
        if key == "context_thresholds":
            cfg["context_thresholds"] = flow_list(value)
        elif key in ("nudge_warn", "nudge_severe", "nudge_step", "context_window"):
            try:
                cfg[key] = int(value)
            except ValueError:
                pass
    return cfg


cfg = read_config()

warn_at = cfg["nudge_warn"] if cfg["nudge_warn"] is not None else DEFAULT_WARN
severe_at = cfg["nudge_severe"] if cfg["nudge_severe"] is not None else DEFAULT_SEVERE
step = cfg["nudge_step"] if cfg["nudge_step"] is not None else DEFAULT_STEP

# Floor both at 1 (a configured 0 would block every single turn), and never
# let severe sit below warn (severe < warn would create a dead zone where the
# severe nudge never fires, since the severe check only runs once tokens have
# already cleared warn).
warn_at = max(warn_at, 1)
severe_at = max(severe_at, warn_at)
# A step of 0 or less would either loop forever or place a rung on top of the
# last one, so it means "do not extend the ladder past the last rung".
if step < 1:
    step = None


# --- the ladder ------------------------------------------------------------

def window_for_model(model):
    """The context window a model id implies.

    The [1m] marker wins outright: a model running the million-token window
    says so in its id. Otherwise the haiku line and the 4.x families run
    200,000, and everything else - the 5.x families, or no model id at all -
    takes the 1,000,000 default."""
    if not model:
        return WINDOW_DEFAULT
    if "[1m]" in model:
        return WINDOW_1M
    if SMALL_WINDOW_MODEL.search(model.lower()):
        return WINDOW_SMALL
    return WINDOW_DEFAULT


def context_window():
    """What a percentage rung is a percentage of."""
    if cfg["context_window"] is not None and cfg["context_window"] > 0:
        return cfg["context_window"]
    return window_for_model(model_id)


def resolve_rung(item):
    """One configured rung as a token count, or None when it is unreadable."""
    item = str(item).strip().strip('"\'')
    if item.endswith("%"):
        try:
            percent = float(item[:-1])
        except ValueError:
            return None
        return int(round(context_window() * percent / 100.0))
    try:
        return int(item)
    except ValueError:
        return None


listed = cfg["context_thresholds"]
rungs = []
if listed:
    for item in listed:
        resolved = resolve_rung(item)
        if resolved is not None and resolved >= 1:
            rungs.append(resolved)
if not rungs:
    # No usable list: the warn and severe marks are the ladder's own rungs.
    rungs = [warn_at, severe_at]
rungs = sorted(set(rungs))


def highest_rung(count):
    """The highest rung at or below count, or None when count clears none.

    Above the last listed rung the ladder carries on in nudge_step strides, so
    a session that keeps growing keeps getting nudged."""
    top = rungs[-1]
    if count >= top:
        if step is None:
            return top
        return top + ((count - top) // step) * step
    below = [rung for rung in rungs if rung <= count]
    return below[-1] if below else None


rung = highest_rung(tokens)
if rung is None:
    bail()


# --- per-session ladder state ----------------------------------------------

session_key = session_key_for(transcript)
if not session_key:
    bail()

# The handoff and compact-and-continue skills leave this marker behind when
# they finish. The work is already handed over, so there is nothing to nudge
# about for the rest of the session - and .last stays as it was.
try:
    handed_over = os.path.exists(os.path.join(state_dir, session_key + ".quiet"))
except Exception:
    # A key the filesystem will not even be asked about: stay silent.
    bail()
if handed_over:
    bail()

last_file = os.path.join(state_dir, session_key + ".last")
try:
    with open(last_file, encoding="utf-8", errors="replace") as f:
        last_rung = int(f.read().strip())
except Exception:
    # No record, or a record this hook cannot read: nothing has fired yet.
    last_rung = None

if last_rung is not None and rung <= last_rung:
    bail()

# Record the rung BEFORE speaking. A nudge the hook cannot remember firing
# would repeat on every stop, which is the thing this ladder exists to stop.
try:
    os.makedirs(state_dir, exist_ok=True)
    with open(last_file, "w", encoding="utf-8") as f:
        f.write("{}\n".format(rung))
except Exception:
    # Unwritable, or a key the filesystem rejects: stay silent rather than
    # nudge without a record, and never let a traceback reach stderr.
    bail()


# --- the nudge -------------------------------------------------------------

# Inside herdr the handoff skill can open a fresh session; outside it, staying
# in this session across a compaction is the only option available.
if os.environ.get("HERDR_ENV") == "1":
    route = "the handoff skill"
else:
    route = "the compact-and-continue skill"

used = "{:,}".format(tokens)
limit = "{:,}".format(rung)

if rung >= severe_at:
    head = (
        "Context check (urgent): this session has used about {used} tokens, "
        "past the {limit} severe mark, so it is close to the wall. Handing "
        "the work over with {route} is usually right this late, and starting "
        "something new rarely is. Finishing what you are already on can be "
        "the better call though: wrap it up and there may be nothing left "
        "worth handing over. If you do put it to the user, say plainly that "
        "context is nearly gone so they can decide quickly."
    ).format(used=used, limit=limit, route=route)
else:
    head = (
        "Context check: this session has used about {used} tokens, past the "
        "{limit} mark. Decide whether now is a good moment to hand the work "
        "over with {route}."
    ).format(used=used, limit=limit, route=route)

reason = head + " " + DECIDE_TAIL

print(json.dumps({"decision": "block", "reason": reason}))
PY

exit 0
