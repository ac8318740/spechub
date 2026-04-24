#!/usr/bin/env bash
# vm-free-port.sh – VM-side cleanup for a stuck reverse-forward port.
#
# When the Windows tunnel repeatedly hits "remote port forwarding failed
# for listen port 19988", this script identifies what holds 127.0.0.1:19988
# on the VM and – if safe – kills it.
#
# Guardrail: refuses to kill if the socket is held by the current user's
# own interactive SSH session. Killing that would drop the shell running
# the script.
#
# Scoped strictly to port 19988. Exits non-zero with a clear message on
# any ambiguous or unsafe situation.
#
# Intended to be invoked via the handoff block produced by Windows-side
# doctor.ps1. Safe to run at any time; no-ops if the port is already free.

set -u

PORT=19988

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { log "ERROR: $*" >&2; }

# Inspect 127.0.0.1:$PORT – print owner PID, process name, and parent PID.
find_holder() {
    ss -H -lntp "sport = :$PORT" 2>/dev/null | head -n1
}

line=$(find_holder)
if [ -z "$line" ]; then
    log "port $PORT is already free. Nothing to do."
    exit 0
fi

log "current holder: $line"

# ss -lntp line format includes users:(("<name>",pid=<pid>,fd=<fd>))
pid=$(printf '%s' "$line" | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2)
if [ -z "${pid:-}" ]; then
    err "could not parse PID from ss output. Run: sudo ss -lntp 'sport = :$PORT'"
    exit 2
fi

pname=$(ps -o comm= -p "$pid" 2>/dev/null || true)
ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
log "PID $pid ($pname), parent PID $ppid"

# Guardrail: is this process part of the current user's active SSH session?
# If the holder (or any ancestor) is our own sshd session leader, refuse.
current_sid=$(loginctl show-session "$(loginctl | awk -v u="$(id -un)" '$3==u {print $1; exit}')" -p Leader --value 2>/dev/null || true)

# Walk ancestors of the holder. If we meet $$ (this script's own shell) or
# its session leader, it's us.
own_tree=0
cursor=$pid
for _ in 1 2 3 4 5 6 7 8; do
    [ -z "$cursor" ] && break
    [ "$cursor" = "1" ] && break
    if [ "$cursor" = "$$" ] || [ "$cursor" = "$PPID" ]; then
        own_tree=1
        break
    fi
    if [ -n "${current_sid:-}" ] && [ "$cursor" = "$current_sid" ]; then
        own_tree=1
        break
    fi
    cursor=$(ps -o ppid= -p "$cursor" 2>/dev/null | tr -d ' ' || true)
done

if [ "$own_tree" = "1" ]; then
    err "port $PORT is held by your own interactive session (PID $pid, ancestor of this shell)."
    err "Killing it would drop the SSH session running this script."
    err "Exit this SSH session from another shell, or close the client, then retry."
    exit 3
fi

# Prefer not to kill anything that is not sshd – surface it for review.
if [ "$pname" != "sshd" ] && [ "$pname" != "sshd-session" ]; then
    err "holder is '$pname', not sshd. Refusing to kill a non-sshd process on port $PORT."
    err "If this is expected (e.g. a local test server), stop it manually."
    exit 4
fi

# Check parent liveness: an orphan sshd forward channel typically has a
# parent that has exited or has been re-parented.
if [ -n "${ppid:-}" ] && [ "$ppid" != "1" ]; then
    if ! kill -0 "$ppid" 2>/dev/null; then
        log "parent PID $ppid is gone – holder is an orphan sshd forward channel."
    else
        log "parent PID $ppid is alive – holder is an active sshd session, likely a stale tunnel that has not yet been reaped by ClientAlive."
    fi
fi

log "killing PID $pid ..."
if kill "$pid" 2>/dev/null; then
    :
else
    log "kill failed without privilege; retrying with sudo."
    if ! sudo -n kill "$pid" 2>/dev/null; then
        err "could not kill PID $pid. Re-run with sudo, or ask the admin to kill it."
        exit 5
    fi
fi

# Give the kernel a moment to release the socket.
for _ in 1 2 3 4 5; do
    sleep 1
    if [ -z "$(find_holder)" ]; then
        log "port $PORT is now free."
        exit 0
    fi
done

err "port $PORT still held after kill. Current state:"
ss -lntp "sport = :$PORT" >&2 || true
exit 6
