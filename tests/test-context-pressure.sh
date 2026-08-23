#!/usr/bin/env bash
# Local test harness for context-pressure.sh (Stop / SessionStart hook).
#
# Simulates exactly what Claude Code sends the hook (a JSON payload on stdin)
# and asserts the hook's behavior end-to-end: the stop_hook_active
# short-circuit, transcript discovery, the "last qualifying assistant record
# wins" scan rule (with sidechain skipping and malformed-line tolerance),
# threshold defaults and project.yaml overrides, the required flat JSON output
# shape, the HERDR_ENV-conditional wording, and the always-exit-0 contract.
#
# Only a session's own Stop is ever nudged. A SubagentStop is a silent no-op
# whatever it carries: neither a plain subagent nor an in-process teammate can
# hand the user's work over, so nudging one just wastes a turn, and the hook
# must not even record ladder state for it.
#
# It also covers the threshold ladder: the hook fires at most once per rung per
# session, remembering the last rung it fired in a per-session state file under
# SPECHUB_CONTEXT_PRESSURE_DIR. That covers the default rungs (warn, severe,
# then every nudge_step above severe), an explicit context_thresholds ladder in
# project.yaml (block and flow style, absolute and percentage rungs), the
# context window a percentage resolves against, and the .quiet silence marker
# a handoff or compaction leaves behind.
#
# Compaction resets that state: a SessionStart whose source is "compact" means
# the session's context was just thrown away and rebuilt, so the rung it last
# fired and the quiet marker no longer describe anything. The hook deletes both
# for that session and says nothing at all.
#
# Exercises the hook's payload handling, context-usage measurement, threshold
# logic, per-session ladder state, compaction reset, and output contract
# described above.
#
# Run it:  bash tests/test-context-pressure.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/../hooks/context-pressure.sh"
HOOKS_JSON="${SCRIPT_DIR}/../hooks/hooks.json"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

echo "Testing: $HOOK"
echo "Workdir: $WORK"
echo ""

# ---------------------------------------------------------------------------
# Fixture / assertion helpers
# ---------------------------------------------------------------------------

# Enter a fresh, isolated cwd for one case (the hook reads spechub/project.yaml
# relative to cwd, so each case gets its own directory to avoid bleed).
enter_case() {
  CASE_DIR="$WORK/case_$1"
  mkdir -p "$CASE_DIR"
  cd "$CASE_DIR" || exit 1
  fresh_state_dir
}

# --- ladder state isolation -------------------------------------------------
# The hook keeps per-session ladder state (the last threshold rung it fired) in
# SPECHUB_CONTEXT_PRESSURE_DIR, and fires at most once per rung per session.
# Runs that share a state directory therefore silence each other, so by default
# every run_hook call gets its OWN fresh state directory: each such run stands
# for a first stop in a session that has never been nudged. Cases that exercise
# the ladder itself pin one directory across several runs with use_state_dir.
STATE_DIR=""
STATE_SEQ=0

# Every hook run must leave stderr empty: a Stop hook that chatters on stderr
# is noise in the user's session at best. run_hook counts the runs that broke
# that, and the last case asserts the count is zero.
STDERR_DIRTY=0
STDERR_DIRTY_LAST=""

# Pin the state directory shared by the runs that follow. Deliberately does NOT
# create it: creating it when missing is the hook's job.
use_state_dir() { STATE_DIR="$1"; }

# Back to a private state directory per run.
fresh_state_dir() { STATE_DIR=""; }

# Print the rung recorded for a session, or nothing when no record exists.
# $1 = state directory, $2 = session key.
last_rung() {
  local file="$1/$2.last"
  [ -f "$file" ] || return 0
  tr -d ' \t\r\n' < "$file"
}

# Print every ladder-state file in a state directory, one per line, so a case
# can assert that a run recorded NOTHING without having to guess the key the
# hook would have used. Prints nothing when the directory was never created.
# $1 = state directory.
state_last_files() {
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -name '*.last' 2>/dev/null
}

# One assistant transcript record carrying a usage total.
# $1 = total tokens (placed entirely in input_tokens; the other two usage
#      fields are set to 0 so the sum still equals $1).
# $2 = isSidechain (true/false, default false)
usage_line() {
  local total="$1" sidechain="${2:-false}"
  printf '{"type":"assistant","isSidechain":%s,"message":{"usage":{"input_tokens":%s,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}' "$sidechain" "$total"
}

# Same, but the record also carries message.model -- the field the hook reads
# to work out the context window when project.yaml does not set one.
# $1 = total tokens, $2 = model id, $3 = isSidechain (default false)
usage_line_model() {
  local total="$1" model="$2" sidechain="${3:-false}"
  printf '{"type":"assistant","isSidechain":%s,"message":{"model":"%s","usage":{"input_tokens":%s,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}' "$sidechain" "$model" "$total"
}

user_line()      { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}'; }
tool_line()      { printf '{"type":"tool_use","name":"Bash","input":{"command":"echo hi"}}'; }
malformed_line() { printf 'not valid json {{{ this is garbage'; }
# An assistant record with no usage at all -- must not count as "qualifying".
no_usage_line()  { printf '{"type":"assistant","isSidechain":false,"message":{"stop_reason":"end_turn"}}'; }

# Write a JSONL transcript. $1 = file path, remaining args = one line each.
mk_transcript() {
  local file="$1"; shift
  : > "$file"
  local line
  for line in "$@"; do
    printf '%s\n' "$line" >> "$file"
  done
}

# Rewrite a transcript so its last qualifying record reports $2 tokens.
# $1 = transcript path, $2 = total tokens, $3 = model id (optional).
set_tokens() {
  local file="$1" total="$2" model="${3:-}"
  if [ -n "$model" ]; then
    mk_transcript "$file" "$(user_line)" "$(usage_line_model "$total" "$model")"
  else
    mk_transcript "$file" "$(user_line)" "$(usage_line "$total")"
  fi
}

# One stop in an ongoing session: rewrite $T to report $1 tokens, then run the
# hook against it as session $SID. $T and $SID are set by the calling case, and
# the case pins a state directory so the ladder state carries across steps.
ladder_step() {
  set_tokens "$T" "$1" "${2:-}"
  run_hook "$(stop_payload_session "$T" "$SID")" -u HERDR_ENV
}

# Write spechub/project.yaml (relative to cwd) from stdin, for the cases whose
# config is richer than mk_config's two thresholds.
mk_config_raw() {
  mkdir -p spechub
  cat > spechub/project.yaml
}

# Write spechub/project.yaml (relative to cwd) with threshold overrides.
mk_config() {
  local warn="$1" severe="$2"
  mkdir -p spechub
  cat > spechub/project.yaml <<EOF
workflow:
  handoff:
    nudge_warn: $warn
    nudge_severe: $severe
EOF
}

# Build a Stop payload. $1 = transcript path, $2 = stop_hook_active (true/false)
stop_payload() {
  local transcript="$1" active="${2:-false}"
  printf '{"hook_event_name":"Stop","stop_hook_active":%s,"transcript_path":"%s"}' "$active" "$transcript"
}

# Build a Stop payload carrying an explicit session_id -- the key the hook uses
# for per-session ladder state.
# $1 = transcript path, $2 = session_id, $3 = stop_hook_active (default false)
stop_payload_session() {
  local transcript="$1" sid="$2" active="${3:-false}"
  printf '{"hook_event_name":"Stop","stop_hook_active":%s,"session_id":"%s","transcript_path":"%s"}' "$active" "$sid" "$transcript"
}

# Build a SubagentStop payload.
# $1 = agent_transcript_path, $2 = stop_hook_active, $3 = agent_type (a NAME,
# not a discriminator), $4 = agent_id
subagent_payload() {
  local transcript="$1" active="${2:-false}" agent_type="${3:-teammate-a}" agent_id="${4:-agent-1}"
  printf '{"hook_event_name":"SubagentStop","stop_hook_active":%s,"agent_id":"%s","agent_type":"%s","agent_transcript_path":"%s"}' "$active" "$agent_id" "$agent_type" "$transcript"
}

# Build a SubagentStop payload carrying both session_id (the parent session)
# and agent_id (the agent that stopped).
# $1 = agent_transcript_path, $2 = session_id, $3 = agent_id,
# $4 = stop_hook_active (default false), $5 = agent_type (a NAME, default teammate-a)
subagent_payload_session() {
  local transcript="$1" sid="$2" agent_id="$3" active="${4:-false}" agent_type="${5:-teammate-a}"
  printf '{"hook_event_name":"SubagentStop","stop_hook_active":%s,"session_id":"%s","agent_id":"%s","agent_type":"%s","agent_transcript_path":"%s"}' "$active" "$sid" "$agent_id" "$agent_type" "$transcript"
}

