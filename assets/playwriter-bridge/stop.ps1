# stop.ps1 – Canonical "stop the bridge" entry point.
#
# Stops every Playwriter-* scheduled task - which covers the document opener
# and its tunnel too, both registered under the same prefix - kills any
# lingering bridge
# processes (relay.ps1, tunnel.ps1), reaps orphan ssh.exe children that
# were carrying the reverse forward, and confirms 127.0.0.1:19988 is no
# longer bound. Prints a one-line verdict.
#
# Safe to run at any time. No-ops if the bridge is already down.
#
# Implementation notes:
# - The sweep matches on command line. Since this script itself may run
#   from a shell whose command line contains 'playwriter-bridge', we
#   exclude $PID (and its parent) to avoid self-kill.
# - When the launcher is force-killed, its ProcessExit handler does NOT
#   run, so the ssh.exe child it spawned is orphaned. A dedicated pass
#   looks for ssh.exe processes carrying the 19988 reverse forward and
#   kills them explicitly.

$ErrorActionPreference = 'Continue'

$selfPid = $PID
try { $selfParent = (Get-CimInstance Win32_Process -Filter "ProcessId=$selfPid").ParentProcessId } catch { $selfParent = 0 }

function Should-Skip {
    param([int]$TargetPid)
    return ($TargetPid -eq $selfPid) -or ($TargetPid -eq $selfParent)
}

Write-Host "Stopping Playwriter-* scheduled tasks..."
$tasks = Get-ScheduledTask -TaskName 'Playwriter-*' -ErrorAction SilentlyContinue
foreach ($t in $tasks) {
    try {
        Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue
        Write-Host "  stopped: $($t.TaskName)"
    } catch {
        Write-Host "  (could not stop $($t.TaskName): $_)"
    }
}

# Pass 1: kill launcher.exe / PowerShell children that were driving the
# bridge. Excludes this script and its parent so we do not kill ourselves.
$bridgePattern = 'playwriter-bridge'
$pass1 = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $bridgePattern -and
        -not (Should-Skip $_.ProcessId)
    }

foreach ($p in $pass1) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  killed: PID $($p.ProcessId) ($($p.Name))"
    } catch { }
}

Start-Sleep -Milliseconds 500

# Pass 2: reap orphan ssh.exe reverse-forward children. Required because
# Stop-Process -Force on the launcher does not run the launcher's
# ProcessExit handler, so the ssh.exe it parented survives. Match on the
# reverse-forward argument pattern (narrow, scoped to the two ports this setup
# owns - 19988 for the bridge, 19989 for the document opener) so this never
# touches an unrelated ssh session.
$sshRemnants = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -eq 'ssh.exe' -and
        $_.CommandLine -and
        ($_.CommandLine -match '1998[89]:127\.0\.0\.1:1998[89]' -or $_.CommandLine -match '-R\s+"?1998[89]:') -and
        -not (Should-Skip $_.ProcessId)
    }

foreach ($p in $sshRemnants) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  killed: PID $($p.ProcessId) (ssh.exe, reverse forward)"
    } catch { }
}

Start-Sleep -Milliseconds 500

# Pass 3: reap the orphan node.exe that relay.ps1 spawned (playwriter serve)
# and still binds 19988, and the one opener.ps1 spawned and still binds 19989.
# Identify each by whatever owns the port, then kill only if its command line
# names the thing we expect - so we never touch an unrelated listener that
# happens to be on either port.
$owned = @{ 19988 = 'playwriter'; 19989 = 'opener\.js' }
foreach ($port in $owned.Keys) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $listener) {
        $ownerPid = [int]$conn.OwningProcess
        if ($ownerPid -le 0) { continue }
        if (Should-Skip $ownerPid) { continue }
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.CommandLine -and $proc.CommandLine -match $owned[$port]) {
            try {
                Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
                Write-Host "  killed: PID $ownerPid ($($proc.Name), orphan listener on $port)"
            } catch { }
        } else {
            Write-Host "  NOT killing PID $ownerPid ($($proc.Name)): command line does not match '$($owned[$port])'" -ForegroundColor Yellow
        }
    }
}

Start-Sleep -Milliseconds 500

$stillUp = @()
foreach ($port in $owned.Keys) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        $stillUp += $port
    }
}
if ($stillUp) {
    Write-Host ""
    Write-Host "VERDICT: PARTIALLY down – something still listens on $($stillUp -join ', ')" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "VERDICT: bridge and opener are down" -ForegroundColor Green
exit 0
