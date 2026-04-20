# Playwriter bridge – Windows laptop setup

How to drive a real Chrome browser running on your Windows laptop from
`agent-browser` (and any other CDP client) running on a remote Linux VM.

This is the persistent Windows setup: three scheduled tasks running at
logon as `LogonType Interactive`, ssh-agent holding your key across
reboots, auto-reconnecting relay and tunnel. Each task runs through a tiny
launcher.exe shim that spawns PowerShell with `CREATE_NO_WINDOW`, so no
console window is ever allocated – nothing to flash at logon.

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

### 5. Drop the bridge files in place

Copy these five files from the plugin into `%USERPROFILE%\playwriter-bridge\`:

- `launcher-src.cs`
- `build-launcher.ps1`
- `relay.ps1`
- `tunnel.ps1`
- `register-tasks.ps1`

They live in the plugin at `plugins/spechub/assets/playwriter-bridge/`.

### 6. Build launcher.exe (one-time)

```powershell
cd $env:USERPROFILE\playwriter-bridge
.\build-launcher.ps1
```

This compiles `launcher-src.cs` to `launcher.exe` in the same directory,
using PowerShell's built-in `Add-Type`. No SDK install, no admin. The
output must be a `WindowsApplication` (not a console application) – the
shipped `build-launcher.ps1` sets that correctly.

### 7. Register the scheduled tasks

```powershell
.\register-tasks.ps1 -VMs @("vm1.example.com", "vm2.internal")
```

Pass every VM you want a tunnel to. Add `-TunnelUser dev` if your SSH
username on the VMs is not the same as your Windows username.

The script:

1. Verifies `launcher.exe` exists (fails fast if step 6 was skipped).
2. Registers `Playwriter-Relay` plus one `Playwriter-Tunnel-VM<N>` per VM
   under `LogonType Interactive` with `RunLevel Limited`. Each task's
   action is `launcher.exe "<powershell>" -NoProfile -ExecutionPolicy
   Bypass -File <script>`.
3. Kicks them off immediately.

A fresh install works from a regular PowerShell. If you are replacing tasks
that were previously registered from an elevated shell,
`Register-ScheduledTask` will fail with "Access is denied" – re-run the
script from an elevated PowerShell in that case.

All three tasks run at user logon from now on, with a 5-second reconnect
loop. Logs land in `%LOCALAPPDATA%\playwriter-bridge\`.

### How console windows stay hidden

`LogonType Interactive` is the task-scheduler logon type that actually
works for a broad range of Windows accounts, including domain accounts
that may not have line-of-sight to a domain controller at logon. It does,
however, allocate a desktop session – so a PowerShell task registered
directly against `powershell.exe` gets a visible console window at logon.

Two in-process tricks do not solve this on modern Windows:

- `-WindowStyle Hidden` – unreliable; the window still appears on the
  taskbar before it hides.
- `Add-Type` + `ShowWindow(GetConsoleWindow(), SW_HIDE)` – works on
  classic `conhost` but not on Windows 11 22H2+ where Windows Terminal is
  the default terminal host. Under WT, `GetConsoleWindow()` returns a
  ConPTY proxy handle and `ShowWindow` on that handle does nothing to the
  actual WT window.

The fix is `launcher.exe`: a 40-line C# `WindowsApplication` shim that
starts the child process with `CreateNoWindow = true`, so `CREATE_NO_WINDOW`
propagates and no console is ever attached. Source lives at
`launcher-src.cs`; compile it with `build-launcher.ps1`. The launcher is
intentionally shipped as source, not a prebuilt binary – each user
compiles their own so no unsigned third-party `.exe` is introduced onto
the machine.

No password is stored anywhere. The tasks run as your user's SID, which
keeps the ssh-agent named pipe (ACL'd to that SID) reachable.

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

- **`Register-ScheduledTask : Access is denied`** – the tasks already exist
  and were registered from an elevated PowerShell. A non-admin shell cannot
  replace them. Right-click PowerShell → Run as Administrator, then retry.
  Fresh installs do not need admin.

- **Console windows appear at logon and stay visible** – the scheduled
  task action is pointing at `powershell.exe` directly instead of at
  `launcher.exe`. Inspect one task:

  ```powershell
  (Get-ScheduledTask Playwriter-Relay).Actions | Format-List Execute, Arguments
  ```

  `Execute` should end in `launcher.exe`. If it ends in `powershell.exe`,
  the tasks were registered before `launcher.exe` was in place – re-run
  `build-launcher.ps1` then `register-tasks.ps1` (elevated if the tasks
  already exist).

- **`launcher.exe` is missing** – `register-tasks.ps1` fails fast with a
  clear message pointing at `build-launcher.ps1`. Run that first.

- **Tasks show `LastTaskResult: 267011` and `LastRunTime: 1999`** (epoch) –
  the task is ready but never actually launched. Most common cause on a
  domain-joined laptop is a task registered under `LogonType S4U` without
  reachable Kerberos infrastructure at logon. The shipped
  `register-tasks.ps1` uses `LogonType Interactive` specifically to avoid
  this; if you see it, make sure the registered tasks are Interactive
  (`Get-ScheduledTask Playwriter-* | Select-Object TaskName,
  @{n='LogonType';e={$_.Principal.LogonType}}`) and re-register if not.

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
- **Scheduled tasks run with `RunLevel Limited`.** They cannot elevate, so
  a compromised relay or tunnel process has only the normal user's rights.
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
  Dedicated scheduled-task tunnels are independent of whether your editor
  is connected.
- **No relay on the VM.** The Playwriter extension hard-codes `localhost`.
  The relay must run next to Chrome.