# Build a SubagentStop payload carrying BOTH transcript paths, the way the host
# actually sends one: transcript_path names the parent session's transcript and
# agent_transcript_path names the agent's own. Carrying both matters. A hook
# that stops treating SubagentStop as its own case does not go quiet -- it falls
# through to transcript_path and nudges the parent's transcript instead, and a
# payload that left the field out would let that mistake pass for silence.
# $1 = transcript (used for both fields), $2 = session_id, $3 = agent_id
subagent_payload_both() {
  local transcript="$1" sid="$2" agent_id="$3"
  printf '{"hook_event_name":"SubagentStop","stop_hook_active":false,"session_id":"%s","agent_id":"%s","agent_type":"teammate-a","transcript_path":"%s","agent_transcript_path":"%s"}' "$sid" "$agent_id" "$transcript" "$transcript"
}

# Build a SessionStart payload -- the event that tells the hook a session has
# just begun, and why.
# $1 = session_id, $2 = source (startup / resume / clear / compact / fork),
# $3 = transcript path
session_start_payload() {
  local sid="$1" source="$2" transcript="${3:-}"
  printf '{"hook_event_name":"SessionStart","session_id":"%s","source":"%s","transcript_path":"%s"}' "$sid" "$source" "$transcript"
}

# Run the hook. $1 = JSON payload, remaining args = env assignments/flags for
# `env` (e.g. HERDR_ENV=1, or -u HERDR_ENV to unset it). Sets OUT and RC.
#
# SPECHUB_CONTEXT_PRESSURE_DIR is always set, so a test can never touch the
# real state directory under TMPDIR. Unless the case pinned one with
# use_state_dir, each run gets a fresh directory: the hook fires once per
# threshold rung per session, so runs sharing state would otherwise silence
# each other, and no case below means "the same session stopped twice" unless
# it says so by pinning a directory.
run_hook() {
  local payload="$1"; shift
  local dir="$STATE_DIR"
  if [ -z "$dir" ]; then
    STATE_SEQ=$((STATE_SEQ + 1))
    dir="$WORK/state_$STATE_SEQ"
  fi
  OUT="$(printf '%s' "$payload" | env "$@" SPECHUB_CONTEXT_PRESSURE_DIR="$dir" bash "$HOOK" 2>"$WORK/stderr.log")"
  RC=$?
  ERR="$(cat "$WORK/stderr.log" 2>/dev/null)"
  if [ -n "$ERR" ]; then
    STDERR_DIRTY=$((STDERR_DIRTY + 1))
    STDERR_DIRTY_LAST="$ERR"
  fi
}

# True when the most recent run_hook wrote nothing to stderr.
is_stderr_clean() {
  [ -z "$ERR" ]
}

# Stricter than is_silent: a stop that does not fire must write nothing at all
# to stdout.
is_quiet() {
  [ -z "$1" ]
}

# True when the reason text reads as the severe tier rather than the warn tier.
reads_severe() {
  reason_of "$1" | grep -qiE "severe|critical|urgent|immediately"
}

# True (exit 0) when $1 is either empty, or valid JSON without a "decision" key.
is_silent() {
  local out="$1"
  [ -z "$out" ] && return 0
  SPECHUB_TEST_OUT="$out" python3 -c '
import json, os, sys
try:
    d = json.loads(os.environ["SPECHUB_TEST_OUT"])
except Exception:
    sys.exit(1)
sys.exit(0 if "decision" not in d else 1)
' 2>/dev/null
}

# True when $1 is valid JSON shaped {"decision":"block","reason":"..."} with
# none of the forbidden keys present.
is_block_shape() {
  local out="$1"
  [ -z "$out" ] && return 1
  SPECHUB_TEST_OUT="$out" python3 -c '
import json, os
d = json.loads(os.environ["SPECHUB_TEST_OUT"])
assert d.get("decision") == "block"
assert isinstance(d.get("reason"), str) and d["reason"].strip()
for forbidden in ("hookSpecificOutput", "additionalContext", "systemMessage"):
    assert forbidden not in d
' 2>/dev/null
}

# Print the "reason" field of a block-shaped JSON string (empty on failure).
reason_of() {
  local out="$1"
  SPECHUB_TEST_OUT="$out" python3 -c '
import json, os
try:
    d = json.loads(os.environ["SPECHUB_TEST_OUT"])
    print(d.get("reason", ""))
except Exception:
    print("")
' 2>/dev/null
}

# True when $1 is valid JSON (covers "stdout, when non-empty, must be valid JSON").
is_valid_json() {
  local out="$1"
  [ -z "$out" ] && return 0
  SPECHUB_TEST_OUT="$out" python3 -c '
import json, os
json.loads(os.environ["SPECHUB_TEST_OUT"])
' 2>/dev/null
}

# ---------------------------------------------------------------------------
# Case 0: hook script exists and is valid bash
# ---------------------------------------------------------------------------
echo "Case 0: hook script exists and is valid bash"
check "hooks/context-pressure.sh exists"   '[ -f "$HOOK" ]'
check "hooks/context-pressure.sh passes bash -n" 'bash -n "$HOOK" 2>/dev/null'

# ---------------------------------------------------------------------------
# Case 1: hooks.json registers the hook under Stop and SessionStart only
# ---------------------------------------------------------------------------
# SubagentStop is deliberately absent: the hook never nudges a subagent or a
# teammate, so registering it there would only burn a process on every agent
# that finishes.
echo "Case 1: hooks.json registers context-pressure.sh under Stop and SessionStart, not SubagentStop"
HOOKS_JSON_CHECK="$(SPECHUB_HOOKS_JSON="$HOOKS_JSON" python3 -c '
import json, os

path = os.environ["SPECHUB_HOOKS_JSON"]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    print("PARSE_ERROR")
    raise SystemExit

def has_registration(event):
    for entry in data.get("hooks", {}).get(event, []):
        for h in entry.get("hooks", []):
            cmd = h.get("command", "")
            if h.get("type") == "command" and "context-pressure.sh" in cmd and "CLAUDE_PLUGIN_ROOT" in cmd:
                return True
    return False

print("STOP_OK" if has_registration("Stop") else "STOP_MISSING")
print("SESSIONSTART_OK" if has_registration("SessionStart") else "SESSIONSTART_MISSING")
print("SUBAGENT_ABSENT" if not has_registration("SubagentStop") else "SUBAGENT_PRESENT")
' 2>/dev/null)"
check "hooks.json parses as JSON"      '[ "$(printf %s "$HOOKS_JSON_CHECK" | sed -n 1p)" != "PARSE_ERROR" ]'
check "registers command hook under Stop"          'printf %s "$HOOKS_JSON_CHECK" | grep -q STOP_OK'
check "registers command hook under SessionStart"  'printf %s "$HOOKS_JSON_CHECK" | grep -q SESSIONSTART_OK'
check "does NOT register under SubagentStop"       'printf %s "$HOOKS_JSON_CHECK" | grep -q SUBAGENT_ABSENT'

# ---------------------------------------------------------------------------
# Case 2: stop_hook_active short-circuits, even with a huge-usage transcript
# ---------------------------------------------------------------------------
echo "Case 2: stop_hook_active=true short-circuits"
enter_case 2
T="$CASE_DIR/transcript.jsonl"
mk_transcript "$T" "$(user_line)" "$(usage_line 900000)"
run_hook "$(stop_payload "$T" true)"
check "silent output when stop_hook_active is true"  'is_silent "$OUT"'
check "exit code 0"                                  '[ "$RC" -eq 0 ]'

# ---------------------------------------------------------------------------
# Case 3: missing / nonexistent transcript -> silent no-op
# ---------------------------------------------------------------------------
echo "Case 3: missing / nonexistent transcript -> silent no-op"
enter_case 3
run_hook '{"hook_event_name":"Stop","stop_hook_active":false}'
check "silent when transcript_path is absent"  'is_silent "$OUT"'
check "exit code 0 (transcript_path absent)"   '[ "$RC" -eq 0 ]'

run_hook "$(stop_payload "$CASE_DIR/does-not-exist.jsonl" false)"
check "silent when transcript file does not exist"  'is_silent "$OUT"'
check "exit code 0 (transcript file missing)"        '[ "$RC" -eq 0 ]'

# ---------------------------------------------------------------------------
# Case 4: usage below default warn threshold -> silent
# ---------------------------------------------------------------------------
echo "Case 4: usage well below default warn threshold (200000) -> silent"
enter_case 4
T="$CASE_DIR/transcript.jsonl"
mk_transcript "$T" "$(user_line)" "$(usage_line 50000)"
run_hook "$(stop_payload "$T" false)"
check "silent below default warn"  'is_silent "$OUT"'
check "exit code 0"                '[ "$RC" -eq 0 ]'

# ---------------------------------------------------------------------------
# Case 5: usage at warn level (defaults) -> block, warn text, HERDR_ENV wording
# ---------------------------------------------------------------------------
echo "Case 5: usage at warn level (default thresholds) -> block, warn text"
enter_case 5
T="$CASE_DIR/transcript.jsonl"
mk_transcript "$T" "$(user_line)" "$(usage_line 250000)"

