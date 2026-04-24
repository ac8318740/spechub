# Playwriter bridge – Windows runbook

> Stop reading if you are not on Windows. This file is PowerShell-only.
> Linux / macOS / dev-VM agents: read [`SKILL-VM.md`](SKILL-VM.md) instead.

## What the Windows side owns

- The Node relay (`relay.ps1`) that speaks CDP on `127.0.0.1:19988`.
- The Playwriter Chrome extension that attaches to individual tabs.
- One reverse SSH tunnel per VM (`tunnel.ps1 -TargetHost <host>`).
- The scheduled tasks that keep those running across logons.
- `ssh-agent` holding the key that authenticates the tunnels.

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

No debug port is opened on Chrome. No inbound listener on the laptop.
The only laptop-to-VM connection is outbound SSH.

## Prerequisites

- Windows 10 / 11 laptop
- A Linux (or similar) dev VM reachable by SSH from the laptop
- Chrome installed on the laptop
- An SSH keypair you use to reach the VM

## Initial setup

Run these from a normal (non-elevated) PowerShell unless a step says
otherwise.

### 1. Install Node.js LTS

```powershell
winget install OpenJS.NodeJS.LTS
```

Open a new PowerShell so `node` and `npm` are on `PATH`.

### 2. Install the Playwriter CLI

```powershell
npm install -g playwriter
playwriter --version
```

### 3. Install the Playwriter Chrome extension (dedicated profile)

Create a new Chrome profile – name it something like "Playwriter Dev".
Do **not** sign in to sensitive accounts on this profile. It exists so
that a compromised VM can only drive this profile, not your real browser.

In that profile, install the extension from the Chrome Web Store:

```
https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe
```

Pin the extension to the toolbar. You will click its icon once per tab
you want the VM to be able to automate.

### 4. Enable ssh-agent (from elevated PowerShell, once)

The scheduled tasks run non-interactively. The ssh-agent service holds
your decrypted key so the tunnel can authenticate without prompting.

```powershell
Set-Service ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Add your key once (in any PowerShell, will prompt for the passphrase):

```powershell
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

Windows OpenSSH persists the key DPAPI-encrypted in
`HKLM\SOFTWARE\OpenSSH\Agent\Keys` so it survives reboots.

### 5. Drop the bridge files in place

Copy every file from the plugin into `%USERPROFILE%\playwriter-bridge\`:

- `launcher-src.cs`
- `build-launcher.ps1`
- `relay.ps1`
- `tunnel.ps1`
- `register-tasks.ps1`
- `stop.ps1`
- `doctor.ps1`

They live in the plugin at `plugins/spechub/assets/playwriter-bridge/`.
(`vm-free-port.sh` from the same directory is for the VM; you do not
need it on Windows.)

### 6. Build launcher.exe (one-time)

```powershell
cd $env:USERPROFILE\playwriter-bridge
.\build-launcher.ps1
```

This compiles `launcher-src.cs` to `launcher.exe` in the same directory,
using PowerShell's built-in `Add-Type`. No SDK install, no admin. The
output must be a `WindowsApplication` (not a console application) – the
shipped `build-launcher.ps1` sets that correctly and also references
`System.Management` (the launcher walks the process tree via WMI on
shutdown).

### 7. Pair VM access

On the VM, append your Windows public key to `~/.ssh/authorized_keys`.
Confirm from the laptop:

```powershell
ssh -o BatchMode=yes <user>@<vm> true
```

If that fails, produce a handoff block (see [`HANDOFF.md`](HANDOFF.md))
asking the VM-side agent to fix `authorized_keys`.

### 8. Register the scheduled tasks

```powershell
.\register-tasks.ps1 -VMs @("vm1.example.com", "vm2.internal")
```

Pass every VM you want a tunnel to. Add `-TunnelUser dev` if your SSH
username on the VMs is not the same as your Windows username.

The script registers `Playwriter-Relay` plus one `Playwriter-Tunnel-VM<N>`
per VM under `LogonType Interactive` with `RunLevel Limited`, each action
invoking `launcher.exe`. Task restart policy is a small backstop only
(2 retries, 5 min apart) – the scripts themselves own resilience.

Fresh installs work from a regular PowerShell. If you are replacing tasks
that were previously registered from an elevated shell,
`Register-ScheduledTask` will fail with "Access is denied" – re-run the
script from an elevated PowerShell.

All tasks run at user logon from now on. Logs land in
`%LOCALAPPDATA%\playwriter-bridge\`.

## Routine use

### Verify the bridge is healthy

```powershell
.\doctor.ps1
```

Reports six checks. Exit 0 = all green, 1 = any red. When a red row
implies VM-side action, doctor prints a ready-to-paste handoff block.

### Stop the bridge

```powershell
.\stop.ps1
```

Stops all `Playwriter-*` tasks, kills lingering bridge processes, and
verifies port 19988 is free. Prints a verdict line.

### Restart a single tunnel

```powershell
Stop-ScheduledTask Playwriter-Tunnel-VM1
Start-ScheduledTask Playwriter-Tunnel-VM1
.\doctor.ps1
```

### Per-tab activation

In Chrome (Playwriter Dev profile), click the Playwriter toolbar icon on
each tab you want the VM to automate. Playwriter attaches per-tab.
`chrome://` and `about:` pages cannot be attached.

