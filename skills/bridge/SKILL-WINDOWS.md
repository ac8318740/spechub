# Playwriter bridge – Windows runbook

> Stop reading if you are not on Windows. This file is PowerShell-only.
> On Linux, macOS or a dev VM, read [`SKILL-VM.md`](SKILL-VM.md) instead.

## What the Windows side owns

- The Node relay (`relay.ps1`) that speaks the Chrome DevTools Protocol (CDP)
  on `127.0.0.1:19988`.
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

The bridge opens no debug port on Chrome. The laptop runs no inbound listener.
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

Create a new Chrome profile. Name it something like "Playwriter Dev".
Do **not** sign in to sensitive accounts on this profile. It exists so a
compromised VM can only drive this profile, not your real browser.

In that profile, install the extension from the Chrome Web Store:

```
https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe
```

Pin the extension to the toolbar. You click its icon once per tab that you
want the VM to automate.

### 4. Enable ssh-agent (from elevated PowerShell, once)

The scheduled tasks run non-interactively. The ssh-agent service holds
your decrypted key so the tunnel can authenticate without prompting.

```powershell
Set-Service ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Add your key once, from any PowerShell. The command prompts for the
passphrase:

```powershell
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

Windows OpenSSH keeps the key in `HKLM\SOFTWARE\OpenSSH\Agent\Keys`,
encrypted with the Data Protection API (DPAPI), so it survives reboots.

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
The same directory holds `vm-free-port.sh`, which belongs on the VM. You
do not need that file on Windows.

### 6. Build launcher.exe (one-time)

```powershell
cd $env:USERPROFILE\playwriter-bridge
.\build-launcher.ps1
```

This compiles `launcher-src.cs` to `launcher.exe` in the same directory.
It uses PowerShell's built-in `Add-Type`. You install no SDK, and you need
no admin rights. The output must be a `WindowsApplication`, not a console
application. The shipped `build-launcher.ps1` sets that correctly. It also
references `System.Management`, because the launcher walks the process tree
through WMI on shutdown.

### 7. Pair VM access

On the VM, append your Windows public key to `~/.ssh/authorized_keys`.
Confirm from the laptop:

```powershell
ssh -o BatchMode=yes <user>@<vm> true
```

If that fails, produce a handoff block per [`HANDOFF.md`](HANDOFF.md). Ask
the VM-side agent to fix `authorized_keys`.

### 8. Register the scheduled tasks

```powershell
.\register-tasks.ps1 -VMs @("vm1.example.com", "vm2.internal")
```

Pass every VM you want a tunnel to. Add `-TunnelUser dev` if your SSH
username on the VMs is not the same as your Windows username.

The script registers `Playwriter-Relay` plus one `Playwriter-Tunnel-VM<N>`
per VM under `LogonType Interactive` with `RunLevel Limited`, each action
invoking `launcher.exe`. The task restart policy is a small backstop only
(2 retries, 5 min apart) – the scripts themselves own resilience.

Fresh installs work from a regular PowerShell. `Register-ScheduledTask`
fails with `Access is denied` when you replace tasks that you registered
earlier from an elevated shell. Re-run the script from an elevated
PowerShell in that case.

All tasks run at user logon from now on. Logs land in
`%LOCALAPPDATA%\playwriter-bridge\`.

## Routine use

### Verify the bridge is healthy

```powershell
.\doctor.ps1
```

`doctor.ps1` reports six checks. It exits 0 when every check is green, and
1 when any check is red. When a red row implies VM-side action,
`doctor.ps1` prints a ready-to-paste handoff block.

### Stop the bridge

```powershell
.\stop.ps1
```

`stop.ps1` stops all `Playwriter-*` tasks, kills lingering bridge
processes, and checks that port 19988 is free. It prints a verdict line.

### Restart a single tunnel

```powershell
Stop-ScheduledTask Playwriter-Tunnel-VM1
Start-ScheduledTask Playwriter-Tunnel-VM1
.\doctor.ps1
```

### Updates (automatic)

After initial setup you do not re-copy scripts by hand. The SpecHub
SessionStart hook runs `sync.ps1` on each Claude Code launch. `sync.ps1`
compares the deployed scripts in `%USERPROFILE%\playwriter-bridge\` against
the plugin cache by content hash. It copies every script that changed. It
rebuilds `launcher.exe` when the launcher source changed. It restarts only
the affected tasks.

A plugin update therefore reaches the running bridge on the next launch.
Each changed task costs at most one brief reconnect.

The whole SessionStart hook is a `bash` script. Git for Windows provides
`bash`. Put `bash` on `PATH`, or the hook never runs and auto-sync never
fires. When `bash` is missing, re-copy the changed files per the setup
step. Then restart the tasks.

### Per-tab activation

In Chrome, open the Playwriter Dev profile. Click the Playwriter toolbar
icon on each tab you want the VM to automate. Playwriter attaches per tab.
It cannot attach to `chrome://` and `about:` pages.