run_hook "$(stop_payload "$T" false)" -u HERDR_ENV
RC_WARN_NO_HERDR="$RC"
WARN_OUT="$OUT"
check "exit code 0 (warn, no HERDR_ENV)"     '[ "$RC_WARN_NO_HERDR" -eq 0 ]'
check "stdout is valid JSON"                 'is_valid_json "$WARN_OUT"'
check "block shape, no forbidden keys"       'is_block_shape "$WARN_OUT"'
WARN_REASON_NO_HERDR="$(reason_of "$WARN_OUT")"
check "mentions compact-and-continue without HERDR_ENV"  'printf %s "$WARN_REASON_NO_HERDR" | grep -qi "compact-and-continue"'
check "does not tell the agent to hand off unilaterally, but to ask/confirm"  'printf %s "$WARN_REASON_NO_HERDR" | grep -qiE "ask|confirm"'

run_hook "$(stop_payload "$T" false)" HERDR_ENV=1
RC_WARN_HERDR="$RC"
WARN_OUT_HERDR="$OUT"
check "exit code 0 (warn, HERDR_ENV=1)"      '[ "$RC_WARN_HERDR" -eq 0 ]'
WARN_REASON_HERDR="$(reason_of "$WARN_OUT_HERDR")"
check "mentions handoff with HERDR_ENV=1"    'printf %s "$WARN_REASON_HERDR" | grep -qi "handoff"'

# Summation contract: input_tokens + cache_read_input_tokens + cache_creation_input_tokens
SPLIT_LINE='{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":100000,"cache_read_input_tokens":100000,"cache_creation_input_tokens":50000},"stop_reason":"end_turn"}}'
T_SPLIT="$CASE_DIR/split-usage.jsonl"
mk_transcript "$T_SPLIT" "$(user_line)" "$SPLIT_LINE"
run_hook "$(stop_payload "$T_SPLIT" false)"
check "sums all three usage fields (100k+100k+50k=250k reaches warn)"  'is_block_shape "$OUT"'

# Missing usage fields count as 0, not an error.
MISSING_FIELD_LINE='{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":250000},"stop_reason":"end_turn"}}'
T_MISSING="$CASE_DIR/missing-field-usage.jsonl"
mk_transcript "$T_MISSING" "$(user_line)" "$MISSING_FIELD_LINE"
run_hook "$(stop_payload "$T_MISSING" false)"
check "missing usage fields default to 0 rather than erroring"  'is_block_shape "$OUT"'

# Boundary: usage exactly equal to the default nudge_warn (200000, no
# project.yaml) must still block -- "at or above warn" is >=, not >.
T_EXACT_WARN="$CASE_DIR/exact-warn.jsonl"
mk_transcript "$T_EXACT_WARN" "$(user_line)" "$(usage_line 200000)"
run_hook "$(stop_payload "$T_EXACT_WARN" false)"
check "usage exactly at default nudge_warn (200000) blocks"  'is_block_shape "$OUT"'

# ---------------------------------------------------------------------------
# Case 6: usage at severe level -> block, severe text, differs from warn text
# ---------------------------------------------------------------------------
echo "Case 6: usage at severe level -> block, severe text differs from warn"
enter_case 6
T="$CASE_DIR/transcript.jsonl"
mk_transcript "$T" "$(user_line)" "$(usage_line 600000)"
run_hook "$(stop_payload "$T" false)" -u HERDR_ENV
RC_SEVERE="$RC"
SEVERE_OUT="$OUT"
check "exit code 0 (severe)"           '[ "$RC_SEVERE" -eq 0 ]'
check "stdout is valid JSON"           'is_valid_json "$SEVERE_OUT"'
check "block shape, no forbidden keys" 'is_block_shape "$SEVERE_OUT"'
SEVERE_REASON="$(reason_of "$SEVERE_OUT")"
check "severe reason text is non-empty"           '[ -n "$SEVERE_REASON" ]'
check "severe text differs from warn text"        '[ "$SEVERE_REASON" != "$WARN_REASON_NO_HERDR" ]'
check "severe text reads more urgent than warn"   'printf %s "$SEVERE_REASON" | grep -qiE "severe|critical|urgent|immediately"'
check "mentions compact-and-continue without HERDR_ENV"  'printf %s "$SEVERE_REASON" | grep -qi "compact-and-continue"'

# Boundary: usage exactly equal to the default nudge_severe (500000) must
# read as severe -- "at or above severe" is >=, not >.
T_EXACT_SEVERE="$CASE_DIR/exact-severe.jsonl"
mk_transcript "$T_EXACT_SEVERE" "$(user_line)" "$(usage_line 500000)"
run_hook "$(stop_payload "$T_EXACT_SEVERE" false)" -u HERDR_ENV
EXACT_SEVERE_REASON="$(reason_of "$OUT")"
check "usage exactly at default nudge_severe (500000) reads as severe"  'printf %s "$EXACT_SEVERE_REASON" | grep -qiE "severe|critical|urgent|immediately"'

# ---------------------------------------------------------------------------
# Case 7: project.yaml threshold overrides
# ---------------------------------------------------------------------------
echo "Case 7: project.yaml thresholds override the built-in defaults"
enter_case 7
T="$CASE_DIR/transcript.jsonl"
mk_transcript "$T" "$(user_line)" "$(usage_line 150000)"

mk_config 100000 300000
run_hook "$(stop_payload "$T" false)"
RC_OVERRIDE_WARN="$RC"
check "exit code 0 (overridden warn)"  '[ "$RC_OVERRIDE_WARN" -eq 0 ]'
check "150000 blocks under nudge_warn=100000 (would be silent under defaults)"  'is_block_shape "$OUT"'
OVERRIDE_WARN_REASON="$(reason_of "$OUT")"
check "not yet severe (nudge_severe=300000)"  '! printf %s "$OVERRIDE_WARN_REASON" | grep -qiE "severe|critical|urgent|immediately"'

mk_config 100000 120000
run_hook "$(stop_payload "$T" false)"
RC_OVERRIDE_SEVERE="$RC"
check "exit code 0 (overridden severe)"  '[ "$RC_OVERRIDE_SEVERE" -eq 0 ]'
OVERRIDE_SEVERE_REASON="$(reason_of "$OUT")"
check "150000 is severe under nudge_severe=120000"  'printf %s "$OVERRIDE_SEVERE_REASON" | grep -qiE "severe|critical|urgent|immediately"'

# ---------------------------------------------------------------------------
# Case 8: only the LAST qualifying assistant record counts (no summing across)
# ---------------------------------------------------------------------------
echo "Case 8: only the LAST qualifying assistant record counts"
enter_case 8
T1="$CASE_DIR/big-then-small.jsonl"
mk_transcript "$T1" "$(user_line)" "$(usage_line 900000)" "$(tool_line)" "$(usage_line 50000)"
run_hook "$(stop_payload "$T1" false)"
check "silent when the big usage record is earlier and small is last"  'is_silent "$OUT"'

T2="$CASE_DIR/small-then-big.jsonl"
mk_transcript "$T2" "$(user_line)" "$(usage_line 50000)" "$(tool_line)" "$(usage_line 600000)"
run_hook "$(stop_payload "$T2" false)"
check "block when the small usage record is earlier and big is last"  'is_block_shape "$OUT"'

T3="$CASE_DIR/trailing-no-usage.jsonl"
mk_transcript "$T3" "$(user_line)" "$(usage_line 600000)" "$(no_usage_line)"
run_hook "$(stop_payload "$T3" false)"
check "a trailing assistant record without usage is skipped; prior qualifying record wins"  'is_block_shape "$OUT"'

# ---------------------------------------------------------------------------
# Case 9: sidechain records are skipped when scanning from the end
# ---------------------------------------------------------------------------
echo "Case 9: trailing isSidechain records are skipped"
enter_case 9
T="$CASE_DIR/sidechain.jsonl"
mk_transcript "$T" "$(user_line)" "$(usage_line 600000 false)" "$(tool_line)" "$(usage_line 10000 true)" "$(usage_line 20000 true)"
run_hook "$(stop_payload "$T" false)"
RC_SIDECHAIN="$RC"
SIDECHAIN_OUT="$OUT"
check "exit code 0"                                        '[ "$RC_SIDECHAIN" -eq 0 ]'
check "uses the last NON-sidechain record (600000, severe)"  'is_block_shape "$SIDECHAIN_OUT"'
SIDECHAIN_REASON="$(reason_of "$SIDECHAIN_OUT")"
check "reads as severe, ignoring the smaller trailing sidechain usage"  'printf %s "$SIDECHAIN_REASON" | grep -qiE "severe|critical|urgent|immediately"'