## Resilience behaviour

`tunnel.ps1` classifies ssh failures and reacts:

- **Transient** (connection refused / timed out / unreachable / DNS) –
  exponential backoff 5 → 10 → 20 → 40 → 80 → 120 s cap. Resets when a
  run lasts at least 30 s.
- **Stuck remote port** (`remote port forwarding failed for listen port
  19988`) – three consecutive hits write `tunnel-<host>.stuck`, log a
  fatal line, and exit. Scheduler's `State` returns to `Ready`.
- **Auth or host-key failure** – write marker, exit immediately. These
  need user action; retrying just floods the log.

After any fatal exit, the Scheduler backstop retries twice 5 min apart.
If the condition has not been fixed, the task lands in `Ready`, and
`doctor.ps1` reports which host needs attention.

## How console windows stay hidden

`LogonType Interactive` allocates a desktop session – so a PowerShell
task registered directly against `powershell.exe` gets a visible console
window at logon. Two in-process tricks do not solve this on modern
Windows:

- `-WindowStyle Hidden` – unreliable; the window still appears on the
  taskbar before it hides.
- `Add-Type` + `ShowWindow(GetConsoleWindow(), SW_HIDE)` – works on
  classic `conhost` but not on Windows 11 22H2+ where Windows Terminal
  is the default terminal host. `GetConsoleWindow()` returns a ConPTY
  proxy handle; `ShowWindow` on it does nothing to the WT window.

The fix is `launcher.exe`: a small C# `WindowsApplication` that starts
the child with `CreateNoWindow = true` so `CREATE_NO_WINDOW` propagates
and no console is ever attached. The launcher also waits for the child,
propagates its exit code, and kills the descendant process tree on
shutdown via WMI. That last part is why `Stop-ScheduledTask` now takes
the whole bridge down cleanly.

The launcher is intentionally shipped as source, not a prebuilt binary –
each user compiles their own so no unsigned third-party `.exe` is
introduced onto the machine.

