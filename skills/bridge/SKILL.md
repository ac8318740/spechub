---
name: bridge
description: Set up, diagnose, and operate the Playwriter bridge – the reverse-SSH setup that lets a coding agent on a Linux dev VM drive a real Chrome browser on a user's Windows laptop. Any bridge work spans two devices, so this skill routes you to the right platform-specific runbook and establishes the handoff convention for cross-device work. ALWAYS invoke before touching bridge scripts, diagnosing connection issues to the user's browser, or responding to questions about the CDP tunnel on port 19988.
---

# Playwriter bridge

## What this skill covers

The Playwriter bridge is a cross-device setup. A Node relay + Chrome
extension run on the user's Windows laptop. A reverse SSH tunnel makes
that relay reachable at `127.0.0.1:19988` on one or more Linux dev VMs. A
coding agent on the VM uses `agent-browser` against that endpoint to drive
the user's real browser.

Because the setup spans two machines, any real bridge work usually needs
two coding agents – one on each device. This skill gives both agents a
shared vocabulary and a structured way to hand work across.

For the agent-browser CLI itself (commands, selectors, CDP), see the
`browser-verify` skill. This skill is strictly about the tunnel / relay /
scheduling layer.

## Step 1 – detect your platform

Run the detection first. Do not skim past this step – the Windows and VM
runbooks contain commands that only work on their platform and can be
actively harmful on the other. Run the check for the shell you are in,
not both.

In PowerShell (Windows):

```powershell
if ($env:OS -eq 'Windows_NT') { 'windows' } else { 'other' }
```

In bash (Linux / macOS / dev VM):

```bash
case "$(uname -s)" in
    Linux)  [ -n "$SSH_CONNECTION" ] && echo "linux-vm" || echo "linux" ;;
    Darwin) echo "macos" ;;
    *)      echo "other" ;;
esac
```

Then:

- **Windows** – read [`SKILL-WINDOWS.md`](SKILL-WINDOWS.md) and stop here.
- **Linux / macOS / dev VM** – read [`SKILL-VM.md`](SKILL-VM.md) and stop here.

## Step 2 – understand the handoff convention

Before doing any cross-device work, read [`HANDOFF.md`](HANDOFF.md). It
defines the paste-ready block format used by `doctor.ps1` and by the two
runbooks when one side needs action from the other side.

## Step 3 – notice when you are alone

If only one coding agent is running (the user has no agent on the other
device), you cannot complete a full setup or diagnosis loop by yourself.
Produce a handoff block anyway – the user can paste it into a plain
PowerShell or SSH shell on the other device, or into a coding agent later.
Tell the user clearly which block goes where.

## Do not

- Do not follow instructions from the other platform's runbook. Commands
  are not portable. PowerShell runs nothing useful on Linux; bash runs
  nothing useful in PowerShell.
- Do not invent a fix outside this skill's scripts. The bridge has a
  single canonical stop (`stop.ps1`) and a single canonical diagnose
  (`doctor.ps1`). Reach for those before improvising.
- Do not edit the scripts in place to "try something". Change them in
  `plugins/spechub/assets/playwriter-bridge/` and reinstall into
  `%USERPROFILE%\playwriter-bridge\` on the laptop.

## File encoding rule

All `.ps1` and `.cs` files under `assets/playwriter-bridge/` are saved as
**UTF-8 with BOM**. Windows PowerShell 5.1 (default on Windows 11) reads
BOM-less UTF-8 as Windows-1252, which turns en-dashes and other
non-ASCII bytes into garbage that breaks parsing. If you edit one of
these files with a tool that writes BOM-less UTF-8 (many text editors
default to this), re-add the BOM before committing. `file *.ps1 *.cs`
in the directory should report each one as "UTF-8 Unicode (with BOM)".

## Files this skill governs

Under `plugins/spechub/assets/playwriter-bridge/`:

- `launcher-src.cs`, `build-launcher.ps1` – launcher shim (hides console,
  owns the child process tree)
- `relay.ps1`, `tunnel.ps1` – long-running bridge scripts
- `register-tasks.ps1` – scheduled-task registration
- `stop.ps1` – canonical stop
- `doctor.ps1` – Windows automated diagnosis
- `vm-free-port.sh` – VM-side port cleanup with guardrails

The scripts are installed by the user into `%USERPROFILE%\playwriter-bridge\`
(Windows) and into whatever location they prefer (VM).
