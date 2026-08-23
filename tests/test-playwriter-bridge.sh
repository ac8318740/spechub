#!/usr/bin/env bash
# Guards the two PowerShell scripts of the Playwriter bridge that only ever run
# on the user's Windows laptop: tunnel.ps1 and doctor.ps1.
#
# Nothing here executes them. There is no PowerShell on the dev VM, and the
# behaviour that matters - a tunnel that keeps retrying for hours, a handoff
# block pasted into a shell on the other machine - is not something a unit test
# on this side could drive anyway. What it can do is read the scripts and pin
# the decisions their text encodes, which is where both of these last drifted.
#
# Run it:  bash tests/test-playwriter-bridge.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
TUNNEL="${ROOT}/assets/playwriter-bridge/tunnel.ps1"
DOCTOR="${ROOT}/assets/playwriter-bridge/doctor.ps1"
SYNC="${ROOT}/assets/playwriter-bridge/sync.ps1"
REGISTER="${ROOT}/assets/playwriter-bridge/register-tasks.ps1"

for f in "$TUNNEL" "$DOCTOR" "$SYNC" "$REGISTER"; do
  [ -f "$f" ] || { echo "FATAL: missing $f" >&2; exit 1; }
done

pass=0
fail=0
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# The switch branch that handles 'remote port forwarding failed', on its own.
# Everything asserted about giving up has to be asserted here rather than over
# the whole file: auth-denied and host-key still exit, and should.
stuck_branch="$(awk "/'stuck-port' \{/{f=1} /'auth-denied' \{/{f=0} f" "$TUNNEL")"
# The stuck path's own numbers: from where its retry budget is declared to the
# end of its branch. Deliberately starts after the transient backoff table, so
# the 120 in that table cannot answer for the stuck path's cap.
stuck_region="$(awk '/\$stuckRetrySeconds/{f=1} f' "$TUNNEL" | awk "/'auth-denied' \{/{exit} {print}")"

echo "tunnel.ps1: a wedged remote port is retried, never surrendered"

# The tunnel is a scheduled task with no keeper. Exiting hands recovery to
# whatever restarts it, which on a wedged port is a loop nobody watches - and
# between the exit and the restart the bridge is simply down. A port held by an
# orphaned forward channel is not a failure the user has to act on, so the
# script's job is to outlast it.
[ -n "$stuck_branch" ] || no "the stuck-port branch could not be located in tunnel.ps1"
if [ -n "$stuck_branch" ] && ! printf '%s\n' "$stuck_branch" | grep -qE '^[[:space:]]*exit\b'; then
  ok "no exit is reachable from the stuck-port branch"
else
  no "the stuck-port branch still exits rather than retrying"
fi

# exit 10 was the stuck-port give-up code specifically. Nothing else used it,
# so its presence anywhere in the file is the give-up path surviving.
if ! grep -qE '^[[:space:]]*exit[[:space:]]+10[[:space:]]*$' "$TUNNEL"; then
  ok "the stuck-port give-up code (exit 10) is gone"
else
  no "tunnel.ps1 still carries exit 10"
fi

# Retrying forever at a flat 30 s is a busy tunnel hammering a port that is not
# coming back for minutes. The wait has to grow, and it has to stop growing:
# 120 s is the cap the transient path already uses, and a stuck port that is
# never going to clear should cost no more than that per attempt.
if printf '%s\n' "$stuck_region" | grep -q '120'; then
  ok "the stuck-port wait states a 120 s cap"
else
  no "the stuck-port wait states no 120 s cap"
fi

# doctor.ps1 has no other way to know the tunnel is wedged: it reads the marker
# file. Retrying forever must not mean staying silent forever, so the marker is
# still written once the streak says the port is genuinely held.
if printf '%s\n' "$stuck_branch" | grep -q 'Write-Marker'; then
  ok "the stuck-port branch still writes the marker doctor.ps1 reads"
else
  no "the stuck-port branch no longer writes a marker"
fi

if printf '%s\n' "$stuck_branch" | grep -q 'stuckMaxStreak'; then
  ok "the marker is still gated on a streak of consecutive stuck attempts"
else
  no "nothing gates the marker on a streak of stuck attempts"
fi

# A marker that outlives the wedge is a doctor reporting red on a working
# bridge. Thirty seconds of uptime means the forward bound, which is the only
# evidence that the port came back.
if grep -q 'Remove-Item \$markerFile' "$TUNNEL" && grep -q 'ranSeconds -ge 30' "$TUNNEL"; then
  ok "a run lasting 30 s or more clears the stuck marker"
else
  no "nothing clears the stuck marker after a successful bind"
fi

echo "doctor.ps1: a stuck opener port is reported as the opener port"

# The opener's tunnel writes tunnel-<host>-19989.stuck. Stripping only the
# 'tunnel-' prefix leaves the host as '<host>-19989', which is not a machine
# anyone can ssh to, and loses the one detail that says which port is wedged.
parse="$(awk '/foreach \(\$f in \$stuckFiles\)/{f=1} f{print; n++} n>12{exit}' "$DOCTOR")"
[ -n "$parse" ] || no "the stuck-marker loop could not be located in doctor.ps1"
if [ -n "$parse" ] && printf '%s\n' "$parse" | grep -qE '\\d\+|\[0-9\]'; then
  ok "the marker parse separates a trailing -<port> from the host"
else
  no "the marker parse folds the port into the host name"
fi

# The handoff block is read by an agent on the VM that has no other context.
# Telling it 19988 when the wedged port is 19989 sends it to free a port that
# was never the problem.
handoff="$(awk '/foreach \(\$h in \$stuckHosts\)/{f=1} f{print} f && /END WINDOWS-SIDE HANDOFF/{exit}' "$DOCTOR")"
[ -n "$handoff" ] || no "the stuck handoff block could not be located in doctor.ps1"
if [ -n "$handoff" ] && ! printf '%s\n' "$handoff" | grep -q '19988'; then
  ok "the stuck handoff names the wedged port rather than hardcoding 19988"
else
  no "the stuck handoff hardcodes 19988"
fi

# vm-free-port.sh defaults to 19988, so a bare call is the wrong call whenever
# the marker was the opener's. The port has to travel with the instruction.
if grep -q -- '--port' "$DOCTOR"; then
  ok "doctor.ps1 tells the VM which port to free"
else
  no "doctor.ps1 asks for a bare vm-free-port.sh with no port"
fi

echo "doctor.ps1: a tunnel still retrying a held port is amber before it is red"

# Check 5 only. The whole file has other Add-Result calls in every colour, and
# 300 appears in timeouts elsewhere - neither can answer for this row.
log_region="$(awk '/---- Check 5/{f=1} f{print} f && /---- Check 6/{exit}' "$DOCTOR")"
[ -n "$log_region" ] || no "the tunnel-log check could not be located in doctor.ps1"

# The marker only lands after 8 consecutive stuck attempts, which is minutes of
# a down bridge before doctor.ps1 says anything at all. tunnel.ps1 logs
# [stuck-retry] on every one of those attempts, so the log is the earlier
# signal - and reading only tunnel-*.stuck cannot see it.
if printf '%s\n' "$log_region" | grep -q "tunnel-\*\.log" \
   && printf '%s\n' "$log_region" | grep -q 'stuck-retry'; then
  ok "doctor.ps1 reads tunnel-*.log for stuck-retry lines, not just markers"
else
  no "doctor.ps1 keys the tunnel row only on .stuck markers"
fi

# A log keeps its stuck-retry lines after the port clears. Without a recency
# window the row is amber forever on the strength of a wedge that resolved days
# ago, so the timestamp has to be compared against a 5 minute horizon.
if printf '%s\n' "$log_region" | grep -qE '\b300\b|AddMinutes\(\s*-5\s*\)|TotalMinutes[^0-9]*5\b'; then
  ok "the stuck-retry read is bounded by a 5 minute window"
else
  no "nothing bounds the stuck-retry read to a 5 minute window"
fi

# Red is the marker: the port is genuinely held and needs a human. A tunnel two
# attempts into its backoff may well bind on the next one. Reporting both the
# same way either cries wolf or buries the marker.
if printf '%s\n' "$log_region" | grep -q "Add-Result 'Tunnel logs' 'amber'" \
   && printf '%s\n' "$log_region" | grep -q "Add-Result 'Tunnel logs' 'red'"; then
  ok "a recent stuck-retry is amber while the marker stays red"
else
  no "the tunnel row has no amber verdict distinct from the red marker case"
fi

# Same trap as the handoff block: vm-free-port.sh defaults to 19988, so an
# amber row about the opener's 19989 that omits the port sends the VM agent to
# free a socket that was never wedged.
amber="$(printf '%s\n' "$log_region" | grep -B6 -A4 "Add-Result 'Tunnel logs' 'amber'")"
if [ -n "$amber" ] && printf '%s\n' "$amber" | grep -q 'vm-free-port.sh' \
   && printf '%s\n' "$amber" | grep -q -- '--port'; then
  ok "the amber remedy names vm-free-port.sh --port"
else
  no "the amber remedy does not name vm-free-port.sh --port"
fi

echo "sync.ps1: task stop/restart goes through Stop-BridgeTaskTree, not a bare stop/start"

# The function itself: from its declaration to the closing brace at column 0
# (nested blocks in its body are all indented, so that anchors the end).
sync_stop_fn="$(awk '/^function Stop-BridgeTaskTree/{f=1} f{print} f && /^}/{exit}' "$SYNC")"
[ -n "$sync_stop_fn" ] || no "Stop-BridgeTaskTree could not be located in sync.ps1"

# A bare Stop-ScheduledTask/Start-ScheduledTask pair races the scheduler: the
# stop is only queued, so the very next Start can hit a task that has not
# actually left Running yet. Stop-BridgeTaskTree exists to close that race, so
# every restart path has to route through it instead.
if [ -n "$sync_stop_fn" ]; then
  ok "sync.ps1 defines Stop-BridgeTaskTree"
else
  no "sync.ps1 has no Stop-BridgeTaskTree function"
fi

if printf '%s\n' "$sync_stop_fn" | grep -q "state -ne 'Running'"; then
  ok "Stop-BridgeTaskTree waits for the task to leave Running"
else
  no "Stop-BridgeTaskTree does not wait for the task to leave Running"
fi

if printf '%s\n' "$sync_stop_fn" | grep -q 'Win32_Process' \
   && printf '%s\n' "$sync_stop_fn" | grep -q 'Stop-Process'; then
  ok "Stop-BridgeTaskTree reaps surviving processes of the task's tree"
else
  no "Stop-BridgeTaskTree does not reap surviving processes"
fi

# The restart loop over $restartList: it has to stop through the function,
# never a bare Stop-ScheduledTask, before starting the task again.
restart_loop="$(awk '/foreach \(\$name in \$restartList\)/{f=1} f{print} f && /^}/{exit}' "$SYNC")"
[ -n "$restart_loop" ] || no "the restart loop over \$restartList could not be located in sync.ps1"
if [ -n "$restart_loop" ] && printf '%s\n' "$restart_loop" | grep -q 'Stop-BridgeTaskTree -Name \$name' \
   && ! printf '%s\n' "$restart_loop" | grep -q 'Stop-ScheduledTask -TaskName \$name'; then
  ok "the restart loop stops each task through Stop-BridgeTaskTree, not a bare Stop-ScheduledTask"
else
  no "the restart loop does not route through Stop-BridgeTaskTree"
fi

# The launcher-rebuild stop, taken to release launcher.exe before it is
# overwritten, is the other place sync.ps1 stops tasks - it has to go through
# the same function rather than its own bare Stop-ScheduledTask.
rebuild_stop="$(awk "/-and \\\$anyRunning\\)/{f=1} f{print} f && /^}/{exit}" "$SYNC")"
[ -n "$rebuild_stop" ] || no "the launcher-rebuild stop block could not be located in sync.ps1"
if [ -n "$rebuild_stop" ] && printf '%s\n' "$rebuild_stop" | grep -q 'Stop-BridgeTaskTree' \
   && ! printf '%s\n' "$rebuild_stop" | grep -q 'Stop-ScheduledTask -TaskName \$t'; then
  ok "the launcher-rebuild stop routes through Stop-BridgeTaskTree"
else
  no "the launcher-rebuild stop does not route through Stop-BridgeTaskTree"
fi

echo "register-tasks.ps1: task replace goes through Stop-BridgeTaskTree before Unregister-ScheduledTask"

reg_stop_fn="$(awk '/^function Stop-BridgeTaskTree/{f=1} f{print} f && /^}/{exit}' "$REGISTER")"
if [ -n "$reg_stop_fn" ]; then
  ok "register-tasks.ps1 defines Stop-BridgeTaskTree"
else
  no "register-tasks.ps1 has no Stop-BridgeTaskTree function"
fi

# Register-BridgeTask: when a task of the same name already exists, it has to
# be stopped and reaped BEFORE Unregister-ScheduledTask - unregistering a
# running task leaves its process tree alive and holding the port.
register_fn="$(awk '/^function Register-BridgeTask/{f=1} f{print} f && /^}/{exit}' "$REGISTER")"
[ -n "$register_fn" ] || no "Register-BridgeTask could not be located in register-tasks.ps1"
if [ -n "$register_fn" ]; then
  stop_line="$(printf '%s\n' "$register_fn" | grep -n 'Stop-BridgeTaskTree -Name \$Name' | head -1 | cut -d: -f1)"
  unreg_line="$(printf '%s\n' "$register_fn" | grep -n 'Unregister-ScheduledTask' | head -1 | cut -d: -f1)"
  if [ -n "$stop_line" ] && [ -n "$unreg_line" ] && [ "$stop_line" -lt "$unreg_line" ]; then
    ok "Register-BridgeTask calls Stop-BridgeTaskTree before Unregister-ScheduledTask"
  else
    no "Register-BridgeTask does not call Stop-BridgeTaskTree before Unregister-ScheduledTask"
  fi
fi

echo "register-tasks.ps1: the token push resolves the Windows OpenSSH ssh.exe rather than trusting PATH"

# A bare 'ssh' can resolve to the Git for Windows build on PATH, which cannot
# reach the Windows ssh-agent named pipe and fails with "Permission denied
# (publickey)" - so System32\OpenSSH\ssh.exe has to be tried first.
if grep -qE 'Join-Path \$env:WINDIR "System32\\OpenSSH\\ssh\.exe"' "$REGISTER"; then
  ok "register-tasks.ps1 resolves System32\\OpenSSH\\ssh.exe"
else
  no "register-tasks.ps1 does not resolve System32\\OpenSSH\\ssh.exe"
fi

resolve_line="$(grep -n 'System32\\OpenSSH\\ssh\.exe' "$REGISTER" | head -1 | cut -d: -f1)"
fallback_line="$(grep -n 'Get-Command ssh' "$REGISTER" | head -1 | cut -d: -f1)"
if [ -n "$resolve_line" ] && [ -n "$fallback_line" ] && [ "$resolve_line" -lt "$fallback_line" ]; then
  ok "the OpenSSH path is tried before the PATH fallback"
else
  no "the OpenSSH path is not tried before the PATH fallback"
fi

# The push itself has to invoke the resolved variable, not a bare 'ssh'.
push_region="$(awk '/foreach \(\$vm in \$VMs\)/{f=1} f{print} f && /^}/{exit}' "$REGISTER")"
[ -n "$push_region" ] || no "the token-push loop could not be located in register-tasks.ps1"
if [ -n "$push_region" ] && printf '%s\n' "$push_region" | grep -q '& \$sshExe' \
   && ! printf '%s\n' "$push_region" | grep -qE '&\s+ssh\s'; then
  ok "the token push invokes the resolved \$sshExe, not a bare ssh"
else
  no "the token push does not invoke the resolved ssh path"
fi

echo "register-tasks.ps1: tasks for VMs no longer in -VMs are reported, not silently removed"

# New behaviour, not yet implemented: after registering, existing
# Playwriter-Tunnel-* / Playwriter-OpenerTunnel-* tasks whose VM fell out of
# -VMs should be named in a warning, not unregistered. Scope everything below
# to that new block via the marker text it is expected to contain.
leftover_marker_line="$(grep -n 'not in -VMs' "$REGISTER" | head -1 | cut -d: -f1)"
if [ -n "$leftover_marker_line" ]; then
  leftover_block="$(tail -n "+${leftover_marker_line}" "$REGISTER")"
else
  leftover_block=""
fi

if [ -n "$leftover_marker_line" ]; then
  ok "register-tasks.ps1 has a block naming tasks not in -VMs"
else
  no "register-tasks.ps1 has no block naming tasks not in -VMs"
fi

if [ -n "$leftover_block" ] && printf '%s\n' "$leftover_block" | grep -q 'Playwriter-Tunnel-\*' \
   && printf '%s\n' "$leftover_block" | grep -q 'Playwriter-OpenerTunnel-\*'; then
  ok "the leftover-task listing covers both Playwriter-Tunnel-* and Playwriter-OpenerTunnel-* families"
else
  no "the leftover-task listing does not cover both task families"
fi

if [ -n "$leftover_block" ] && printf '%s\n' "$leftover_block" | grep -A2 -i 'Write-Warning' | grep -q -- '-VMs'; then
  ok "the leftover-task block warns, naming -VMs, for each leftover task"
else
  no "the leftover-task block does not warn about -VMs"
fi

if [ -n "$leftover_block" ] && ! printf '%s\n' "$leftover_block" | grep -q 'Unregister-ScheduledTask'; then
  ok "the leftover-task block does not unregister the leftover tasks"
else
  no "the leftover-task block unregisters leftover tasks, or the block could not be found"
fi

printf '\nResult: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
