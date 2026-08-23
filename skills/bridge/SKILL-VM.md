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

### 4. Enable server-side keepalive (required for self-heal)

When the laptop drops abruptly (sleep, network change, VPN flap), the
half-open SSH session leaves an `sshd` forward channel bound to port
19988, now orphaned. The VM only releases it once `sshd` reaps the
dead client, which takes `ClientAliveInterval × ClientAliveCountMax`
seconds. Until then the laptop's reconnect hits
`remote port forwarding failed`.

The Windows `tunnel.ps1` retries a stuck port forever. It waits 30 s, then
doubles the wait to a 120 s cap. The bridge therefore self-heals whenever
the reap happens. What keepalive changes is how long that takes:

- **Keepalive disabled** (`ClientAliveInterval 0`) – the orphan never
  reaps and the port stays wedged until someone frees it by hand. The
  tunnel keeps retrying, and writes `tunnel-<host>[-<port>].stuck` after
  8 consecutive stuck attempts (~11 min) so `doctor.ps1` reports it in red.
  Run `vm-free-port.sh` and the next attempt binds. You restart nothing.
- **Keepalive very loose** – recovery is slow. A default Azure / cloud
  image ships `ClientAliveInterval 120` (≈360 s reap); the runbook value
  of 30 (≈90 s) recovers about 4× faster.

Check the *effective* value. This needs root – the drop-in files under
`sshd_config.d/` are not world-readable, so a non-root `sshd -T` prints
nothing useful:

```bash
sudo sshd -T | grep -E '^(clientaliveinterval|clientalivecountmax)'
```

Want:

```
clientaliveinterval 30
clientalivecountmax 3
```

**Do not just append to `/etc/ssh/sshd_config`.** Cloud images set this
in a drop-in (e.g. `/etc/ssh/sshd_config.d/50-cloudimg-settings.conf`),
and sshd uses the *first* value it reads. The
`Include /etc/ssh/sshd_config.d/*.conf` line sits near the top of the
main config and globs in lexical order, so a later append loses to the
existing `50-` drop-in. Win by adding a drop-in that sorts *before* it:

```bash
printf 'ClientAliveInterval 30\nClientAliveCountMax 3\n' | \
  sudo tee /etc/ssh/sshd_config.d/10-playwriter-keepalive.conf
sudo systemctl reload ssh || sudo systemctl reload sshd
```

Re-run the `sudo sshd -T` check. Confirm it now reports 30 / 3.
If it still shows the loose value, this distro orders `Include`
differently. Edit the drop-in that set it instead of adding a new one.

### 5. The SessionStart hook auto-links `vm-free-port.sh`

The SpecHub SessionStart hook links the helper to an invariant path on
each Claude Code launch:

```
~/.claude/spechub/bin/vm-free-port.sh -> <plugin cache>/assets/playwriter-bridge/vm-free-port.sh
```

Invoke it by that path. The symlink always points at the current plugin
version, so the helper stays current with no manual copy. If you prefer a
copy on your `PATH` instead, copy the file and `chmod +x` it – but then you
own keeping it updated.

The script has a guardrail: it refuses to kill the port holder if that
holder is your own interactive SSH session. The guardrail scopes it
strictly to port 19988.

## Routine diagnostics on the VM

### Is the tunnel up?

```bash
ss -lnt 'sport = :19988'
```

If empty: the tunnel from the laptop has not connected. Produce a
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

`[]` means the extension has not attached to any tab. Ask the user to
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

The Windows agent sees this first. `doctor.ps1` turns its `Tunnel logs` row
amber as soon as `tunnel-*.log` carries a `stuck-retry` line under 5 minutes
old. The row names the host and the port. It goes red later, once the marker
lands. Either colour gives you the same instruction below.

Run:

```bash
bash ~/.claude/spechub/bin/vm-free-port.sh
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
- **Holder is an `sshd` forward channel, now orphaned** – the script
  kills it. `ClientAliveInterval` would have prevented this; consider
  adding the config from step 4.
- **"port 19988 is carrying a live tunnel"** – the script refuses and
  exits non-zero without killing anything. Before it looks at the holder
  at all it asks the port for an HTTP response, bounded at 3 seconds. Any
  answer counts as alive. It asks the port rather than the process because
  a non-root `ss` cannot name who owns someone else's socket. A 401 or a 404 comes from a CDP
  endpoint that is serving; only silence means a half-open forward.

That last refusal matters because the amber `Tunnel logs` row trails five
minutes behind the log line that raised it. A tunnel often wedges and then
heals itself while the row stays amber. So the ordinary way to reach this
script is to read advice about a forward that has already come back. Running
it then costs nothing.

No flag overrides the refusal. To free a port that a live forward holds,
close the session holding it: on the laptop, run `stop.ps1`.

After clearing, confirm:

```bash
ss -lnt 'sport = :19988'
```

Should be empty.

## What you CANNOT do from the VM

- **Rearm the extension on a tab.** That is a click in the user's Chrome,
  inside a third-party extension. Nothing on either machine can press it,
  and no amount of plumbing will change that.
- Restart the tunnel task, and restart the relay – *unless the opener is
  up*, in which case see the next section. Both are Windows-side scheduled
  tasks, so without the opener this machine cannot reach them.

For anything left, produce a `VM-SIDE HANDOFF` block per
[`HANDOFF.md`](HANDOFF.md). Hand it to the Windows agent, or tell the
user to paste it into PowerShell themselves.

## Restarting the laptop's tasks from here

When the **opener** is up, the two restarts above are no longer a handoff. The
opener is a small service on the laptop. It takes a page from this machine and
puts it in the default browser there. Because it runs on the laptop, it can also
restart the scheduled tasks this machine cannot reach. See section 8.6 of
`docs/terminal-workspace.md`.

```bash
spechub-bridge status            # both machines' view, including the tasks
spechub-bridge fix [relay|tunnel|both]
```

`fix` reports success only once the relay answers here again. A restart the
opener accepted is not a bridge that came back. When the opener is not reachable
either, `spechub-bridge` prints the `VM-SIDE HANDOFF` block for you rather than
leaving you to write one.

The opener still does not cover arming. Nothing changes that.

## What this intentionally does NOT do

- **No relay on the VM.** The Playwriter extension hard-rejects any
  `/extension` client that is not `127.0.0.1`, so the relay must run
  next to Chrome.
- **No unprompted port scan.** `vm-free-port.sh` scopes itself strictly
  to 19988 and refuses anything ambiguous. Do not generalise it.
