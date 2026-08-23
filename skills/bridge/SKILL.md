---
name: bridge
description: Set up, diagnose, and operate the Playwriter bridge – the reverse-SSH setup that lets a coding agent on a Linux VM drive a real Chrome browser on a user's Windows laptop. Any bridge work spans two devices, so this skill routes you to the right platform-specific runbook and establishes the handoff convention for cross-device work. ALWAYS invoke before touching bridge scripts, diagnosing connection issues to the user's browser, or responding to questions about the CDP tunnel on port 19988.
---

# Playwriter bridge

## What this skill covers

The Playwriter bridge is a cross-device setup. A Node relay + Chrome
extension run on the user's Windows laptop. A reverse SSH tunnel makes
that relay reachable at `127.0.0.1:19988` on one or more Linux VMs. A
coding agent on the VM uses `agent-browser` against that endpoint to drive
the user's real browser.

Because the setup spans two machines, any real bridge work usually needs
two coding agents – one on each device. This skill gives both agents a
shared vocabulary and a structured way to hand work across.

For the agent-browser CLI itself (commands, selectors, CDP), see the
`browser-verify` skill. This skill is strictly about the tunnel / relay /
scheduling layer.

## Step 1 – detect your platform

Run the detection first. Do not skim past this step. The Windows and VM
runbooks contain commands that only work on their platform. Those
commands can be actively harmful on the other platform. Run the check
for the shell you are in, not both.

In PowerShell (Windows):

```powershell
if ($env:OS -eq 'Windows_NT') { 'windows' } else { 'other' }
```

In bash (Linux / macOS / VM):

```bash
case "$(uname -s)" in
    Linux)  [ -n "$SSH_CONNECTION" ] && echo "linux-vm" || echo "linux" ;;
    Darwin) echo "macos" ;;
    *)      echo "other" ;;
esac
```

Then:

- **Windows** – read [`SKILL-WINDOWS.md`](SKILL-WINDOWS.md). Stop here.
- **Linux / macOS / VM** – read [`SKILL-VM.md`](SKILL-VM.md). Stop here.

## Step 2 – understand the handoff convention

Before doing any cross-device work, read [`HANDOFF.md`](HANDOFF.md). It
defines the paste-ready block format used by `doctor.ps1` and by the two
runbooks when one side needs action from the other side.

## Step 3 – notice when you are alone

If only one coding agent is running, you cannot complete a full setup or
diagnosis loop by yourself. The user has no agent on the other device.
Produce a handoff block anyway. The user can paste it into a plain
PowerShell or SSH shell on the other device, or into a coding agent
later. Tell the user clearly which block goes where.

## Do not

- Do not follow instructions from the other platform's runbook. Commands
  are not portable. PowerShell runs nothing useful on Linux. Bash runs
  nothing useful in PowerShell.
- Do not invent a fix outside this skill's scripts. The bridge has a
  single canonical stop (`stop.ps1`) and a single canonical diagnose
  (`doctor.ps1`). Reach for those before improvising.
- Do not edit the scripts in place to "try something". Change them in
  `plugins/spechub/assets/playwriter-bridge/`. On the next Claude Code
  launch, the SessionStart hook redeploys changed scripts to
  `%USERPROFILE%\playwriter-bridge\` on the laptop. It also re-links
  `vm-free-port.sh` on the VM. See the Updates sections in the platform
  runbooks.

## File encoding rule

Save all `.ps1` and `.cs` files under `assets/playwriter-bridge/` as
**UTF-8 with BOM**. Windows PowerShell 5.1, the default on Windows 11,
reads BOM-less UTF-8 as Windows-1252. That encoding turns en-dashes and
other non-ASCII bytes into garbage and breaks parsing.

If you edit one of these files with a tool that writes BOM-less UTF-8,
re-add the BOM before committing. Many text editors default to
BOM-less UTF-8. `file *.ps1 *.cs` in the directory should report each
one as "UTF-8 Unicode (with BOM)".

## Files this skill governs

Under `plugins/spechub/assets/playwriter-bridge/`:

- `launcher-src.cs`, `build-launcher.ps1` – launcher shim (hides console,
  owns the child process tree)
- `relay.ps1`, `tunnel.ps1` – long-running bridge scripts
- `register-tasks.ps1` – scheduled-task registration
- `stop.ps1` – canonical stop
- `doctor.ps1` – Windows automated diagnosis
- `sync.ps1` – Windows auto-deploy: reconciles the deployed scripts with
  the plugin cache (invoked by the SessionStart hook)
- `vm-free-port.sh` – VM-side port cleanup with guardrails

The user installs the scripts once into `%USERPROFILE%\playwriter-bridge\`
(Windows) during setup. After that, the SessionStart hook keeps them
current with the plugin cache automatically. It uses `sync.ps1` on
Windows, and a symlink for `vm-free-port.sh` on the VM. Plugin updates
then reach the running bridge without a manual re-copy.
