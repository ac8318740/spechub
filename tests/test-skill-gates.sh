#!/usr/bin/env bash
# Guards the lead-session check that opens the handoff and compact-and-continue
# skills.
#
# Both skills refuse to run outside the lead session, because both write state
# the lead alone owns: the context-pressure quiet marker, keyed on
# CLAUDE_CODE_SESSION_ID, and the shared spechub/HANDOFF.md anchor.
#
# The first version of that check read an environment variable, and the variable
# does not mean what it looked like it meant (#146). Claude Code sets
# CLAUDE_CODE_CHILD_SESSION=1 in EVERY Bash tool subprocess, lead or child - it
# marks "spawned by Claude Code", nothing more. So the check answered "child" in
# every session and neither skill could run. An in-process child is measurably
# indistinguishable by environment: it shares the lead's
# CLAUDE_CODE_SESSION_ID, CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT.
#
# What does distinguish them is on disk. A lead's transcript is
# <project>/<session>.jsonl; a subagent's or teammate's is
# <project>/<session>/subagents/agent-*.jsonl. So an agent that puts a unique
# mark in its own command can ask which transcript holds it.
#
# The host writes the record carrying that command WHILE the command runs,
# roughly four seconds in, so the check polls rather than greps once. That is
# the property most at risk from a well-meaning simplification, and Case 3
# below is what catches its removal.
#
# The checks extract the command from each SKILL.md - the block after the
# <!-- lead-check --> marker - and RUN it against fixture transcript layouts, so
# they drive the real control flow rather than reading the prose and hoping.
#
# Run it:  bash tests/test-skill-gates.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
HANDOFF="${ROOT}/skills/handoff/SKILL.md"
COMPACT="${ROOT}/skills/compact-and-continue/SKILL.md"

for f in "$HANDOFF" "$COMPACT"; do
  [ -f "$f" ] || { echo "FATAL: missing $f" >&2; exit 1; }
done

pass=0
fail=0
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MARK="spechub-whoami-9d3b7a1f"

# The real check waits up to ten seconds for its own record to appear. Stub
# sleep away so the loop still runs its full twenty turns and the suite still
# finishes in milliseconds. Stubbing rather than shortening the loop keeps the
# extracted command byte-identical to what ships.
STUB="$WORK/bin"
mkdir -p "$STUB"
printf '#!/bin/sh\nexit 0\n' > "$STUB/sleep"
chmod +x "$STUB/sleep"

# Pull the fenced bash block that follows the <!-- lead-check --> marker, with
# the skill's <nonce> placeholder replaced by this suite's mark. The marker is
# an HTML comment, so it is invisible where the skill renders and stable to
# grep. It names this file, so an editor who moves it knows what breaks.
extract_check() {
  awk '
    /<!-- lead-check/       { seen = 1 }
    seen && /^```bash$/     { inblock = 1; next }
    inblock && /^```$/      { exit }
    inblock                 { print }
  ' "$1" | sed "s/spechub-whoami-<nonce>/$MARK/g"
}

# Build a fake ~/.claude/projects tree at $1 for session $2, under project
# directory $3, then place the mark where the remaining arguments say:
#
#   lead          the mark goes in <session>.jsonl, where a real lead's own
#                 record lands
#   agent:<name>  the mark goes in subagents/agent-<name>.jsonl, where a real
#                 subagent's or teammate's record lands
#   decoy:<name>  an agent transcript WITHOUT the mark, so the grep has files
#                 to walk past
#   meta:<name>   the mark goes in subagents/agent-<name>.meta.json, the
#                 sidecar the host writes beside every agent transcript. The
#                 agent-*.jsonl glob must never read it
#
# Records carry the mark inside a tool_use command, which is the shape the host
# actually writes. The check is a plain substring grep, so the shape does not
# change today's result - it stops the fixture teaching a future reader a
# record layout that does not exist.
make_home() {
  local home="$1" session="$2" repo="$3"; shift 3
  local proj="$home/.claude/projects/$repo"
  mkdir -p "$proj/$session/subagents"
  : > "$proj/$session.jsonl"
  local spec name
  for spec in "$@"; do
    name="${spec#*:}"
    case "$spec" in
      lead)       record "$MARK" >> "$proj/$session.jsonl" ;;
      agent:*)    record "$MARK" >> "$proj/$session/subagents/agent-$name.jsonl" ;;
      decoy:*)    record "nothing-to-see" >> "$proj/$session/subagents/agent-$name.jsonl" ;;
      meta:*)     printf '{"agentType":"general-purpose","description":"%s"}\n' "$MARK" \
                    > "$proj/$session/subagents/agent-$name.meta.json"
                  record "nothing-to-see" > "$proj/$session/subagents/agent-$name.jsonl" ;;
      *)          echo "FATAL: unknown fixture spec '$spec'" >&2; exit 1 ;;
    esac
  done
}