# ---------------------------------------------------------------------------
# Case 10: malformed lines interleaved do not crash the hook
# ---------------------------------------------------------------------------
echo "Case 10: malformed lines interleaved do not crash the hook"
enter_case 10
T="$CASE_DIR/malformed.jsonl"
mk_transcript "$T" "$(malformed_line)" "$(user_line)" "$(malformed_line)" "$(usage_line 250000)" "$(malformed_line)"
run_hook "$(stop_payload "$T" false)"
check "exit code 0 despite malformed lines"  '[ "$RC" -eq 0 ]'
check "still detects usage correctly around malformed lines"  'is_block_shape "$OUT"'

# ---------------------------------------------------------------------------
# Case 11: SubagentStop is a silent no-op, whatever it carries
# ---------------------------------------------------------------------------
# Nobody but the session itself can hand the user's work over. A teammate and a
# plain subagent are equally unable to, so neither is ever nudged, however much
# context its own transcript reports. "Silent" here is the strict kind: no
# stdout, no stderr, and no ladder state left behind for anything.
echo "Case 11: SubagentStop is a silent no-op, always"
enter_case 11
STATE="$CASE_DIR/state"
use_state_dir "$STATE"

# An in-process teammate far above every rung on the default ladder: the case
# the hook used to nudge, and now must not.
T_TEAM="$CASE_DIR/agent-team.jsonl"
mk_transcript "$T_TEAM" "$(user_line)" "$(usage_line 950000)"
cat > "$CASE_DIR/agent-team.meta.json" <<'EOF'
{"taskKind": "in_process_teammate"}
EOF
run_hook "$(subagent_payload "$T_TEAM" false "wonder-woman" "agent-team")"
RC_TEAM="$RC"
TEAM_OUT="$OUT"
check "exit code 0 (in_process_teammate at 950000)"       '[ "$RC_TEAM" -eq 0 ]'
check "empty stdout for taskKind=in_process_teammate"     'is_quiet "$TEAM_OUT"'
check "empty stderr for taskKind=in_process_teammate"     'is_stderr_clean'
check "teammate stop records no ladder state at all"      '[ -z "$(state_last_files "$STATE")" ]'

# The same teammate carrying the parent session's id: still nothing, and in
# particular no state file under the parent's key or a key derived from it.
run_hook "$(subagent_payload_session "$T_TEAM" "sess-parent" "agent-team")"
check "exit code 0 (teammate with a parent session_id)"   '[ "$RC" -eq 0 ]'
check "empty stdout for a teammate with a session_id"     'is_quiet "$OUT"'
check "no ladder state under the parent session's key"    '[ -z "$(state_last_files "$STATE")" ]'

T_SUB="$CASE_DIR/agent-sub.jsonl"
mk_transcript "$T_SUB" "$(user_line)" "$(usage_line 950000)"
cat > "$CASE_DIR/agent-sub.meta.json" <<'EOF'
{"taskKind": "subagent"}
EOF
run_hook "$(subagent_payload "$T_SUB" false "task-checker" "agent-sub")"
RC_SUB="$RC"
check "exit code 0 (ordinary subagent)"                     '[ "$RC_SUB" -eq 0 ]'
check "empty stdout for taskKind=subagent despite big usage"  'is_quiet "$OUT"'
check "ordinary subagent records no ladder state"           '[ -z "$(state_last_files "$STATE")" ]'

T_NOMETA="$CASE_DIR/agent-nometa.jsonl"
mk_transcript "$T_NOMETA" "$(user_line)" "$(usage_line 950000)"
run_hook "$(subagent_payload "$T_NOMETA" false "some-agent" "agent-nometa")"
RC_NOMETA="$RC"
check "exit code 0 (missing meta file)"                   '[ "$RC_NOMETA" -eq 0 ]'
check "empty stdout when <transcript>.meta.json is missing"  'is_quiet "$OUT"'

# agent_type carries a NAME (e.g. a teammate's own name), and naming an agent
# after the old discriminator buys it nothing either.
T_NAMED="$CASE_DIR/wonder-woman.jsonl"
mk_transcript "$T_NAMED" "$(user_line)" "$(usage_line 950000)"
cat > "$CASE_DIR/wonder-woman.meta.json" <<'EOF'
{"taskKind": "in_process_teammate"}
EOF
run_hook "$(subagent_payload "$T_NAMED" false "in_process_teammate" "wonder-woman")"
check "empty stdout whatever agent_type names the agent"  'is_quiet "$OUT"'
check "still no ladder state after every SubagentStop"    '[ -z "$(state_last_files "$STATE")" ]'

# The payloads above name only agent_transcript_path, which is not enough to
# pin the contract down: a hook that stopped treating SubagentStop as its own
# case would find no transcript to measure and go quiet by accident, passing
# every check above for the wrong reason. The host sends transcript_path too --
# the PARENT session's transcript, which on a real SubagentStop is exactly the
# large one this hook would love to nudge about. These runs carry both fields,
# so silence here can only come from the event name being honoured.
#
# Each run gets its own state directory so "no state files" means this run
# wrote nothing, rather than inheriting the emptiness of the ones before it.
STATE_BOTH_TEAM="$CASE_DIR/state-both-teammate"
fresh_state_dir
use_state_dir "$STATE_BOTH_TEAM"
run_hook "$(subagent_payload_both "$T_TEAM" "sess-parent" "agent-team")"
RC_BOTH_TEAM="$RC"
check "exit code 0 (teammate, both transcript paths)"        '[ "$RC_BOTH_TEAM" -eq 0 ]'
check "empty stdout for a teammate carrying both paths"      'is_quiet "$OUT"'
check "no ladder state for a teammate carrying both paths"   '[ -z "$(state_last_files "$STATE_BOTH_TEAM")" ]'

# The same shape for an ordinary subagent. This pair holds today, and holds
# only while the event name decides: drop the SubagentStop case and the hook
# starts measuring the parent transcript these payloads now carry.
STATE_BOTH_SUB="$CASE_DIR/state-both-subagent"
fresh_state_dir
use_state_dir "$STATE_BOTH_SUB"
run_hook "$(subagent_payload_both "$T_SUB" "sess-parent" "agent-sub")"
RC_BOTH_SUB="$RC"
check "exit code 0 (ordinary subagent, both transcript paths)"      '[ "$RC_BOTH_SUB" -eq 0 ]'
check "empty stdout for an ordinary subagent carrying both paths"   'is_quiet "$OUT"'
check "no ladder state for an ordinary subagent carrying both paths" '[ -z "$(state_last_files "$STATE_BOTH_SUB")" ]'
fresh_state_dir

# ---------------------------------------------------------------------------
# Case 12: nudge output never carries hookSpecificOutput/additionalContext/systemMessage
# ---------------------------------------------------------------------------
echo "Case 12: forbidden keys never appear in any nudging output"
for pair in "warn:$WARN_OUT" "severe:$SEVERE_OUT" "sidechain-severe:$SIDECHAIN_OUT"; do
  label="${pair%%:*}"
  val="${pair#*:}"
  check "no hookSpecificOutput/additionalContext/systemMessage in $label output"  'is_block_shape "$val"'
done
# The teammate stop produces no output at all, so there is nothing in it that
# could carry a forbidden key.
check "the teammate stop produced no output to inspect"  'is_quiet "$TEAM_OUT"'

# ---------------------------------------------------------------------------
# Case 13: exit code is 0 across every scenario exercised above
# ---------------------------------------------------------------------------
echo "Case 13: exit code is 0 in every scenario"
for pair in "warn-no-herdr:$RC_WARN_NO_HERDR" "warn-herdr:$RC_WARN_HERDR" "severe:$RC_SEVERE" \
            "override-warn:$RC_OVERRIDE_WARN" "override-severe:$RC_OVERRIDE_SEVERE" \
            "sidechain:$RC_SIDECHAIN" "teammate:$RC_TEAM" "subagent:$RC_SUB" "nometa:$RC_NOMETA"; do
  label="${pair%%:*}"
  rc="${pair#*:}"
  check "exit code 0 for $label"  '[ "$rc" -eq 0 ]'
done

# ---------------------------------------------------------------------------
# Case 14: per-session state lives under SPECHUB_CONTEXT_PRESSURE_DIR
# ---------------------------------------------------------------------------
echo "Case 14: per-session state directory"
enter_case 14

STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
set_tokens "$T" 250000
run_hook "$(stop_payload_session "$T" "sess-alpha")"
RC_STATE_FIRST="$RC"
check "exit code 0 (first stop past a rung)"          '[ "$RC_STATE_FIRST" -eq 0 ]'
check "fires on the first stop past a rung"           'is_block_shape "$OUT"'
check "creates the state directory when it is missing"  '[ -d "$STATE" ]'
check "records the fired rung in <dir>/<session_id>.last"  '[ "$(last_rung "$STATE" "sess-alpha")" = "200000" ]'

