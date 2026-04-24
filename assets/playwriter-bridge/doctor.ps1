# doctor.ps1 – Automated Playwriter bridge diagnosis (Windows side).
#
# Runs six checks and prints a colour-coded table with one-line remediation
# per red row. When a red row implies VM-side action, emits a paste-ready
# handoff block (see bridge/HANDOFF.md) that the user can hand to a coding
# agent on the VM.
#
# Exit 0 = all green, 1 = any red.

param(
    [Parameter(Mandatory = $false)]
    [int]$CurlTimeoutSeconds = 3
)

$ErrorActionPreference = 'Continue'

$logDir = Join-Path $env:LOCALAPPDATA 'playwriter-bridge'

$results = @()
$handoffs = @()

function Add-Result {
    param(
        [string]$Check,
        [string]$Status,   # 'green', 'amber', 'red'
        [string]$Detail,
        [string]$Remedy = ''
    )
    $script:results += [pscustomobject]@{
        Check    = $Check
        Status   = $Status
        Detail   = $Detail
        Remedy   = $Remedy
    }
}

# ---- Check 1: scheduled tasks ---------------------------------------------

$tasks = Get-ScheduledTask -TaskName 'Playwriter-*' -ErrorAction SilentlyContinue
if (-not $tasks) {
    Add-Result 'Scheduled tasks' 'red' 'no Playwriter-* tasks registered' `
        'Run register-tasks.ps1 from the bridge directory.'
} else {
    # Split failures from soft states. Report whichever is worse.
    # - Running: trust the scheduler. LastTaskResult is the *previous*
    #   run's result and can legitimately be a non-zero HRESULT for
    #   long-running tasks while they are actually healthy, so ignore it.
    # - Ready + benign last-result: task exited cleanly (including via
    #   Stop-ScheduledTask). Expected state is Running, so flag as amber
    #   so the user knows to restart it, not as red.
    # - Ready + non-benign last-result: the task script crashed or hit
    #   one of our own fatal exit codes (10=stuck-port, 11=auth,
    #   12=host-key from tunnel.ps1). Flag as red.
    # - Any other state (Disabled etc): flag as red.
    #
    # Benign last-result codes for a Ready task:
    #   0            S_OK (task finished successfully)
    #   267009 0x41301 SCHED_S_TASK_RUNNING
    #   267011 0x41303 SCHED_S_TASK_HAS_NOT_RUN
    #   267014 0x41306 SCHED_S_TASK_TERMINATED (user stopped it)
    $benignResults = @(0, 267009, 267011, 267014)
    $red = @()
    $amber = @()
    foreach ($t in $tasks) {
        if ($t.State -eq 'Running') { continue }

        if ($t.State -ne 'Ready') {
            $red += "$($t.TaskName) state=$($t.State)"
            continue
        }

        $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction SilentlyContinue
        $result = if ($info) { [int]$info.LastTaskResult } else { $null }
        if ($null -ne $result -and $benignResults -notcontains $result) {
            $red += "$($t.TaskName) state=Ready LastTaskResult=$result"
        } else {
            $amber += "$($t.TaskName) state=Ready (stopped cleanly, expected Running)"
        }
    }
    if ($red.Count -gt 0) {
        Add-Result 'Scheduled tasks' 'red' ($red -join '; ') `
            'Start-ScheduledTask on the failing tasks, or run stop.ps1 then register-tasks.ps1 fresh.'
    } elseif ($amber.Count -gt 0) {
        Add-Result 'Scheduled tasks' 'amber' ($amber -join '; ') `
            'Task stopped cleanly. Start-ScheduledTask to bring it back up.'
    } else {
        Add-Result 'Scheduled tasks' 'green' "$($tasks.Count) task(s), all Running"
    }
}

# ---- Check 2: port 19988 listener -----------------------------------------

$listener = Get-NetTCPConnection -LocalPort 19988 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
    Add-Result 'Relay listening on 19988' 'red' 'nothing listening on 127.0.0.1:19988' `
        'The relay task is not up. Run stop.ps1 then Start-ScheduledTask Playwriter-Relay.'
} else {
    Add-Result 'Relay listening on 19988' 'green' "PID $($listener.OwningProcess -join ',') listening"
}

