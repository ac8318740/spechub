#!/usr/bin/env bash
# Local test harness for context-pressure.sh (Stop / SubagentStop hook).
#
# Simulates exactly what Claude Code sends a Stop / SubagentStop hook (a JSON
# payload on stdin) and asserts the hook's behavior end-to-end: the
# stop_hook_active short-circuit, transcript discovery, the "last qualifying
# assistant record wins" scan rule (with sidechain skipping and malformed-line
# tolerance), threshold defaults and project.yaml overrides, the
# in-process-teammate-only nudge on SubagentStop, the required flat JSON output
# shape, the HERDR_ENV-conditional wording, and the always-exit-0 contract.
#
# Exercises the hook's payload handling, context-usage measurement, threshold
# logic, teammate discrimination, and output contract described above.
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
}

# One assistant transcript record carrying a usage total.
# $1 = total tokens (placed entirely in input_tokens; the other two usage
#      fields are set to 0 so the sum still equals $1).
# $2 = isSidechain (true/false, default false)
usage_line() {
  local total="$1" sidechain="${2:-false}"
  printf '{"type":"assistant","isSidechain":%s,"message":{"usage":{"input_tokens":%s,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}' "$sidechain" "$total"
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

# Build a SubagentStop payload.
# $1 = agent_transcript_path, $2 = stop_hook_active, $3 = agent_type (a NAME,
# not a discriminator), $4 = agent_id
subagent_payload() {
  local transcript="$1" active="${2:-false}" agent_type="${3:-teammate-a}" agent_id="${4:-agent-1}"
  printf '{"hook_event_name":"SubagentStop","stop_hook_active":%s,"agent_id":"%s","agent_type":"%s","agent_transcript_path":"%s"}' "$active" "$agent_id" "$agent_type" "$transcript"
}

# Run the hook. $1 = JSON payload, remaining args = env assignments/flags for
# `env` (e.g. HERDR_ENV=1, or -u HERDR_ENV to unset it). Sets OUT and RC.
run_hook() {
  local payload="$1"; shift
  OUT="$(printf '%s' "$payload" | env "$@" bash "$HOOK" 2>"$WORK/stderr.log")"
  RC=$?
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
# Case 1: hooks.json registers the hook under both Stop and SubagentStop
# ---------------------------------------------------------------------------
echo "Case 1: hooks.json registers context-pressure.sh under Stop and SubagentStop"
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
print("SUBAGENT_OK" if has_registration("SubagentStop") else "SUBAGENT_MISSING")
' 2>/dev/null)"
check "hooks.json parses as JSON"      '[ "$(printf %s "$HOOKS_JSON_CHECK" | sed -n 1p)" != "PARSE_ERROR" ]'
check "registers command hook under Stop"          'printf %s "$HOOKS_JSON_CHECK" | grep -q STOP_OK'
check "registers command hook under SubagentStop"  'printf %s "$HOOKS_JSON_CHECK" | grep -q SUBAGENT_OK'

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
# Case 11: SubagentStop nudges only in-process teammates
# ---------------------------------------------------------------------------
echo "Case 11: SubagentStop discriminates in_process_teammate via <transcript>.meta.json"
enter_case 11

T_TEAM="$CASE_DIR/agent-team.jsonl"
mk_transcript "$T_TEAM" "$(user_line)" "$(usage_line 600000)"
cat > "$CASE_DIR/agent-team.meta.json" <<'EOF'
{"taskKind": "in_process_teammate"}
EOF
run_hook "$(subagent_payload "$T_TEAM" false "wonder-woman" "agent-team")"
RC_TEAM="$RC"
TEAM_OUT="$OUT"
check "exit code 0 (in_process_teammate)"        '[ "$RC_TEAM" -eq 0 ]'
check "blocks for taskKind=in_process_teammate"  'is_block_shape "$TEAM_OUT"'

T_SUB="$CASE_DIR/agent-sub.jsonl"
mk_transcript "$T_SUB" "$(user_line)" "$(usage_line 600000)"
cat > "$CASE_DIR/agent-sub.meta.json" <<'EOF'
{"taskKind": "subagent"}
EOF
run_hook "$(subagent_payload "$T_SUB" false "task-checker" "agent-sub")"
RC_SUB="$RC"
check "exit code 0 (ordinary subagent)"              '[ "$RC_SUB" -eq 0 ]'
check "silent for taskKind=subagent despite big usage"  'is_silent "$OUT"'

T_NOMETA="$CASE_DIR/agent-nometa.jsonl"
mk_transcript "$T_NOMETA" "$(user_line)" "$(usage_line 600000)"
run_hook "$(subagent_payload "$T_NOMETA" false "some-agent" "agent-nometa")"
RC_NOMETA="$RC"
check "exit code 0 (missing meta file)"           '[ "$RC_NOMETA" -eq 0 ]'
check "silent when <transcript>.meta.json is missing"  'is_silent "$OUT"'

# agent_type carries a NAME (e.g. a teammate's own name), never the discriminator.
T_NAMED="$CASE_DIR/wonder-woman.jsonl"
mk_transcript "$T_NAMED" "$(user_line)" "$(usage_line 600000)"
cat > "$CASE_DIR/wonder-woman.meta.json" <<'EOF'
{"taskKind": "subagent"}
EOF
run_hook "$(subagent_payload "$T_NAMED" false "in_process_teammate" "wonder-woman")"
check "agent_type is not used as the discriminator (silent despite the name)"  'is_silent "$OUT"'

# ---------------------------------------------------------------------------
# Case 12: nudge output never carries hookSpecificOutput/additionalContext/systemMessage
# ---------------------------------------------------------------------------
echo "Case 12: forbidden keys never appear in any nudging output"
for pair in "warn:$WARN_OUT" "severe:$SEVERE_OUT" "sidechain-severe:$SIDECHAIN_OUT" "teammate:$TEAM_OUT"; do
  label="${pair%%:*}"
  val="${pair#*:}"
  check "no hookSpecificOutput/additionalContext/systemMessage in $label output"  'is_block_shape "$val"'
done

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

echo ""
echo "----------------------------------------"
printf 'Result: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
