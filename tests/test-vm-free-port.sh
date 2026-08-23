#!/usr/bin/env bash
# Guards vm-free-port.sh, the VM-side clearer for a stuck reverse-forward port.
#
# Unlike the PowerShell suites next door, this script does run: it is bash, and
# every external command it reaches for - ss, ps, curl, kill - can be stubbed
# ahead of it on PATH. So the checks here drive the real control flow rather
# than reading the text and hoping.
#
# The behaviour under test: a holder on 19988 is not automatically garbage. An
# sshd forward channel that is still serving CDP is a live tunnel, and killing
# it takes the browser away from whoever is using it. So the script probes the
# port over HTTP first, and only kills when nothing answers.
#
# Run it:  bash tests/test-vm-free-port.sh
# Exit code is 0 when every check passes, 1 otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCRIPT_DIR}/.."
FREE="${ROOT}/assets/playwriter-bridge/vm-free-port.sh"

[ -f "$FREE" ] || { echo "FATAL: missing $FREE" >&2; exit 1; }

pass=0
fail=0
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/bin"
mkdir -p "$STUB"

# The holder is an sshd forward channel owned by nobody in this shell's
# ancestry: PID 999001, parent 999002, whose parent is init. Numbers this high
# cannot collide with the running shell's own $$ or $PPID, so the "that's your
# own SSH session" guardrail stays out of the way of what is being tested.
HOLDER_PID=999001
HOLDER_PPID=999002

cat > "$STUB/ss" <<'S'
#!/bin/sh
# First call reports the holder; later calls report a free port, so the
# post-kill settle loop terminates rather than timing out.
n=$(cat "$STUBWORK/ss.n" 2>/dev/null || echo 0)
echo $((n + 1)) > "$STUBWORK/ss.n"
[ "$n" = "0" ] || exit 0
printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:* users:(("sshd",pid=%s,fd=9))\n' \
  "$STUBPORT" "$STUBHOLDER"
S

cat > "$STUB/ps" <<'S'
#!/bin/sh
# Only the two forms vm-free-port.sh asks for: comm= and ppid=, both -p <pid>.
what=""; pid=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) what="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$what" in
  comm=) [ "$pid" = "$STUBHOLDER" ] && echo sshd || exit 1 ;;
  ppid=)
    if [ "$pid" = "$STUBHOLDER" ]; then echo " $STUBHOLDERPPID"
    elif [ "$pid" = "$STUBHOLDERPPID" ]; then echo " 1"
    else exit 1
    fi ;;
  *) exit 1 ;;
esac
S

cat > "$STUB/curl" <<'S'
#!/bin/sh
printf '%s\n' "$*" >> "$STUBWORK/curl.args"
if [ "$STUBPROBE" = "live" ]; then
  # A live CDP endpoint behind the tunnel. 401 is still an HTTP response, and
  # still means something is serving on the port.
  printf 'HTTP/1.1 401 Unauthorized\r\n\r\n401\n'
  exit 0
fi
# Nothing on the other end of a half-open forward: connection reset.
exit 7
S

cat > "$STUB/kill" <<'S'
#!/bin/sh
# -0 is a liveness query, not a signal, so it is not what "did it kill?" means.
if [ "${1:-}" = "-0" ]; then
  [ "$STUBPARENTALIVE" = "1" ] && exit 0 || exit 1
fi
printf '%s\n' "$*" >> "$STUBWORK/kill.log"
exit 0
S

