# Playwriter bridge – Windows laptop setup

How to drive a real Chrome browser running on your Windows laptop from
`agent-browser` (and any other CDP client) running on a remote Linux VM.

This is the persistent, zero-window Windows setup: three scheduled tasks
running at logon as LogonType `S4U`, ssh-agent holding your key across
reboots, auto-reconnecting relay and tunnel. One-time admin to register the
tasks; after that, log in and the bridge is up.

## Architecture

```
WINDOWS LAPTOP                                         LINUX VM
──────────────                                         ────────
Chrome ("Playwriter Dev" profile)
  + Playwriter extension (drives via chrome.debugger API)
       │ localhost WebSocket
       ▼
playwriter serve --host 127.0.0.1  ◄── listens on 127.0.0.1:19988 (Node relay)
       ▲
       │ outbound reverse SSH from laptop
       │ ssh -N -R 19988:127.0.0.1:19988 user@vm
       │
   VM sshd binds 127.0.0.1:19988
                        │
                        ▼
             agent-browser --cdp http://127.0.0.1:19988
```

No debug port is opened on Chrome. No inbound listener on the laptop. The
only laptop-to-VM connection is outbound SSH. The VM talks to a plain-looking
CDP endpoint at `localhost:19988`, unaware that the actual browser is on the
laptop.

## Why this shape

- **Chrome runs normally.** Driving it through the Playwriter extension's
  `chrome.debugger` API means no `--remote-debugging-port` on Chrome itself.
- **Relay lives on the laptop.** The Playwriter Chrome extension dials
  `localhost:19988` and that binding is hard-coded – the relay must be on the
  same host as Chrome. Do not invert.
- **Outbound SSH only.** The laptop initiates the tunnel; `-R` asks the VM to
  forward its local traffic back. No inbound ports, no ControlMaster, no
  piggybacking on your editor's SSH session.

## Prerequisites

- Windows 10/11 laptop
- A Linux (or similar) dev VM reachable by SSH from the laptop
- Chrome installed on the laptop
- An SSH keypair you use to reach the VM

## Windows laptop setup

Run these from a normal (non-elevated) PowerShell unless a step says otherwise.

### 1. Install Node.js LTS

```powershell
winget install OpenJS.NodeJS.LTS
```

Open a new PowerShell so `node` and `npm` are on `PATH`.

### 2. Install the Playwriter CLI

```powershell
npm install -g playwriter
```

Confirm:

```powershell
playwriter --version
```

### 3. Install the Playwriter Chrome extension (dedicated profile)

Create a new Chrome profile – name it something like "Playwriter Dev". Do
**not** sign in to any sensitive accounts on this profile. It exists so that
a compromised VM can only drive this profile, not your real browser.

In that profile, install the extension from the Chrome Web Store:

```
https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe
```

Pin the extension to the toolbar. You will click its icon once per tab you
want the VM to be able to automate.

### 4. Enable ssh-agent (from elevated PowerShell, once)

The scheduled tasks run non-interactively. The ssh-agent service holds your
decrypted key so the tunnel can authenticate without prompting.

```powershell
Set-Service ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Add your key once (in any PowerShell – will prompt for the passphrase):

```powershell
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

Windows OpenSSH persists the key DPAPI-encrypted in
`HKLM\SOFTWARE\OpenSSH\Agent\Keys` so it survives reboots. You only do this
once.

### 5. Drop the bridge scripts in place

