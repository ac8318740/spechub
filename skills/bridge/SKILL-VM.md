# Playwriter bridge – Linux / dev-VM runbook

> Stop reading if you are on Windows. This file is bash-only and assumes a
> Linux or macOS shell. Windows agents: read
> [`SKILL-WINDOWS.md`](SKILL-WINDOWS.md) instead.

## What the VM side owns

- An SSH service that accepts a reverse forward from the laptop and
  binds `127.0.0.1:19988` on this host.
- `agent-browser` (installed per the `browser-verify` skill) pointed at
  that endpoint via `agent-browser.json`.
- `vm-free-port.sh` for clearing a stuck port 19988 after a dropped
  session.
- An optional `sshd_config` tweak that reaps dead client sessions
  naturally.

The VM does **not** run the relay and does **not** run Chrome. Those
live on the laptop. See [`SKILL-WINDOWS.md`](SKILL-WINDOWS.md) if you
need to understand what the other side is doing.

## Architecture (from the VM's viewpoint)

```
laptop opens:
  ssh -N -R 19988:127.0.0.1:19988 <you>@<this-vm>

sshd on this VM then binds 127.0.0.1:19988 and forwards it back to the
laptop's 127.0.0.1:19988, where the Playwriter relay is listening.

agent-browser on this VM then speaks CDP against
  http://127.0.0.1:19988
and is driving a real Chrome on the laptop.
```

## Setup (once per VM)

### 1. Install agent-browser

See the `browser-verify` skill for the install command.

### 2. Create `agent-browser.json` in each project root

```json
{ "cdp": "19988" }
```

### 3. Accept the laptop's key

Append the laptop's SSH public key to `~/.ssh/authorized_keys`.

If the Windows side asks for a handoff to fix this (they typically will
during initial setup), confirm by running on this VM:

```bash
ssh-keygen -l -f ~/.ssh/authorized_keys | tail
```

and pasting the tail output back to the Windows agent as the handoff
"Report back".

### 4. Enable server-side keepalive (required in practice)

Dead SSH client sessions are the dominant cause of stuck port 19988.
Without these settings, abrupt Windows-side kills (laptop sleep, network
drop, `Stop-Process -Force` on the tunnel) leave orphan `sshd` forward
channels bound to the port, and the next tunnel attempt hits
`remote port forwarding failed` indefinitely.

Verify the config is in place on this VM:

```bash
sshd -T 2>/dev/null | grep -E '^(clientaliveinterval|clientalivecountmax)'
```

Expected output:

```
clientaliveinterval 30
clientalivecountmax 3
```

If either is absent or zero, append to `/etc/ssh/sshd_config`:

```
ClientAliveInterval 30
ClientAliveCountMax 3
```

Then reload:

```bash
sudo systemctl reload ssh || sudo systemctl reload sshd
```

Re-run the verify command above. Dead clients then get reaped in about
90 s and the reverse-forward socket releases naturally.

This is marked "required in practice" (not "recommended") because every
time this VM has seen the stuck-port cycle, the root cause was a missing
or unloaded keepalive. The Windows-side `tunnel.ps1` resilience cannot
fix a port that the server-side `sshd` refuses to release.

### 5. Install `vm-free-port.sh`

Copy from `plugins/spechub/assets/playwriter-bridge/vm-free-port.sh` to a
location on your `PATH` (or invoke it directly). Mark it executable:

```bash
chmod +x vm-free-port.sh
```

The script has a guardrail: it refuses to kill the port holder if that
holder is your own interactive SSH session. Scoped strictly to port
19988.

## Routine diagnostics on the VM

### Is the tunnel up?

```bash
ss -lnt 'sport = :19988'
```

If empty: the tunnel from the laptop is not connected. Produce a
VM-side handoff to the Windows agent – see [`HANDOFF.md`](HANDOFF.md).

### Does the relay respond?

```bash
curl -sS -m 3 http://127.0.0.1:19988/json/version
```

Playwriter-flavored JSON means the full path (tunnel + relay) is up.
Empty or timeout with a listener present on 19988 means the tunnel is
half-open – ask the Windows side to restart the tunnel task.

### Is the extension armed?

```bash
curl -sS -m 3 http://127.0.0.1:19988/json/list
```

`[]` means the extension is not attached to any tab. Ask the user to
click the Playwriter icon on a normal web page in the Playwriter Dev
Chrome profile. (This is a user action, not a coding-agent one, unless
a Windows agent is available to drive Chrome.)

### Smoke test

```bash
agent-browser open https://example.com
agent-browser screenshot /tmp/ok.png
```

## When port 19988 is stuck

Symptom: the Windows `tunnel-<this-host>.log` shows
`remote port forwarding failed for listen port 19988` repeatedly, or
`ss -lnt 'sport = :19988'` shows an `sshd` bound but the relay is
unreachable.

Run:

```bash
bash vm-free-port.sh
```

The script walks the situation and either clears the socket or refuses
with a clear reason. Common outcomes:

- **"port 19988 is already free"** – nothing to do. The Windows tunnel
  should reconnect within the backoff window.
- **"port is held by your own interactive session"** – you have an SSH
  session alive that is carrying the forward. Exit that session (from
  another terminal) and re-run.
- **Holder is a non-`sshd` process** – the script refuses. Something
  else (local test server, stray `nc`) is on 19988. Stop it manually.
- **Holder is an orphan `sshd` forward channel** – the script kills it.
  `ClientAliveInterval` would have prevented this; consider adding the
  config from step 4.

After clearing, confirm:

```bash
ss -lnt 'sport = :19988'
```

Should be empty.

## What you CANNOT do from the VM

- Restart the tunnel task. That is a Windows-side scheduled task. Emit
  a handoff block.
- Restart the relay. That lives on the laptop.
- Rearm the extension on a tab. That is a click in the user's Chrome.

For any of these, produce a `VM-SIDE HANDOFF` block per
[`HANDOFF.md`](HANDOFF.md) and hand it to the Windows agent (or tell the
user to paste it into PowerShell themselves).

## What this intentionally does NOT do

- **No relay on the VM.** The Playwriter extension hard-rejects any
  `/extension` client that is not `127.0.0.1`, so the relay must run
  next to Chrome.
- **No unprompted port scan.** `vm-free-port.sh` is scoped strictly to
  19988 and refuses anything ambiguous. Do not generalise it.