printf '#!/bin/sh\nexit 0\n' > "$STUB/sleep"
printf '#!/bin/sh\nexit 1\n' > "$STUB/loginctl"
printf '#!/bin/sh\nexit 1\n' > "$STUB/sudo"
chmod +x "$STUB"/*

# kill is a shell builtin, so a stub on PATH would never be consulted. BASH_ENV
# is sourced by every non-interactive bash at startup, which is where the
# builtin gets switched off - the script itself is not touched.
cat > "$WORK/bashenv" <<'S'
enable -n kill
S

# run_case <live|dead> <parent-alive 0|1> - drive the script under the stubs.
# Leaves $rc, $out (stdout+stderr merged), and the kill/curl logs behind.
run_case() {
  rm -f "$WORK/ss.n"
  : > "$WORK/kill.log"
  : > "$WORK/curl.args"
  out=$(env -i PATH="$STUB:/usr/bin:/bin" HOME="$WORK" BASH_ENV="$WORK/bashenv" \
        STUBWORK="$WORK" STUBPORT=19988 STUBHOLDER="$HOLDER_PID" \
        STUBHOLDERPPID="$HOLDER_PPID" STUBPROBE="$1" STUBPARENTALIVE="$2" \
        timeout 30 bash "$FREE" 2>&1)
  rc=$?
}

echo "vm-free-port.sh: a port that is still serving is not a port to clear"

# The failure this prevents: the tunnel is up and working, someone runs the
# clearer out of habit, and the browser session dies. An HTTP answer within 3 s
# - any answer, 401 and 404 included - is proof the forward is carrying traffic.
run_case live 1
if printf '%s' "$out" | grep -qi 'carrying a live tunnel'; then
  ok "a live probe refuses in the words 'carrying a live tunnel'"
else
  no "a live probe does not say 'carrying a live tunnel' (rc=$rc, out: $(printf '%s' "$out" | tr '\n' '|'))"
fi

if [ "$rc" -ne 0 ]; then
  ok "a live probe exits non-zero"
else
  no "a live probe exits 0, so a caller cannot tell the port was left alone"
fi

if [ ! -s "$WORK/kill.log" ]; then
  ok "a live probe kills nothing"
else
  no "a live probe still killed: $(tr '\n' '|' < "$WORK/kill.log")"
fi

if [ -s "$WORK/curl.args" ] && grep -q '19988' "$WORK/curl.args"; then
  ok "the probe is an HTTP request to the port itself"
else
  no "no HTTP probe of 19988 was made (curl calls: $(tr '\n' '|' < "$WORK/curl.args"))"
fi

# Unbounded, the probe hangs the clearer on exactly the wedged socket it was
# called to clear. 3 s is the budget.
if grep -qE '(--max-time|-m|--connect-timeout)[= ]+3([^0-9]|$)' "$WORK/curl.args"; then
  ok "the probe is bounded at 3 s"
else
  no "the probe states no 3 s bound (curl calls: $(tr '\n' '|' < "$WORK/curl.args"))"
fi

# -f makes curl exit non-zero on 401 and 404, which would read a guarded but
# perfectly live CDP endpoint as dead and kill it.
if [ -s "$WORK/curl.args" ] && ! grep -qE '(^| )(-[a-zA-Z]*f[a-zA-Z]*|--fail)( |$)' "$WORK/curl.args"; then
  ok "the probe does not use --fail, so 401 and 404 still count as alive"
else
  no "the probe uses --fail, so an authenticated or 404-ing endpoint reads as dead"
fi

echo ""
echo "vm-free-port.sh: a forward with nothing behind it is still cleared"

# The original job. No HTTP response means a half-open forward channel: sshd
# holds the socket, the client that opened it is gone.
run_case dead 1
if grep -q "^${HOLDER_PID}\$" "$WORK/kill.log"; then
  ok "a dead probe kills the sshd holder"
else
  no "a dead probe did not kill the holder (rc=$rc, kills: $(tr '\n' '|' < "$WORK/kill.log"), out: $(printf '%s' "$out" | tr '\n' '|'))"
fi

if [ "$rc" -eq 0 ]; then
  ok "a dead probe exits 0 once the port is free"
else
  no "a dead probe exits $rc after freeing the port (out: $(printf '%s' "$out" | tr '\n' '|'))"
fi

# An orphan whose parent has already gone is the same situation, and must not
# take a different path just because kill -0 on the parent fails.
run_case dead 0
if grep -q "^${HOLDER_PID}\$" "$WORK/kill.log"; then
  ok "an orphaned holder with a dead parent is killed too"
else
  no "an orphaned holder with a dead parent was not killed (rc=$rc, out: $(printf '%s' "$out" | tr '\n' '|'))"
fi

echo ""
echo "vm-free-port.sh: no override for the live-tunnel refusal"

# The refusal is the whole point. A flag that skips it turns back into the
# habit it was written to stop, and the honest way past a live tunnel is to
# close the session holding it.
if ! grep -q -- '--force' "$FREE"; then
  ok "no --force flag exists to skip the probe"
else
  no "vm-free-port.sh grew a --force flag"
fi

printf '\nResult: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