# No session_id in the payload: the key is the transcript basename minus .jsonl.
fresh_state_dir
STATE_BN="$CASE_DIR/state-basename"
use_state_dir "$STATE_BN"
T_BN="$CASE_DIR/my-session.jsonl"
set_tokens "$T_BN" 250000
run_hook "$(stop_payload "$T_BN" false)"
check "fires with no session_id in the payload"  'is_block_shape "$OUT"'
check "session key falls back to the transcript basename without .jsonl"  '[ "$(last_rung "$STATE_BN" "my-session")" = "200000" ]'
set_tokens "$T_BN" 260000
run_hook "$(stop_payload "$T_BN" false)"
check "second stop on the same rung is silent under the basename key"  'is_quiet "$OUT"'

# An unwritable state directory must never break the stop.
fresh_state_dir
RO_PARENT="$CASE_DIR/readonly"
mkdir -p "$RO_PARENT"
chmod 500 "$RO_PARENT"
if touch "$RO_PARENT/.probe" 2>/dev/null; then
  rm -f "$RO_PARENT/.probe"
  printf '  \033[33mNOTE\033[0m %s\n' "state dir stayed writable after chmod 500 (running as root?) -- unwritable-dir checks skipped"
else
  use_state_dir "$RO_PARENT/state"
  run_hook "$(stop_payload_session "$T" "sess-readonly")"
  RC_RO="$RC"
  OUT_RO="$OUT"
  check "exit code 0 when the state directory cannot be created"  '[ "$RC_RO" -eq 0 ]'
  check "silent when the state directory cannot be created"       'is_quiet "$OUT_RO"'
fi
chmod 700 "$RO_PARENT"
fresh_state_dir

# ---------------------------------------------------------------------------
# Case 15: the ladder fires once per rung, not on every stop past a threshold
# ---------------------------------------------------------------------------
echo "Case 15: threshold ladder fires once per rung"
enter_case 15
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-ladder"

ladder_step 250000
RC_LADDER_FIRST="$RC"
LADDER_OUT="$OUT"
check "exit code 0 (250000, first rung)"       '[ "$RC_LADDER_FIRST" -eq 0 ]'
check "250000 fires the warn rung (200000)"    'is_block_shape "$LADDER_OUT"'
check "250000 reads as warn, not severe"       '! reads_severe "$LADDER_OUT"'
check "records rung 200000"                    '[ "$(last_rung "$STATE" "$SID")" = "200000" ]'

ladder_step 260000
RC_LADDER_REPEAT="$RC"
check "exit code 0 (260000, same rung)"                  '[ "$RC_LADDER_REPEAT" -eq 0 ]'
check "260000 is silent: the 200000 rung already fired"  'is_quiet "$OUT"'
check "the recorded rung is unchanged at 200000"         '[ "$(last_rung "$STATE" "$SID")" = "200000" ]'

ladder_step 500000
check "500000 fires the severe rung"     'is_block_shape "$OUT"'
check "500000 reads as severe"           'reads_severe "$OUT"'
check "records rung 500000"              '[ "$(last_rung "$STATE" "$SID")" = "500000" ]'

ladder_step 560000
check "560000 is silent: no rung between 500000 and 600000"  'is_quiet "$OUT"'
check "the recorded rung is unchanged at 500000"             '[ "$(last_rung "$STATE" "$SID")" = "500000" ]'

ladder_step 600000
check "600000 fires the first nudge_step rung above severe"  'is_block_shape "$OUT"'
check "600000 reads as severe"                               'reads_severe "$OUT"'
check "records rung 600000"                                  '[ "$(last_rung "$STATE" "$SID")" = "600000" ]'

ladder_step 700000
check "700000 fires the next nudge_step rung"  'is_block_shape "$OUT"'
check "records rung 700000"                    '[ "$(last_rung "$STATE" "$SID")" = "700000" ]'

ladder_step 650000
check "650000 after 700000 is silent (no rung above the record)"  'is_quiet "$OUT"'
check "the recorded rung stays at 700000"                         '[ "$(last_rung "$STATE" "$SID")" = "700000" ]'

# ---------------------------------------------------------------------------
# Case 16: a jump past several rungs fires once and records the highest
# ---------------------------------------------------------------------------
echo "Case 16: jumping past several rungs fires once"
enter_case 16
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-jump"

ladder_step 730000
check "730000 from nothing fires once"           'is_block_shape "$OUT"'
check "records 700000, the highest rung reached" '[ "$(last_rung "$STATE" "$SID")" = "700000" ]'

ladder_step 750000
check "750000 is silent: 700000 was the rung, and 800000 is not reached"  'is_quiet "$OUT"'

ladder_step 800000
check "800000 fires the next rung"  'is_block_shape "$OUT"'
check "records rung 800000"         '[ "$(last_rung "$STATE" "$SID")" = "800000" ]'

# ---------------------------------------------------------------------------
# Case 17: sessions have independent ladder state
# ---------------------------------------------------------------------------
echo "Case 17: ladder state is per session"
enter_case 17
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
set_tokens "$T" 250000

run_hook "$(stop_payload_session "$T" "sess-one")"
check "session one fires"  'is_block_shape "$OUT"'
run_hook "$(stop_payload_session "$T" "sess-one")"
check "session one is silent on the second stop"  'is_quiet "$OUT"'
run_hook "$(stop_payload_session "$T" "sess-two")"
check "session two fires despite session one having fired the same rung"  'is_block_shape "$OUT"'
check "session one's rung is recorded separately"  '[ "$(last_rung "$STATE" "sess-one")" = "200000" ]'
check "session two's rung is recorded separately"  '[ "$(last_rung "$STATE" "sess-two")" = "200000" ]'

# ---------------------------------------------------------------------------
# Case 18: a corrupt .last record is treated as "nothing fired yet"
# ---------------------------------------------------------------------------
echo "Case 18: corrupt .last is treated as absent"
enter_case 18
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
mkdir -p "$STATE"
T="$CASE_DIR/transcript.jsonl"

printf 'banana\n' > "$STATE/sess-corrupt.last"
set_tokens "$T" 250000
run_hook "$(stop_payload_session "$T" "sess-corrupt")"
RC_CORRUPT="$RC"
check "exit code 0 with a non-integer .last"      '[ "$RC_CORRUPT" -eq 0 ]'
check "fires despite the non-integer .last"       'is_block_shape "$OUT"'
check "overwrites the corrupt record with 200000" '[ "$(last_rung "$STATE" "sess-corrupt")" = "200000" ]'

: > "$STATE/sess-empty.last"
run_hook "$(stop_payload_session "$T" "sess-empty")"
check "fires when .last is empty"            'is_block_shape "$OUT"'
check "records 200000 over the empty file"   '[ "$(last_rung "$STATE" "sess-empty")" = "200000" ]'

# ---------------------------------------------------------------------------
# Case 19: nudge_step changes the rung spacing above severe
# ---------------------------------------------------------------------------
echo "Case 19: workflow.handoff.nudge_step spaces the rungs above severe"
enter_case 19
mk_config_raw <<'EOF'
workflow:
  handoff:
    nudge_step: 50000
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-step"

ladder_step 500000
check "500000 fires the severe rung"  'is_block_shape "$OUT"'
check "records rung 500000"           '[ "$(last_rung "$STATE" "$SID")" = "500000" ]'

ladder_step 560000
check "560000 fires the 550000 rung (silent under the default 100000 step)"  'is_block_shape "$OUT"'
check "records rung 550000"  '[ "$(last_rung "$STATE" "$SID")" = "550000" ]'

ladder_step 590000
check "590000 is silent: still below 600000"  'is_quiet "$OUT"'

ladder_step 600000
check "600000 fires the next 50000 rung"  'is_block_shape "$OUT"'
check "records rung 600000"               '[ "$(last_rung "$STATE" "$SID")" = "600000" ]'

# ---------------------------------------------------------------------------
# Case 20: context_thresholds (block style) replaces the default rungs
# ---------------------------------------------------------------------------
echo "Case 20: context_thresholds block style replaces the default ladder"
enter_case 20
mk_config_raw <<'EOF'
workflow:
  handoff:
    context_thresholds:
      - 150000
      - 300000
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-explicit"

ladder_step 149999
check "149999 is silent: below the first listed rung"  'is_quiet "$OUT"'

ladder_step 150000
check "150000 fires the first listed rung"      'is_block_shape "$OUT"'
check "150000 reads as warn (below nudge_severe)"  '! reads_severe "$OUT"'
check "records rung 150000"                     '[ "$(last_rung "$STATE" "$SID")" = "150000" ]'

ladder_step 250000
check "250000 is silent: the default 200000 rung is gone"  'is_quiet "$OUT"'
check "the recorded rung is unchanged at 150000"           '[ "$(last_rung "$STATE" "$SID")" = "150000" ]'