No password is stored anywhere. The tasks run as your user's SID, which
keeps the ssh-agent named pipe (ACL'd to that SID) reachable.

## Troubleshooting

Most issues are covered by `doctor.ps1`. The items below cover cases
that do not come up automatically.

- **`Empty reply from server`** on `curl /json/version` – the relay is up
  but the extension is not attached to any tab yet. Click the Playwriter
  icon on a normal web page. Benign; `doctor.ps1` reports this as amber,
  not red.

- **`Register-ScheduledTask : Access is denied`** – the tasks already
  exist and were registered from an elevated PowerShell. A non-admin
  shell cannot replace them. Right-click PowerShell → Run as
  Administrator, then retry. Fresh installs do not need admin.

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

- **Tasks show `LastTaskResult: 267011` and `LastRunTime: 1999`** (epoch) –
  the task is ready but never actually launched. Most common cause on a
  domain-joined laptop is a task registered under `LogonType S4U`
  without reachable Kerberos infrastructure at logon. The shipped
  `register-tasks.ps1` uses `LogonType Interactive` specifically to
  avoid this; if you see it, confirm the registered tasks are
  Interactive and re-register if not:

  ```powershell
  Get-ScheduledTask Playwriter-* |
    Select-Object TaskName, @{n='LogonType';e={$_.Principal.LogonType}}
  ```

- **Passphrase prompted at every boot** – the ssh-agent service is not
  set to start automatically. Check `Get-Service ssh-agent`; if
  `StartType` is not `Automatic`, re-run step 4 from an elevated shell.

- **Scheduled task flagged on first run by endpoint security** – can
  happen once on some endpoints. Confirm it is one of the
  `Playwriter-*` tasks you just registered and allowlist it per your
  local procedure.

- **Endpoint security logs per-reconnect on public-IP tunnels** – some
  endpoint products will log (not block) an event each time `ssh.exe`
  is spawned with a reverse forward to a public IP, while behaving
  quietly for RFC1918 targets. This is a detection log, not a
  mitigation; steady-state bridges produce zero further events. If
  your endpoint product begins *blocking* the ssh spawn (not just
  logging), escalate to whoever owns endpoint policy at your site and
  ask for a behavioral or process-argument exclusion scoped to
  `ssh.exe -R 19988:127.0.0.1:19988`.

- **Endpoint security logs on `build-launcher.ps1`** – running
  `Add-Type -OutputAssembly` invokes `csc.exe` from the .NET Framework
  to compile `launcher-src.cs`. Some endpoint products heuristically
  flag any `csc.exe` spawned by PowerShell, because malicious
  PowerShell frequently compiles payloads at runtime. One alert per
  build is normal in that environment; the built `launcher.exe` runs
  clean from then on. If this is disruptive at your site, the
  architectural alternative is to ship a prebuilt `launcher.exe` with
  a checksum and skip `csc.exe` entirely – raise it with the plugin
  maintainer rather than patching locally.

- **`tunnel-<host>.stuck` marker present** – `tunnel.ps1` saw a fatal
  classification and exited. Read the marker file for the reason and
  remediation; `doctor.ps1` also prints this verbatim and emits the
  right handoff block.

## Cross-device handoffs

Whenever a step needs VM-side action (fix `authorized_keys`, free a
stuck port, check host keys), format the request using
[`HANDOFF.md`](HANDOFF.md). `doctor.ps1` does this automatically for its
own red rows. When you need one by hand, copy the shape verbatim.

## Security notes

- **Dedicated Chrome profile** with no sensitive logins. VM compromise
  means an attacker on the VM can drive the attached profile through the
  bridge – limit the blast radius by making that profile disposable.
- **Scheduled tasks run with `RunLevel Limited`.** They cannot elevate,
  so a compromised relay or tunnel process has only the normal user's
  rights.
- **Optional token auth.** Playwriter supports `--token <secret>` on
  `serve` and a matching header on CDP clients. If you want
  belt-and-braces on top of localhost-only binding, enable it.

## What this intentionally does NOT do

- **No `--remote-debugging-port` on your real Chrome.** The bridge
  exists precisely so Chrome is driven via the extension API. Do not
  "simplify" the design by opening a debug port.
- **No piggybacking on an editor's SSH session.** Win32-OpenSSH does
  not implement `ControlMaster`; the Git-for-Windows `ssh` that does
  breaks when invoked through editors that pipe `cmd.exe`. Dedicated
  scheduled-task tunnels stay independent.
- **No relay on the VM.** The Playwriter extension hard-codes
  `localhost`. The relay must run next to Chrome.