# ---- Check 3: /json/version -----------------------------------------------

$versionOk = $false
if ($listener) {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:19988/json/version' `
            -TimeoutSec $CurlTimeoutSeconds -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            $versionOk = $true
            Add-Result 'Relay /json/version' 'green' "HTTP 200 ($([int]$r.RawContentLength) bytes)"
        } else {
            Add-Result 'Relay /json/version' 'red' "HTTP $($r.StatusCode)" `
                'Relay port is bound but not responding. Restart Playwriter-Relay.'
        }
    } catch {
        Add-Result 'Relay /json/version' 'red' "request failed: $($_.Exception.Message)" `
            'Relay is not answering. Restart Playwriter-Relay.'
    }
} else {
    Add-Result 'Relay /json/version' 'red' 'skipped (no listener)' ''
}

# ---- Check 4: /json/list --------------------------------------------------

if ($versionOk) {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:19988/json/list' `
            -TimeoutSec $CurlTimeoutSeconds -UseBasicParsing -ErrorAction Stop
        $body = $r.Content.Trim()
        if ($body -eq '[]' -or $body.Length -lt 3) {
            Add-Result 'Extension armed on a tab' 'amber' 'relay reports no attached tabs' `
                'Click the Playwriter extension icon on a normal web page in the Playwriter Dev Chrome profile.'
        } else {
            Add-Result 'Extension armed on a tab' 'green' "$(($r.Content | ConvertFrom-Json).Count) tab(s) attached"
        }
    } catch {
        Add-Result 'Extension armed on a tab' 'amber' "list check failed: $($_.Exception.Message)" ''
    }
} else {
    Add-Result 'Extension armed on a tab' 'amber' 'skipped (version check failed)' ''
}

# ---- Check 5: tunnel log signatures ---------------------------------------

$stuckHosts = @()
$authHosts = @()
$hostKeyHosts = @()

if (Test-Path $logDir) {
    $stuckFiles = Get-ChildItem -Path $logDir -Filter 'tunnel-*.stuck' -ErrorAction SilentlyContinue
    foreach ($f in $stuckFiles) {
        $content = Get-Content $f.FullName -Raw
        $target = ($f.BaseName -replace '^tunnel-', '')
        if ($content -match 'remote port forwarding failed') { $stuckHosts += $target }
        elseif ($content -match 'Permission denied') { $authHosts += $target }
        elseif ($content -match 'Host key verification') { $hostKeyHosts += $target }
        else { $stuckHosts += $target }  # unknown fatal – group with stuck for visibility
    }
}

if ($stuckHosts.Count -eq 0 -and $authHosts.Count -eq 0 -and $hostKeyHosts.Count -eq 0) {
    Add-Result 'Tunnel logs' 'green' 'no stuck markers'
} else {
    $parts = @()
    if ($stuckHosts.Count -gt 0) { $parts += "stuck port: $($stuckHosts -join ', ')" }
    if ($authHosts.Count -gt 0)  { $parts += "auth denied: $($authHosts -join ', ')" }
    if ($hostKeyHosts.Count -gt 0) { $parts += "host key: $($hostKeyHosts -join ', ')" }
    $remedy = 'See handoff blocks below.'
    Add-Result 'Tunnel logs' 'red' ($parts -join '; ') $remedy

    foreach ($h in $stuckHosts) {
        $marker = Join-Path $logDir "tunnel-$h.stuck"
        $tail = ''
        if (Test-Path $marker) { $tail = (Get-Content $marker -Raw).Trim() }
        $handoffs += @"
--- BEGIN WINDOWS-SIDE HANDOFF (to VM agent on $h) ---
Context: the Playwriter bridge tunnel to $h is stuck. tunnel-$h.log shows
"remote port forwarding failed for listen port 19988", meaning something
on the VM already holds the port. Marker contents:

$tail

Run on ${h}:
  bash vm-free-port.sh

Expected result:
  ss -lnt 'sport = :19988' is empty, or vm-free-port.sh refuses and tells
  you the port is held by your own interactive session (in which case exit
  that session and retry).

Report back:
  The exit status of vm-free-port.sh and the final ss output.
--- END WINDOWS-SIDE HANDOFF ---
"@
    }
    foreach ($h in $authHosts) {
        $handoffs += @"
--- BEGIN WINDOWS-SIDE HANDOFF (to VM agent on $h) ---
Context: the Playwriter bridge tunnel to $h gets "Permission denied
(publickey)". Either the Windows ssh-agent has no key loaded, or the
matching public key is not in authorized_keys on the VM.

Run on ${h}:
  ssh-keygen -l -f ~/.ssh/authorized_keys

Then:
  Ask the Windows side for its public key fingerprint (ssh-add -l on the
  laptop) and confirm it matches one of the entries above.

Expected result:
  The Windows laptop's public key fingerprint appears in
  ~/.ssh/authorized_keys. If not, append it.

Report back:
  Whether the expected key was present, or confirmation that you appended
  the correct one.
--- END WINDOWS-SIDE HANDOFF ---
"@
    }
    foreach ($h in $hostKeyHosts) {
        $handoffs += @"
--- BEGIN WINDOWS-SIDE HANDOFF (to VM agent on $h) ---
Context: the Playwriter bridge tunnel to $h fails with "Host key
verification failed". The VM's host key changed, or the Windows
known_hosts is stale.

Run on ${h}:
  ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub

Expected result:
  Print the VM's current ed25519 host key fingerprint.

Report back:
  The fingerprint. The Windows side will then clear the stale entry
  (ssh-keygen -R $h) and retry.
--- END WINDOWS-SIDE HANDOFF ---
"@
    }
}

# ---- Check 6: ssh-agent service ------------------------------------------

$svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
if (-not $svc) {
    Add-Result 'ssh-agent service' 'red' 'service not installed' `
        'Enable the Windows OpenSSH Client optional feature, then Set-Service ssh-agent -StartupType Automatic.'
} elseif ($svc.Status -ne 'Running') {
    Add-Result 'ssh-agent service' 'red' "service is $($svc.Status)" `
        'Start-Service ssh-agent (may require elevation).'
} else {
    $keys = & ssh-add -l 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Add-Result 'ssh-agent keys' 'red' 'no keys loaded (ssh-add -l exit != 0)' `
            'Run: ssh-add $env:USERPROFILE\.ssh\id_ed25519'
    } else {
        $count = ($keys | Measure-Object).Count
        Add-Result 'ssh-agent keys' 'green' "$count key(s) loaded"
    }
}