ladder_step 300000
check "300000 fires the second listed rung"  'is_block_shape "$OUT"'
check "records rung 300000"                  '[ "$(last_rung "$STATE" "$SID")" = "300000" ]'

ladder_step 350000
check "350000 is silent: past the last listed rung, below the next step"  'is_quiet "$OUT"'

ladder_step 400000
check "400000 fires: nudge_step extends the ladder past the last listed rung"  'is_block_shape "$OUT"'
check "records rung 400000"  '[ "$(last_rung "$STATE" "$SID")" = "400000" ]'

# ---------------------------------------------------------------------------
# Case 21: context_thresholds in flow style
# ---------------------------------------------------------------------------
echo "Case 21: context_thresholds flow style"
enter_case 21
mk_config_raw <<'EOF'
workflow:
  handoff:
    context_thresholds: [150000, 300000]
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-flow"

ladder_step 149999
check "149999 is silent under a flow-style ladder"  'is_quiet "$OUT"'

ladder_step 150000
check "150000 fires under a flow-style ladder"  'is_block_shape "$OUT"'
check "records rung 150000"                     '[ "$(last_rung "$STATE" "$SID")" = "150000" ]'

ladder_step 250000
check "250000 is silent: flow-style list also replaces the defaults"  'is_quiet "$OUT"'

ladder_step 300000
check "300000 fires the second flow-style rung"  'is_block_shape "$OUT"'
check "records rung 300000"                      '[ "$(last_rung "$STATE" "$SID")" = "300000" ]'

# ---------------------------------------------------------------------------
# Case 22: with an explicit ladder, nudge_severe only picks the wording
# ---------------------------------------------------------------------------
echo "Case 22: nudge_severe selects wording, not rung placement"
enter_case 22
mk_config_raw <<'EOF'
workflow:
  handoff:
    nudge_warn: 100000
    nudge_severe: 250000
    context_thresholds: [150000, 300000]
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-wording"

ladder_step 150000
check "150000 fires"  'is_block_shape "$OUT"'
check "150000 reads as warn: it is below nudge_severe"  '! reads_severe "$OUT"'

ladder_step 260000
check "260000 is silent: nudge_warn/nudge_severe place no rungs"  'is_quiet "$OUT"'
check "the recorded rung is unchanged at 150000"  '[ "$(last_rung "$STATE" "$SID")" = "150000" ]'

ladder_step 300000
check "300000 fires the listed rung"  'is_block_shape "$OUT"'
check "300000 reads as severe: it is at or above nudge_severe"  'reads_severe "$OUT"'

# ---------------------------------------------------------------------------
# Case 23: percentage rungs resolve against a configured context_window
# ---------------------------------------------------------------------------
echo "Case 23: percentage rungs against workflow.handoff.context_window"
enter_case 23
mk_config_raw <<'EOF'
workflow:
  handoff:
    context_window: 200000
    context_thresholds: ["40%"]
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"

SID="sess-under"
ladder_step 79999
RC_PCT="$RC"
check "exit code 0 (percentage rung, below)"  '[ "$RC_PCT" -eq 0 ]'
check "79999 is silent: below 40% of a 200000 window"  'is_quiet "$OUT"'

SID="sess-over"
ladder_step 80000
check "80000 fires: exactly 40% of a 200000 window"  'is_block_shape "$OUT"'
check "records the resolved rung 80000"             '[ "$(last_rung "$STATE" "sess-over")" = "80000" ]'

SID="sess-over-repeat"
ladder_step 80000
check "a different session at the same tokens fires independently"  'is_block_shape "$OUT"'
SID="sess-over"
ladder_step 90000
check "90000 is silent: the 80000 rung already fired for this session"  'is_quiet "$OUT"'
# The pairing that makes the line above mean something: a session that has NOT
# fired yet does nudge at 90000, because 80000 is behind it.
SID="sess-fresh-90k"
ladder_step 90000
check "90000 fires for a session that has not passed the 80000 rung yet"  'is_block_shape "$OUT"'
check "records the resolved rung 80000"  '[ "$(last_rung "$STATE" "sess-fresh-90k")" = "80000" ]'

# Absolute rungs are measured in tokens, never scaled by the context window.
enter_case 23b
mk_config_raw <<'EOF'
workflow:
  handoff:
    context_window: 200000
    context_thresholds: [150000]
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"

SID="sess-abs-under"
ladder_step 149999
check "149999 is silent: an absolute rung is not scaled by context_window"  'is_quiet "$OUT"'
SID="sess-abs"
ladder_step 150000
check "150000 fires the absolute rung under a 200000 window"  'is_block_shape "$OUT"'
check "records rung 150000"  '[ "$(last_rung "$STATE" "sess-abs")" = "150000" ]'

# ---------------------------------------------------------------------------
# Case 24: with no context_window, the window comes from the model, else 1M
# ---------------------------------------------------------------------------
echo "Case 24: context window inferred from message.model, defaulting to 1M"
enter_case 24
mk_config_raw <<'EOF'
workflow:
  handoff:
    context_thresholds: ["40%"]
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"

SID="sess-1m-under"
ladder_step 399999 "claude-opus-4-8[1m]"
check "399999 is silent: below 40% of the 1m model's window"  'is_quiet "$OUT"'

SID="sess-1m"
ladder_step 400000 "claude-opus-4-8[1m]"
check "400000 fires: exactly 40% of the 1m model's window"  'is_block_shape "$OUT"'
check "records the resolved rung 400000"  '[ "$(last_rung "$STATE" "sess-1m")" = "400000" ]'

SID="sess-nomodel-under"
ladder_step 399999
check "399999 is silent with no model: the window defaults to 1000000"  'is_quiet "$OUT"'

SID="sess-nomodel"
ladder_step 400000
check "400000 fires with no model: the window defaults to 1000000"  'is_block_shape "$OUT"'
check "records the resolved rung 400000"  '[ "$(last_rung "$STATE" "sess-nomodel")" = "400000" ]'

# ---------------------------------------------------------------------------
# Case 25: the .quiet marker silences the hook entirely
# ---------------------------------------------------------------------------
echo "Case 25: <dir>/<session_id>.quiet silences the hook"
enter_case 25
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
mkdir -p "$STATE"
T="$CASE_DIR/transcript.jsonl"

SID="sess-quiet"
: > "$STATE/$SID.quiet"
ladder_step 600000
RC_QUIET="$RC"
QUIET_OUT="$OUT"
check "exit code 0 with the quiet marker present"  '[ "$RC_QUIET" -eq 0 ]'
check "silent with the quiet marker present"       'is_quiet "$QUIET_OUT"'
check "does not create .last while quiet"          '[ ! -e "$STATE/$SID.last" ]'
# Strengthen the silence check: the very same stop fires once the marker is gone.
rm -f "$STATE/$SID.quiet"
ladder_step 600000
check "the same stop fires once the marker is removed"  'is_block_shape "$OUT"'
check "and only then records the rung"                  '[ "$(last_rung "$STATE" "$SID")" = "600000" ]'

# An existing rung record must survive a quiet stop untouched.
SID="sess-quiet-keeps-last"
printf '200000\n' > "$STATE/$SID.last"
: > "$STATE/$SID.quiet"
ladder_step 700000
check "silent at 700000 with the marker present"  'is_quiet "$OUT"'
check "leaves the recorded rung at 200000"        '[ "$(last_rung "$STATE" "$SID")" = "200000" ]'
rm -f "$STATE/$SID.quiet"
ladder_step 700000
check "fires at 700000 once the marker is removed"  'is_block_shape "$OUT"'
check "and advances the recorded rung to 700000"    '[ "$(last_rung "$STATE" "$SID")" = "700000" ]'

# A fresh session far above every rung is still silenced by the marker.
SID="sess-quiet-fresh"
: > "$STATE/$SID.quiet"
ladder_step 950000
check "silent for a fresh session at 950000 with the marker present"  'is_quiet "$OUT"'
check "does not create .last for the fresh quiet session"  '[ ! -e "$STATE/$SID.last" ]'
rm -f "$STATE/$SID.quiet"
ladder_step 950000
check "the fresh session fires at 950000 once the marker is removed"  'is_block_shape "$OUT"'

# ---------------------------------------------------------------------------
# Case 26: ladder output keeps the existing contract
# ---------------------------------------------------------------------------
echo "Case 26: ladder output keeps the exit-0 / shape / short-circuit contract"
enter_case 26
check "ladder nudge is valid JSON"                     'is_valid_json "$LADDER_OUT"'
check "ladder nudge has no forbidden keys"             'is_block_shape "$LADDER_OUT"'
check "quiet-marker output is valid JSON (empty)"      'is_valid_json "$QUIET_OUT"'

STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
set_tokens "$T" 900000
run_hook "$(stop_payload_session "$T" "sess-active" true)"
RC_ACTIVE="$RC"
check "exit code 0 with stop_hook_active=true"          '[ "$RC_ACTIVE" -eq 0 ]'
check "silent with stop_hook_active=true"               'is_quiet "$OUT"'
check "stop_hook_active=true records no rung"           '[ ! -e "$STATE/sess-active.last" ]'
fresh_state_dir

