# Cross-device handoff format

The bridge spans two devices. When a coding agent on one side needs the
other side to act, it emits a **handoff block** in this exact shape:

```
--- BEGIN <WINDOWS|VM>-SIDE HANDOFF ---
Context: <one line describing what happened and why the other side must act>
Run on <device>:
  <exact command(s)>
Expected result:
  <exact success criterion>
Report back:
  <exact output the requesting side needs>
--- END <WINDOWS|VM>-SIDE HANDOFF ---
```

The `WINDOWS-SIDE` or `VM-SIDE` tag names the side that **produced** the
block, so the other side knows who asked. `Run on <device>` names who
**executes** it.

The block is designed to paste verbatim into another coding agent, or –
when the user has no coding agent on the other device – into a plain
PowerShell or SSH shell.

## Worked example 1 – Windows → VM, free a stuck port

Produced by `doctor.ps1` on the Windows laptop when tunnel-<host>.log
shows the stuck-port signature:

```
--- BEGIN WINDOWS-SIDE HANDOFF (to VM agent on vm1.example.com) ---
Context: the Playwriter bridge tunnel to vm1.example.com is stuck.
tunnel-vm1.example.com.log shows "remote port forwarding failed for
listen port 19988", meaning something on the VM already holds the port.

Run on vm1.example.com:
  bash vm-free-port.sh

Expected result:
  ss -lnt 'sport = :19988' is empty, or vm-free-port.sh refuses and
  tells you the port is held by your own interactive session (in which
  case exit that session and retry).

Report back:
  The exit status of vm-free-port.sh and the final ss output.
--- END WINDOWS-SIDE HANDOFF ---
```

After the VM side acts, the Windows side confirms recovery with:

```
Start-ScheduledTask Playwriter-Tunnel-VM1
doctor.ps1
```

Success criterion: all rows green.

## Worked example 2 – VM → Windows, restart a tunnel task

Produced by a VM-side agent when `agent-browser` cannot reach
`http://127.0.0.1:19988/json/version`:

```
--- BEGIN VM-SIDE HANDOFF (to Windows agent) ---
Context: agent-browser on vm1.example.com cannot reach the CDP endpoint
at 127.0.0.1:19988 (connection refused). The tunnel appears down.

Run on the Windows laptop:
  Stop-ScheduledTask Playwriter-Tunnel-VM1
  Start-ScheduledTask Playwriter-Tunnel-VM1
  .\doctor.ps1

Expected result:
  doctor.ps1 exits with all green rows, including "Relay listening on
  19988" and no tunnel-*.stuck markers.

Report back:
  The doctor.ps1 output (paste the table).
--- END VM-SIDE HANDOFF ---
```

## Rules for writing a handoff

- **Exact commands.** No "figure out the right flag" – the receiving side
  may be a human at a shell, not a coding agent.
- **One verifiable success criterion.** Not "looks ok".
- **Small.** One problem per block. If two things are broken, emit two
  blocks.
- **Scrub internal names.** No employer names, people names, internal IP
  ranges, ticket IDs. Use placeholders like `<host>`, `vm1.example.com`.