# One transcript record carrying $1 inside a Bash tool_use, as the host writes it.
record() {
  printf '{"parentUuid":null,"isSidechain":true,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"n=%s"}}]}}\n' "$1"
}

# Run an extracted check with HOME and CLAUDE_CODE_SESSION_ID pointed at a
# fixture, and with the sleep stub ahead of the real one. Sets OUT to its
# stdout, with trailing newlines stripped by the command substitution, and RC
# to its exit status.
run_check() {
  local script="$1" home="$2" session="$3"
  OUT="$(PATH="$STUB:$PATH" HOME="$home" CLAUDE_CODE_SESSION_ID="$session" bash "$script" 2>/dev/null)"
  RC="$?"
}

# Cases 3 onward run BOTH extracted blocks even though Case 2 asserts they are
# byte-identical. The assertion is what makes that redundant, and the assertion
# is the thing most likely to be deleted by someone who decides the two skills
# should diverge. Running both means the behavioural cases keep their meaning
# on that day.
both() { echo "handoff:$H_CHECK compact:$C_CHECK"; }

# ---------------------------------------------------------------------------
# Case 1: no skill BRANCHES on CLAUDE_CODE_CHILD_SESSION
# ---------------------------------------------------------------------------
# The variable is set in every Bash subprocess, so a skill that branches on it
# has written a branch that can only go one way. Naming it in prose is fine and
# wanted - that is how the next reader learns not to reach for it - so the rule
# is about the runnable blocks: extract every fenced bash block from every
# skill and let none of them mention it.
echo "Case 1: no runnable skill block reads CLAUDE_CODE_CHILD_SESSION"
bash_blocks() {
  awk '
    /^```bash$/ { inblock = 1; next }
    inblock && /^```$/ { inblock = 0; next }
    inblock { print }
  ' "$1"
}
offenders=""
for f in "$ROOT"/skills/*/SKILL.md; do
  if bash_blocks "$f" | grep -q 'CLAUDE_CODE_CHILD_SESSION'; then
    offenders="$offenders $(basename "$(dirname "$f")")"
  fi
done
if [ -n "$offenders" ]; then
  no "a runnable block still reads CLAUDE_CODE_CHILD_SESSION:$offenders"
else
  ok "no runnable block reads CLAUDE_CODE_CHILD_SESSION"
fi

# The old gate's exact shape, in case someone reinstates it outside a fenced
# block - the original lived in a prose sentence, not a code block.
if grep -rqE '\[ -[nz] "\$\{?CLAUDE_CODE_CHILD_SESSION' "$ROOT/skills"; then
  no "a skill still tests CLAUDE_CODE_CHILD_SESSION with [ -n ] or [ -z ]"
else
  ok "no skill tests the variable with [ -n ] or [ -z ]"
fi

# ---------------------------------------------------------------------------
# Case 2: both skills carry an extractable lead check
# ---------------------------------------------------------------------------
echo "Case 2: both skills carry a runnable lead check"
H_CHECK="$WORK/handoff-check.sh"
C_CHECK="$WORK/compact-check.sh"
extract_check "$HANDOFF" > "$H_CHECK"
extract_check "$COMPACT" > "$C_CHECK"
check "handoff carries a <!-- lead-check --> block"           '[ -s "$H_CHECK" ]'
check "compact-and-continue carries one too"                  '[ -s "$C_CHECK" ]'
check "the two blocks are the same check"                     'diff -q "$H_CHECK" "$C_CHECK" >/dev/null'
# Without this, a renamed placeholder makes sed a no-op, Case 3 still passes
# for the wrong reason and Case 4 fails pointing at the wrong thing.
check "the <nonce> placeholder was substituted"               'grep -q "$MARK" "$H_CHECK"'
check "the block names the session-id variable"               'grep -q CLAUDE_CODE_SESSION_ID "$H_CHECK"'

# Nothing below can mean anything if the blocks did not extract. This fatal
# path prints a Result line, unlike the missing-file one at the top of the
# file, so run-all.sh reports a failed check rather than a broken suite.
if [ ! -s "$H_CHECK" ] || [ ! -s "$C_CHECK" ]; then
  printf '\nResult: %d passed, %d failed\n' "$pass" "$((fail + 1))"
  echo "FATAL: no lead-check block to run; skipping the behavioural cases" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Case 3: the check waits for its own record instead of grepping once
# ---------------------------------------------------------------------------
# The host writes the record carrying the command WHILE the command runs. A
# single grep runs before that record exists, finds nothing and answers "lead"
# for everyone - which is the shape of the bug this whole check replaced. The
# loop is therefore load-bearing, and nothing else in this suite would notice
# its removal, because every fixture below has its mark on disk already.
echo "Case 3: the check polls rather than grepping once"
check "the block loops"                       'grep -qE "^for |^while " "$H_CHECK"'
check "the loop sleeps between attempts"      'grep -q "sleep" "$H_CHECK"'
check "the loop runs more than one attempt"   'grep -qE "seq 1 ([2-9]|[1-9][0-9])" "$H_CHECK"'

# Two properties of the command that no fixture can exercise, because both are
# about shells this suite does not run under.
#
# A user profile with `shopt -s nullglob` deletes an unmatched glob, and grep
# with no file arguments then reads stdin: it blocks on an open pipe, or worse,
# answers from whatever stdin holds. </dev/null is what keeps a missing
# subagents directory answering "lead" instead of hanging.
check "every grep closes its stdin"  '[ "$(grep -c "grep .*</dev/null" "$H_CHECK")" -eq "$(grep -c "grep " "$H_CHECK")" ]'

# The placeholder is angle-bracketed on purpose. `n=x-<nonce>` is a bash syntax
# error, so an agent that pastes the block without substituting gets a loud
# parse failure. A bare token such as NONCE would run, and would match every
# transcript in the session that had already read this file - which is a real
# lead being told "child", the exact shape of #146.
raw_block() { extract_check_raw "$1" | grep -m1 '^n='; }
extract_check_raw() {
  awk '
    /<!-- lead-check/   { seen = 1 }
    seen && /^```bash$/ { inblock = 1; next }
    inblock && /^```$/  { exit }
    inblock             { print }
  ' "$1"
}
check "the handoff nonce placeholder is angle-bracketed"  '[ "$(raw_block "$HANDOFF")" = "n=spechub-whoami-<nonce>" ]'
check "the compact nonce placeholder matches"             '[ "$(raw_block "$COMPACT")" = "n=spechub-whoami-<nonce>" ]'
check "an unsubstituted block is a bash syntax error"     '! bash -n <(extract_check_raw "$HANDOFF") 2>/dev/null'

# ---------------------------------------------------------------------------
# Case 4: a lead is recognised as a lead
# ---------------------------------------------------------------------------
# The case the old gate got wrong, and the only one users actually hit: an
# ordinary interactive session, whose mark lands in its own session transcript
# and in no agent transcript.
echo "Case 4: a lead session is recognised as the lead"
SESS="sess-lead"
make_home "$WORK/h-lead" "$SESS" -fixture-repo lead decoy:aaa decoy:bbb
for pair in $(both); do
  label="${pair%%:*}"; script="${pair#*:}"
  run_check "$script" "$WORK/h-lead" "$SESS"
  check "$label reports lead for a lead session"       '[ "$OUT" = "lead" ]'
  check "$label exits 0 for a lead session"            '[ "$RC" -eq 0 ]'
done

# ---------------------------------------------------------------------------
# Case 5: a child is recognised as a child
# ---------------------------------------------------------------------------
echo "Case 5: a subagent or teammate is recognised as a child"
SESS="sess-child"
make_home "$WORK/h-child" "$SESS" -fixture-repo agent:ce443a decoy:aaa
for pair in $(both); do
  label="${pair%%:*}"; script="${pair#*:}"
  run_check "$script" "$WORK/h-child" "$SESS"
  check "$label reports child for an agent transcript"  'case "$OUT" in child:*) true ;; *) false ;; esac'
  check "$label names the transcript it found"          'case "$OUT" in *agent-ce443a.jsonl) true ;; *) false ;; esac'
done

# ---------------------------------------------------------------------------
# Case 6: the agent transcripts win over the session transcript
# ---------------------------------------------------------------------------
# A mark can reach the session transcript as well - a launcher that wrote the
# nonce into a prompt records it there. The agent transcripts must decide, and
# the verdict must stay a single line naming a single file.
echo "Case 6: the verdict comes from the agent transcripts"
SESS="sess-both"
make_home "$WORK/h-both" "$SESS" -fixture-repo lead agent:ce443a
for pair in $(both); do
  label="${pair%%:*}"; script="${pair#*:}"
  run_check "$script" "$WORK/h-both" "$SESS"
  check "$label still reports child when both hold the mark"  'case "$OUT" in child:*) true ;; *) false ;; esac'
  check "$label reports exactly one line"                     '[ "$(printf "%s\n" "$OUT" | wc -l)" -eq 1 ]'
  check "$label never names the session transcript"           'case "$OUT" in *"$SESS.jsonl"*) false ;; *) true ;; esac'
done

# ---------------------------------------------------------------------------
# Case 7: one mark, many neighbouring files
# ---------------------------------------------------------------------------
# A busy lead accumulates a transcript per agent it launched, plus a
# .meta.json sidecar beside each one. Only the transcript holding this agent's
# own mark may answer, and the sidecars must stay unread however they read.
echo "Case 7: decoys and .meta.json sidecars do not confuse the verdict"
SESS="sess-busy"
make_home "$WORK/h-busy" "$SESS" -fixture-repo decoy:aaa meta:bbb agent:ccc decoy:ddd
run_check "$H_CHECK" "$WORK/h-busy" "$SESS"
check "the mark's own transcript is the only answer" \
  '[ "$OUT" = "child: $WORK/h-busy/.claude/projects/-fixture-repo/$SESS/subagents/agent-ccc.jsonl" ]'

SESS="sess-metaonly"
make_home "$WORK/h-metaonly" "$SESS" -fixture-repo meta:bbb
run_check "$H_CHECK" "$WORK/h-metaonly" "$SESS"
check "a mark in a .meta.json sidecar alone never says child"  '[ "$OUT" = "lead" ]'

# ---------------------------------------------------------------------------
# Case 8: one session id, two project directories
# ---------------------------------------------------------------------------
# A session that changes working directory writes under a second project
# directory for the same session id, and spechub ships new-worktree, so this is
# an ordinary flow here. A check that resolved one directory and searched only
# that one would pick whichever sorts first and report "lead" for a real child.
echo "Case 8: a session id under two project directories still resolves"
SESS="sess-moved"
make_home "$WORK/h-moved" "$SESS" -aaa-first-repo decoy:aaa
make_home "$WORK/h-moved" "$SESS" -zzz-second-repo agent:ccc
run_check "$H_CHECK" "$WORK/h-moved" "$SESS"
check "the child is found in the later project directory" \
  '[ "$OUT" = "child: $WORK/h-moved/.claude/projects/-zzz-second-repo/$SESS/subagents/agent-ccc.jsonl" ]'

# ---------------------------------------------------------------------------
# Case 9: no evidence means lead
# ---------------------------------------------------------------------------
# Transcript saving off, a host that writes none, an unset session id: the
# check finds nothing and the skill proceeds. Failing closed is what produced
# #146 - a check with no real evidence answered "child" and made both skills
# unrunnable everywhere - so absence of evidence must read as "lead".
echo "Case 9: with no transcript on disk, the check says lead"
mkdir -p "$WORK/h-empty"
for pair in $(both); do
  label="${pair%%:*}"; script="${pair#*:}"
  run_check "$script" "$WORK/h-empty" "sess-missing"
  check "$label reports lead when no project tree exists"  '[ "$OUT" = "lead" ]'
  check "$label exits 0 when no project tree exists"       '[ "$RC" -eq 0 ]'
done

SESS="sess-nosid"
make_home "$WORK/h-nosid" "$SESS" -fixture-repo agent:ccc
run_check "$H_CHECK" "$WORK/h-nosid" ""
check "an unset session id reports lead, not a stray match"  '[ "$OUT" = "lead" ]'

# ---------------------------------------------------------------------------
# Case 10: the quiet marker still gets written
# ---------------------------------------------------------------------------
# The lead check exists to protect this write. A fix that removed the write
# instead of the broken gate would pass every case above and still leave the
# context-pressure hook nudging forever.
echo "Case 10: both skills still write the context-pressure quiet marker"
for pair in "handoff:$HANDOFF" "compact:$COMPACT"; do
  label="${pair%%:*}"; f="${pair#*:}"
  check "$label keys the marker on the session id"     'grep -q "CLAUDE_CODE_SESSION_ID}.quiet" "$f"'
  check "$label reads SPECHUB_CONTEXT_PRESSURE_DIR"    'grep -q SPECHUB_CONTEXT_PRESSURE_DIR "$f"'
done

printf '\nResult: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