# ---------------------------------------------------------------------------
# Case 27: the context window a percentage resolves against comes from the model
# ---------------------------------------------------------------------------
echo "Case 27: context window per model id (no context_window configured)"
enter_case 27
mk_config_raw <<'EOF'
workflow:
  handoff:
    context_thresholds: ["40%"]
EOF
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"

# A model id carrying the [1m] marker has a 1,000,000-token window, so 40%
# lands at 400000. (Case 24 covers this too; it is repeated here as the row the
# rest of the table is read against.)
SID="sess-opus-1m-under"
ladder_step 399999 "claude-opus-4-8[1m]"
check "claude-opus-4-8[1m]: 399999 is silent (40% of 1000000 is 400000)"  'is_quiet "$OUT"'
SID="sess-opus-1m"
ladder_step 400000 "claude-opus-4-8[1m]"
check "claude-opus-4-8[1m]: 400000 fires"  'is_block_shape "$OUT"'

# The same model without the marker has a 200,000-token window: 40% is 80000.
SID="sess-opus-under"
ladder_step 79999 "claude-opus-4-8"
check "claude-opus-4-8: 79999 is silent (40% of 200000 is 80000)"  'is_quiet "$OUT"'
SID="sess-opus"
ladder_step 80000 "claude-opus-4-8"
check "claude-opus-4-8: 80000 fires"                      'is_block_shape "$OUT"'
check "claude-opus-4-8: records the resolved rung 80000"  '[ "$(last_rung "$STATE" "sess-opus")" = "80000" ]'

SID="sess-haiku-under"
ladder_step 79999 "claude-haiku-4-5-20251001"
check "claude-haiku-4-5-20251001: 79999 is silent (200000 window)"  'is_quiet "$OUT"'
SID="sess-haiku"
ladder_step 80000 "claude-haiku-4-5-20251001"
check "claude-haiku-4-5-20251001: 80000 fires (200000 window)"  'is_block_shape "$OUT"'

SID="sess-fable-under"
ladder_step 399999 "claude-fable-5"
check "claude-fable-5: 399999 is silent (1000000 window)"  'is_quiet "$OUT"'
SID="sess-fable"
ladder_step 400000 "claude-fable-5"
check "claude-fable-5: 400000 fires (1000000 window)"  'is_block_shape "$OUT"'

SID="sess-sonnet-under"
ladder_step 399999 "claude-sonnet-5"
check "claude-sonnet-5: 399999 is silent (1000000 window)"  'is_quiet "$OUT"'
SID="sess-sonnet"
ladder_step 400000 "claude-sonnet-5"
check "claude-sonnet-5: 400000 fires (1000000 window)"  'is_block_shape "$OUT"'

SID="sess-window-nomodel-under"
ladder_step 399999
check "no model on the record: 399999 is silent (1000000 default)"  'is_quiet "$OUT"'
SID="sess-window-nomodel"
ladder_step 400000
check "no model on the record: 400000 fires (1000000 default)"  'is_block_shape "$OUT"'

# ---------------------------------------------------------------------------
# Case 28: agents leave no ladder state, and never spend the session's rung
# ---------------------------------------------------------------------------
# The session's own ladder is the only ladder. Teammates stopping under a
# session must neither climb one of their own nor consume the session's next
# rung, so the session still gets every nudge it would have got alone.
echo "Case 28: SubagentStop records no ladder state and never spends the session's rung"
enter_case 28
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T_MAIN="$CASE_DIR/main.jsonl"
T_A1="$CASE_DIR/agent-a1.jsonl"
T_A2="$CASE_DIR/agent-a2.jsonl"
printf '{"taskKind": "in_process_teammate"}\n' > "$CASE_DIR/agent-a1.meta.json"
printf '{"taskKind": "in_process_teammate"}\n' > "$CASE_DIR/agent-a2.meta.json"

set_tokens "$T_A1" 260000
run_hook "$(subagent_payload_session "$T_A1" "sess-main" "a1")" -u HERDR_ENV
RC_TEAM_LADDER="$RC"
check "exit code 0 (teammate a1, first stop)"  '[ "$RC_TEAM_LADDER" -eq 0 ]'
check "teammate a1 is silent at 260000"        'is_quiet "$OUT"'
check "teammate a1 run leaves stderr empty"    'is_stderr_clean'
check "teammate a1 wrote no ladder state"      '[ -z "$(state_last_files "$STATE")" ]'

set_tokens "$T_A2" 950000
run_hook "$(subagent_payload_session "$T_A2" "sess-main" "a2")" -u HERDR_ENV
check "teammate a2 is silent at 950000"                    'is_quiet "$OUT"'
check "a second teammate still leaves the state dir empty"  '[ -z "$(state_last_files "$STATE")" ]'

set_tokens "$T_MAIN" 260000
run_hook "$(stop_payload_session "$T_MAIN" "sess-main")" -u HERDR_ENV
check "the session still fires at 260000 after its teammates stopped"  'is_block_shape "$OUT"'
check "and the recorded rung is the session's own 200000"  '[ "$(last_rung "$STATE" "sess-main")" = "200000" ]'

set_tokens "$T_MAIN" 270000
run_hook "$(stop_payload_session "$T_MAIN" "sess-main")" -u HERDR_ENV
check "the session is silent at 270000: it already fired that rung"  'is_quiet "$OUT"'

# ---------------------------------------------------------------------------
# Case 29: a session id that cannot name a file is a silent no-op
# ---------------------------------------------------------------------------
echo "Case 29: hostile session_id, and stderr stays empty"
enter_case 29
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
set_tokens "$T" 260000

# A NUL byte cannot appear in a path, so no state file can be opened for this
# session. The hook must give up quietly rather than let the error out.
NUL_PAYLOAD='{"hook_event_name":"Stop","stop_hook_active":false,"session_id":"ab\u0000cd","transcript_path":"'"$T"'"}'
run_hook "$NUL_PAYLOAD"
RC_NUL="$RC"
OUT_NUL="$OUT"
ERR_NUL="$ERR"
check "exit code 0 with a NUL byte in session_id"   '[ "$RC_NUL" -eq 0 ]'
check "empty stdout with a NUL byte in session_id"  'is_quiet "$OUT_NUL"'
check "empty stderr with a NUL byte in session_id"  '[ -z "$ERR_NUL" ]'

# stderr stays empty on the ordinary paths too -- firing, silent, and below.
run_hook "$(stop_payload_session "$T" "sess-clean")"
check "a firing run leaves stderr empty"  'is_stderr_clean'
run_hook "$(stop_payload_session "$T" "sess-clean")"
check "a silent run leaves stderr empty"  'is_stderr_clean'
set_tokens "$T" 1000
run_hook "$(stop_payload_session "$T" "sess-below")"
check "a below-threshold run leaves stderr empty"  'is_stderr_clean'

# ---------------------------------------------------------------------------
# Case 30: SessionStart source=compact clears the session's ladder state
# ---------------------------------------------------------------------------
# A compaction throws the session's context away and rebuilds it much smaller.
# The rung the hook last fired described the context that no longer exists, and
# the quiet marker recorded a handover that the fresh context knows nothing
# about, so both are deleted and the ladder starts over. The hook injects no
# context of its own on this event: SessionStart output would reach the model
# as extra context, which is exactly what a compaction just cleared.
echo "Case 30: SessionStart source=compact deletes the session's .last and .quiet"
enter_case 30
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
mkdir -p "$STATE"
T="$CASE_DIR/transcript.jsonl"
set_tokens "$T" 250000

printf '200000\n' > "$STATE/sess-compact.last"
: > "$STATE/sess-compact.quiet"
printf '500000\n' > "$STATE/sess-other.last"
: > "$STATE/sess-other.quiet"

run_hook "$(session_start_payload "sess-compact" "compact" "$T")"
RC_COMPACT="$RC"
OUT_COMPACT="$OUT"
check "exit code 0 (SessionStart compact)"                    '[ "$RC_COMPACT" -eq 0 ]'
check "empty stdout: the hook injects no context on compact"  'is_quiet "$OUT_COMPACT"'
check "compaction leaves stderr empty"                        'is_stderr_clean'
check "deletes <dir>/<session_id>.last"                       '[ ! -e "$STATE/sess-compact.last" ]'
check "deletes <dir>/<session_id>.quiet"                      '[ ! -e "$STATE/sess-compact.quiet" ]'
check "leaves another session's .last untouched"              '[ "$(last_rung "$STATE" "sess-other")" = "500000" ]'
check "leaves another session's .quiet untouched"             '[ -e "$STATE/sess-other.quiet" ]'