Copy the three scripts from this plugin into `%USERPROFILE%\playwriter-bridge\`:

- `relay.ps1`
- `tunnel.ps1`
- `register-tasks.ps1`

They live in the plugin at `plugins/spechub/assets/playwriter-bridge/`.

### 6. Register the scheduled tasks (from elevated PowerShell, once)

S4U task registration requires admin. Runtime does not – after registration,
the tasks run as your normal user.

```powershell
cd $env:USERPROFILE\playwriter-bridge
.\register-tasks.ps1 -VMs @("vm1.example.com", "vm2.internal")
```

Pass every VM you want a tunnel to. Add `-TunnelUser dev` if your SSH
username on the VMs is not the same as your Windows username.

The script:

1. Checks it's elevated (fails fast with a clear message if not).
2. Registers `Playwriter-Relay` plus one `Playwriter-Tunnel-VM<N>` per VM.
3. Kicks them off immediately.

All three tasks run at user logon from now on, with a 5-second reconnect
loop. Logs land in `%LOCALAPPDATA%\playwriter-bridge\`.

### Why LogonType `S4U`

S4U is a native Windows batch-logon type. The scheduled task runs as your
user's SID, but without an interactive desktop session. That has three nice
properties:

- No console window ever flashes at login – there is no desktop session for
  `conhost` to attach to.
- Your ssh-agent pipe (ACL'd to your SID) stays reachable, because the task
  runs as you.
- No password is stored. Alternatives like LogonType `Password` would work
  but require saving your Windows password in the task.

## VM setup (once per VM)

1. Install `agent-browser` on the VM (see the browser-verify skill).

2. Create `agent-browser.json` in each project root:

   ```json
   { "cdp": "19988" }
   ```

3. Add the laptop's SSH public key to `~/.ssh/authorized_keys` on the VM.

That's it – the reverse tunnel handles the rest.

## Validation

From the VM, after the scheduled tasks are running:

```bash
curl -s http://localhost:19988/json/version
```

You should get Playwriter-flavored JSON. On the laptop, open a normal web
page in the Playwriter Dev profile, click the extension icon on that tab,
and the icon should indicate it's connected.

For a round-trip smoke test:

```bash
agent-browser open https://example.com
agent-browser screenshot /tmp/ok.png
```

## Troubleshooting

- **`Empty reply from server`** on `curl /json/version` – the relay is up but
  the extension is not attached to any tab yet. Click the Playwriter icon on
  a normal web page. Benign.

- **`curl: (7) Failed to connect ... connection refused`** – the tunnel is
  not up on the VM. On the laptop, check
  `%LOCALAPPDATA%\playwriter-bridge\tunnel-<vm>.log` for the failure reason.

- **`remote port forwarding failed for listen port 19988`** (seen in the
  tunnel log) – something on the VM is already holding the port, usually a
  zombie forward from an earlier session. On the VM:

  ```bash
  ss -tlnp | grep 19988
  ```

  Find the holding `sshd` PID and `kill` it. The tunnel reconnect loop will
  restore the forward within 5 seconds.

- **`Register-ScheduledTask : Access is denied`** – you ran
  `register-tasks.ps1` from a non-elevated PowerShell. S4U registration
  requires admin. Right-click PowerShell → Run as Administrator, then retry.
  (Runtime does not need admin.)

- **Passphrase prompted at every boot** – the ssh-agent service is not set
  to start automatically. Check:

  ```powershell
  Get-Service ssh-agent
  ```

  If `StartType` is not `Automatic`, re-run step 4 from an elevated shell.

- **Scheduled task flagged on first run by endpoint security** – expected
  once. Confirm it is one of the `Playwriter-*` tasks you just registered
  and allowlist it.

## Security notes

- **Use a dedicated Chrome profile** with no sensitive logins. VM compromise
  means an attacker who lands on the VM can drive the attached profile
  through the bridge – limit the blast radius by making that profile
  disposable.
- **S4U runtime principal is a limited token.** The tasks cannot elevate.
- **Optional token auth.** Playwriter supports `--token <secret>` on `serve`
  and a matching header on CDP clients. If you want belt-and-braces on top
  of localhost-only binding, enable it.

## What this intentionally does NOT do

- **No `--remote-debugging-port` on your real Chrome.** The whole point of
  this bridge is that Chrome is driven via the extension API. Do not
  "simplify" the design by opening a debug port – you will undo the reason
  for the architecture.
- **No piggybacking on your editor's SSH session.** Win32-OpenSSH does not
  implement `ControlMaster`, and the Git-for-Windows `ssh` that does
  implement it breaks when invoked through editors that pipe `cmd.exe`.
  Dedicated S4U tunnels are independent of whether your editor is
  connected.
- **No relay on the VM.** The Playwriter extension hard-codes `localhost`.
  The relay must run next to Chrome.