## Resilience behaviour

`tunnel.ps1` sorts an ssh failure into three kinds and reacts to each:

- **Transient** – connection refused, timed out, unreachable, DNS failure,
  TCP reset under a live session, or a Win32 connect `Unknown error`. The
  tunnel backs off exponentially, 5 → 10 → 20 → 40 → 80 → 120 s cap. The
  backoff resets when a run lasts at least 30 s. A dropped long-lived
  session lands here, so the tunnel reconnects on its own. Laptop sleep, a
  wifi roam and a VPN flap all drop a session that way.
- **Stuck remote port** (`remote port forwarding failed for listen port
  19988`) – the VM still holds the port through the dropped session's
  orphaned forward channel. For about 10 min, `tunnel.ps1` retries every
  30 s. That span outlasts the VM's `sshd` reap window, so the bridge heals
  itself without a restart. If the VM still holds the port after that,
  `tunnel.ps1` writes `tunnel-<host>.stuck` and exits. The port is then
  genuinely stuck, either through a holder other than `sshd` or through
  keepalive turned off on the VM.
- **Auth or host-key failure** – `tunnel.ps1` writes the marker and exits
  at once. These failures need user action. Retrying only floods the log.

A genuinely stuck port, an auth failure or a host-key failure makes
`tunnel.ps1` exit and lands the task in `Ready`. The Scheduler backstop then
retries twice, 5 min apart. `doctor.ps1` reports which host needs attention.
A recoverable network drop never reaches that point, because the tunnel loop
heals it.

## How console windows stay hidden

`LogonType Interactive` allocates a desktop session. A PowerShell task that
points directly at `powershell.exe` therefore gets a visible console window
at logon. Two in-process tricks do not solve this on modern Windows:

- `-WindowStyle Hidden` – unreliable. The window still appears on the
  taskbar before it hides.
- `Add-Type` with `ShowWindow(GetConsoleWindow(), SW_HIDE)` – this works on
  classic `conhost`. It fails on Windows 11 22H2+, where Windows Terminal is
  the default terminal host. There, `GetConsoleWindow()` returns a ConPTY
  proxy handle, and `ShowWindow` on that handle does nothing to the Windows
  Terminal window.

The fix is `launcher.exe`, a small C# `WindowsApplication`. It starts the
child with `CreateNoWindow = true`, so `CREATE_NO_WINDOW` propagates and
Windows attaches no console. The launcher also waits for the child. It
propagates the child's exit code. It kills the descendant process tree on
shutdown through WMI. That last part is why `Stop-ScheduledTask` now takes
the whole bridge down cleanly.

The plugin ships the launcher as source on purpose, not as a prebuilt
binary. Each user compiles their own, so no unsigned third-party `.exe`
reaches the machine.

The bridge stores no password anywhere. The tasks run as your user's SID.
Windows puts the ssh-agent named pipe behind an access control list for that
SID, so the tasks can reach it.

## Troubleshooting

`doctor.ps1` covers most issues. The items below cover the cases it does not
report.

- **`Empty reply from server`** on `curl /json/version` – the relay is up
  but the extension has not attached to any tab yet. Click the Playwriter
  icon on a normal web page. This is harmless, and `doctor.ps1` reports it
  as amber, not red.

- **`Register-ScheduledTask : Access is denied`** – the tasks already
  exist, and you registered them from an elevated PowerShell. A non-admin
  shell cannot replace them. Right-click PowerShell and choose Run as
  Administrator. Then retry. Fresh installs do not need admin.