# A session whose recorded rung sits BELOW the transcript's current usage, and
# with no quiet marker to fall back on: nothing but the event itself can keep
# the hook silent here, so this is the check that the silence is real rather
# than the ladder or the marker doing the work.
printf '100000\n' > "$STATE/sess-lastonly.last"
run_hook "$(session_start_payload "sess-lastonly" "compact" "$T")"
check "empty stdout on compact even when a nudge would otherwise fire"  'is_quiet "$OUT"'
check "deletes the .last with no .quiet beside it"                      '[ ! -e "$STATE/sess-lastonly.last" ]'

# Nothing to delete is not a failure.
run_hook "$(session_start_payload "sess-absent" "compact" "$T")"
check "exit code 0 when the session has no state files"  '[ "$RC" -eq 0 ]'
check "silent when the session has no state files"       'is_quiet "$OUT"'
check "creates no state file for a session with none"    '[ ! -e "$STATE/sess-absent.last" ]'

# A state directory that does not exist at all.
fresh_state_dir
use_state_dir "$CASE_DIR/state-missing"
run_hook "$(session_start_payload "sess-nodir" "compact" "$T")"
RC_NODIR="$RC"
check "exit code 0 when the state directory does not exist"  '[ "$RC_NODIR" -eq 0 ]'
check "silent when the state directory does not exist"       'is_quiet "$OUT"'
check "and the compact run left stderr empty"                'is_stderr_clean'

# A state directory whose entries cannot be removed.
fresh_state_dir
RO_STATE="$CASE_DIR/readonly-state"
mkdir -p "$RO_STATE"
printf '200000\n' > "$RO_STATE/sess-ro.last"
chmod 500 "$RO_STATE"
if touch "$RO_STATE/.probe" 2>/dev/null; then
  rm -f "$RO_STATE/.probe"
  printf '  \033[33mNOTE\033[0m %s\n' "state dir stayed writable after chmod 500 (running as root?) -- unwritable-dir checks skipped"
else
  use_state_dir "$RO_STATE"
  run_hook "$(session_start_payload "sess-ro" "compact" "$T")"
  RC_RO_COMPACT="$RC"
  OUT_RO_COMPACT="$OUT"
  check "exit code 0 when the state files cannot be removed"  '[ "$RC_RO_COMPACT" -eq 0 ]'
  check "silent when the state files cannot be removed"       'is_quiet "$OUT_RO_COMPACT"'
  check "and stderr stays empty when removal fails"           'is_stderr_clean'
fi
chmod 700 "$RO_STATE"

# Every other reason a session starts leaves the state alone: only a compaction
# invalidates what the ladder remembers.
fresh_state_dir
STATE_SOURCES="$CASE_DIR/state-sources"
use_state_dir "$STATE_SOURCES"
mkdir -p "$STATE_SOURCES"
for src in startup resume clear fork; do
  printf '200000\n' > "$STATE_SOURCES/sess-$src.last"
  : > "$STATE_SOURCES/sess-$src.quiet"
  run_hook "$(session_start_payload "sess-$src" "$src" "$T")"
  check "exit code 0 (SessionStart $src)"                 '[ "$RC" -eq 0 ]'
  check "SessionStart source=$src keeps the .last file"   '[ "$(last_rung "$STATE_SOURCES" "sess-$src")" = "200000" ]'
  check "SessionStart source=$src keeps the .quiet file"  '[ -e "$STATE_SOURCES/sess-$src.quiet" ]'
done

# A session id that cannot name a file must delete nothing and say nothing --
# in particular nothing outside the state directory.
fresh_state_dir
STATE_HOSTILE="$CASE_DIR/state-hostile"
use_state_dir "$STATE_HOSTILE"
mkdir -p "$STATE_HOSTILE"
printf '200000\n' > "$STATE_HOSTILE/keeper.last"
: > "$STATE_HOSTILE/keeper.quiet"
OUTSIDE_LAST="$CASE_DIR/outside.last"
OUTSIDE_QUIET="$CASE_DIR/outside.quiet"
printf '200000\n' > "$OUTSIDE_LAST"
: > "$OUTSIDE_QUIET"

run_hook '{"hook_event_name":"SessionStart","session_id":"ab\u0000cd","source":"compact","transcript_path":"'"$T"'"}'
RC_SS_NUL="$RC"
OUT_SS_NUL="$OUT"
ERR_SS_NUL="$ERR"
check "exit code 0 with a NUL byte in session_id (SessionStart)"   '[ "$RC_SS_NUL" -eq 0 ]'
check "empty stdout with a NUL byte in session_id (SessionStart)"  'is_quiet "$OUT_SS_NUL"'
check "empty stderr with a NUL byte in session_id (SessionStart)"  '[ -z "$ERR_SS_NUL" ]'

run_hook "$(session_start_payload ".." "compact" "$T")"
check "exit code 0 with session_id \"..\""   '[ "$RC" -eq 0 ]'
check "empty stdout with session_id \"..\""  'is_quiet "$OUT"'
check "empty stderr with session_id \"..\""  'is_stderr_clean'

run_hook "$(session_start_payload "../outside" "compact" "$T")"
RC_SS_ESCAPE="$RC"
check "exit code 0 with a session_id that walks out of the state dir"   '[ "$RC_SS_ESCAPE" -eq 0 ]'
check "empty stdout with a session_id that walks out of the state dir"  'is_quiet "$OUT"'
check "nothing outside the state directory was deleted (.last)"   '[ -e "$OUTSIDE_LAST" ]'
check "nothing outside the state directory was deleted (.quiet)"  '[ -e "$OUTSIDE_QUIET" ]'
check "an unrelated session inside the state dir survives (.last)"   '[ "$(last_rung "$STATE_HOSTILE" "keeper")" = "200000" ]'
check "an unrelated session inside the state dir survives (.quiet)"  '[ -e "$STATE_HOSTILE/keeper.quiet" ]'
fresh_state_dir

# ---------------------------------------------------------------------------
# Case 31: end to end -- the ladder restarts from scratch after a compaction
# ---------------------------------------------------------------------------
echo "Case 31: a compaction restarts the ladder from scratch"
enter_case 31
STATE="$CASE_DIR/state"
use_state_dir "$STATE"
T="$CASE_DIR/transcript.jsonl"
SID="sess-e2e"

ladder_step 250000
check "250000 fires the warn rung before the compaction"  'is_block_shape "$OUT"'
check "records rung 200000"  '[ "$(last_rung "$STATE" "$SID")" = "200000" ]'

# The handoff that followed leaves the quiet marker behind, so the session goes
# silent however far it climbs.
: > "$STATE/$SID.quiet"
ladder_step 600000
check "600000 is silent while the quiet marker stands"  'is_quiet "$OUT"'
check "the recorded rung is unchanged at 200000"        '[ "$(last_rung "$STATE" "$SID")" = "200000" ]'

run_hook "$(session_start_payload "$SID" "compact" "$T")"
check "the compaction SessionStart is silent"     'is_quiet "$OUT"'
check "the compaction clears the recorded rung"   '[ ! -e "$STATE/$SID.last" ]'
check "the compaction clears the quiet marker"    '[ ! -e "$STATE/$SID.quiet" ]'

ladder_step 250000
check "250000 fires again after the compaction: the ladder restarted"  'is_block_shape "$OUT"'
check "250000 reads as warn again, not severe"                         '! reads_severe "$OUT"'
check "and records rung 200000 again"  '[ "$(last_rung "$STATE" "$SID")" = "200000" ]'
fresh_state_dir

# ---------------------------------------------------------------------------
# Case 32: the nudge text names the route it wants the agent to take
# ---------------------------------------------------------------------------
echo "Case 32: nudge text points at the question tool and the wrap-up moment"
LADDER_REASON="$(reason_of "$LADDER_OUT")"
check "warn nudge tells the agent to use the question tool"    'printf %s "$WARN_REASON_NO_HERDR" | grep -qi "question tool"'
check "severe nudge tells the agent to use the question tool"  'printf %s "$SEVERE_REASON" | grep -qi "question tool"'
check "ladder nudge tells the agent to use the question tool"  'printf %s "$LADDER_REASON" | grep -qi "question tool"'
check "warn nudge says to wait until the current run of work wraps up"    'printf %s "$WARN_REASON_NO_HERDR" | grep -qi "once the current run of work wraps up"'
check "severe nudge says to wait until the current run of work wraps up"  'printf %s "$SEVERE_REASON" | grep -qi "once the current run of work wraps up"'

# ---------------------------------------------------------------------------
# Case 33: nothing in this suite made the hook write to stderr
# ---------------------------------------------------------------------------
echo "Case 33: no hook run in this suite wrote to stderr"
check "every hook run left stderr empty"  '[ "$STDERR_DIRTY" -eq 0 ]'
[ "$STDERR_DIRTY" -eq 0 ] || printf '    last stderr seen: %s\n' "$STDERR_DIRTY_LAST"

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