# ---- Output ---------------------------------------------------------------

Write-Host ""
Write-Host "Playwriter bridge – doctor report"
Write-Host "========================================="

foreach ($r in $results) {
    $color = switch ($r.Status) {
        'green' { 'Green' }
        'amber' { 'Yellow' }
        'red'   { 'Red' }
        default { 'Gray' }
    }
    $tag = switch ($r.Status) {
        'green' { '[OK]  ' }
        'amber' { '[WARN]' }
        'red'   { '[FAIL]' }
        default { '[??]  ' }
    }
    Write-Host ("{0} {1,-32} {2}" -f $tag, $r.Check, $r.Detail) -ForegroundColor $color
    if ($r.Remedy) {
        Write-Host ("       -> {0}" -f $r.Remedy) -ForegroundColor DarkGray
    }
}

if ($handoffs.Count -gt 0) {
    Write-Host ""
    Write-Host "VM-side action required. Paste the block(s) below to a coding agent on the VM."
    Write-Host "----------------------------------------------------------------------------"
    foreach ($h in $handoffs) {
        Write-Host ""
        Write-Host $h
    }
    Write-Host ""
}

# Wrap in @(...) so a single scalar pipeline result still has a reliable
# .Count. PowerShell's scalar-vs-array collapse has bitten this check
# before – @() makes the count deterministic.
$redCount = @($results | Where-Object { $_.Status -eq 'red' }).Count
if ($redCount -gt 0) { exit 1 }
exit 0