- **Console windows appear at logon and stay visible** – the scheduled
  task action points at `powershell.exe` directly instead of at
  `launcher.exe`. Inspect one task:

  ```powershell
  (Get-ScheduledTask Playwriter-Relay).Actions | Format-List Execute, Arguments
  ```

  `Execute` should end in `launcher.exe`. If it ends in `powershell.exe`,
  someone registered the tasks before `launcher.exe` was in place. Re-run
  `build-launcher.ps1`, then `register-tasks.ps1`. Use an elevated
  PowerShell if the tasks already exist.

- **Tasks show `LastTaskResult: 267011` and `LastRunTime: 1999`** (epoch) –
  the task is ready, but Windows never launched it. The most common cause
  on a domain-joined laptop is a task under `LogonType S4U` without
  reachable Kerberos infrastructure at logon. The shipped
  `register-tasks.ps1` uses `LogonType Interactive` to avoid this. When you
  see this result, check that the registered tasks are Interactive.
  Re-register them if they are not:

  ```powershell
  Get-ScheduledTask Playwriter-* |
    Select-Object TaskName, @{n='LogonType';e={$_.Principal.LogonType}}
  ```

- **Passphrase prompted at every boot** – the ssh-agent service does not
  start automatically. Check `Get-Service ssh-agent`. If `StartType` is not
  `Automatic`, re-run step 4 from an elevated shell.

- **Endpoint security flags a scheduled task on first run** – this happens
  once on some endpoints. Confirm the task is one of the `Playwriter-*`
  tasks you just registered. Then allowlist it per your local procedure.

- **Endpoint security logs each reconnect on a public-IP tunnel** – some
  endpoint products log an event each time you spawn `ssh.exe` with a
  reverse forward. They log the event and never block it, and they stay
  quiet for RFC1918 targets. That log is a detection record, not a
  mitigation. A steady-state bridge produces no further events. If your
  endpoint product starts *blocking* the ssh spawn rather than logging it,
  escalate to whoever owns endpoint policy at your site. Ask them for a
  behavioural exclusion, or one scoped to the process arguments
  `ssh.exe -R 19988:127.0.0.1:19988`.

- **Endpoint security logs on `build-launcher.ps1`** – the
  `Add-Type -OutputAssembly` call invokes `csc.exe` from the .NET Framework
  to compile `launcher-src.cs`. Some endpoint products flag any `csc.exe`
  that PowerShell spawns, because malicious PowerShell often compiles
  payloads at runtime. One alert per build is normal in that environment.
  The built `launcher.exe` runs clean from then on. If that alert disrupts
  your site, the alternative is to ship a prebuilt `launcher.exe` with a
  checksum and skip `csc.exe`. Raise that change with the plugin maintainer
  rather than patching locally.

- **`tunnel-<host>.stuck` marker present** – `tunnel.ps1` saw a fatal
  classification and exited. Read the marker file for the reason and the
  fix. Running `doctor.ps1` also prints this verbatim, and emits the right
  handoff block.

## Cross-device handoffs

Some steps need VM-side action – fix `authorized_keys`, free a stuck port,
or check host keys. Format any such request using
[`HANDOFF.md`](HANDOFF.md). The `doctor.ps1` script does this automatically
for its own red rows. When you need a handoff block by hand, copy the shape
verbatim.

## Security notes

- **Dedicated Chrome profile** with no sensitive logins. VM compromise means
  an attacker on the VM can drive the attached profile through the bridge.
  Limit the damage by keeping that profile disposable.
- **Scheduled tasks run with `RunLevel Limited`.** They cannot elevate,
  so a compromised relay or tunnel process has only the normal user's
  rights.
- **Optional token authentication.** Playwriter supports `--token <secret>`
  on `serve` and a matching header on CDP clients. Enable it if you want a
  second control on top of the localhost-only binding.

## What the bridge deliberately does not do

- **No `--remote-debugging-port` on your real Chrome.** The bridge exists
  so that the extension API drives Chrome instead. Do not "simplify" the
  design by opening a debug port.
- **No piggybacking on an editor's SSH session.** Win32-OpenSSH does not
  implement `ControlMaster`. The Git-for-Windows `ssh` implements it, but
  breaks when an editor pipes `cmd.exe` around it. Dedicated
  scheduled-task tunnels stay independent.
- **No relay on the VM.** The Playwriter extension hard-codes
  `localhost`. The relay must run next to Chrome.
