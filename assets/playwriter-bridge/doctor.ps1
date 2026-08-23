# doctor.ps1 – Automated Playwriter bridge diagnosis (Windows side).
#
# Runs nine checks and prints a colour-coded table with one-line remediation
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
    #   one of our own fatal exit codes (11=auth, 12=host-key from
    #   tunnel.ps1 - a stuck port no longer exits, it keeps retrying).
    #   Flag as red.
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

# ---- Check 4b: the document opener ----------------------------------------
#
# The opener is what puts a page in the default browser here. It is a separate
# service from the relay on purpose - it needs no tab armed and no extension -
# so it gets its own rows rather than being folded into the bridge's.

$openerToken = Join-Path $env:LOCALAPPDATA 'playwriter-bridge\opener.token'
$openerListener = Get-NetTCPConnection -LocalPort 19989 -State Listen -ErrorAction SilentlyContinue
if (-not $openerListener) {
    Add-Result 'Opener listening on 19989' 'red' 'nothing listening on 127.0.0.1:19989' `
        'The opener task is not up. Run Start-ScheduledTask Playwriter-Opener, then check opener-supervisor.log.'
} else {
    Add-Result 'Opener listening on 19989' 'green' "PID $($openerListener.OwningProcess -join ',') listening"
}

if (-not (Test-Path $openerToken)) {
    Add-Result 'Opener token' 'red' 'no token file' `
        'Run register-tasks.ps1 to generate one and push it to each VM.'
} else {
    # A token here is only half of it: the dev machine needs the same bytes, and
    # nothing on this side can see whether it has them. Say so rather than
    # calling it green and leaving a VM that gets 401 on every request.
    Add-Result 'Opener token' 'green' 'present here (each VM needs the same copy at ~/.config/spechub/opener.token)'
}

if ($openerListener -and (Test-Path $openerToken)) {
    try {
        $tok = (Get-Content $openerToken -Raw).Trim()
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:19989/health' `
            -Headers @{ 'X-Spechub-Token' = $tok } `
            -TimeoutSec $CurlTimeoutSeconds -UseBasicParsing -ErrorAction Stop
        $h = $r.Content | ConvertFrom-Json
        $mermaid = if ($h.mermaid) { 'mermaid cached' } else { 'no mermaid cached yet (first push will send it)' }
        Add-Result 'Opener /health' 'green' "HTTP 200, $($h.docs) document(s) held, $mermaid"
    } catch {
        Add-Result 'Opener /health' 'red' "request failed: $($_.Exception.Message)" `
            'The port is open but the service is not answering. Restart Playwriter-Opener and read opener.log.'
    }
} else {
    Add-Result 'Opener /health' 'amber' 'skipped (no listener or no token)' ''
}

# ---- Check 5: tunnel log signatures ---------------------------------------

# tunnel.ps1 names both its log and its marker tunnel-<host> for the bridge's
# 19988 and tunnel-<host>-<port> for anything else. Stripping only the prefix
# would leave the host as '<host>-19989', not a machine anyone can ssh to, and
# would lose the one detail that says which port is wedged.
function Split-TunnelName {
    param([string]$BaseName)
    # Only a port register-tasks.ps1 registers its own tunnel task for can
    # appear as a suffix, and 19988 never gets one - so the opener's 19989 is
    # the whole list. Add to it if a third port is ever registered there.
    $suffixPorts = @(19989)
    $raw = ($BaseName -replace '^tunnel-', '')
    $name = $raw
    $port = 19988
    if ($raw -match '^(.+)-(\d+)$' -and $suffixPorts -contains [int]$Matches[2]) {
        $name = $Matches[1]
        $port = [int]$Matches[2]
    }
    return [pscustomobject]@{ Name = $name; Port = $port; Raw = $raw }
}

$stuckHosts = @()
$authHosts = @()
$hostKeyHosts = @()
$retryHosts = @()

if (Test-Path $logDir) {
    $stuckFiles = Get-ChildItem -Path $logDir -Filter 'tunnel-*.stuck' -ErrorAction SilentlyContinue
    foreach ($f in $stuckFiles) {
        $content = Get-Content $f.FullName -Raw
        # The split is deliberately narrow: host names end in digits all the
        # time, and on a bare \d+ the laptop 'alt-p14-12' would become host
        # 'alt-p14' on port 12, which vm-free-port.sh refuses.
        $split = Split-TunnelName -BaseName $f.BaseName
        # .Name, never .Raw: an opener marker's Raw is 'alt-p14-19989', which is
        # not a machine anyone can ssh to, and the auth and host-key handoffs
        # below tell a reader to run commands on it.
        $target = $split.Name
        $stuckHost = $split.Name
        $markerPort = $split.Port
        $suffix = if ($markerPort -eq 19988) { '' } else { "-$markerPort" }
        $entry = [pscustomobject]@{
            Name   = $stuckHost
            Port   = $markerPort
            Log    = "tunnel-$stuckHost$suffix.log"
            Marker = $f.FullName
            Label  = "$stuckHost`:$markerPort"
        }
        if ($content -match 'remote port forwarding failed') { $stuckHosts += $entry }
        elseif ($content -match 'Permission denied') { $authHosts += $target }
        elseif ($content -match 'Host key verification') { $hostKeyHosts += $target }
        else { $stuckHosts += $entry }  # unknown fatal - group with stuck for visibility
    }

    # The marker only lands after 8 consecutive stuck attempts, which is ~11 min
    # of a down bridge before anything is written. tunnel.ps1 logs a
    # [stuck-retry] line on every one of those attempts, so the log says it
    # first - and a row keyed only on tunnel-*.stuck cannot see it. That gap is
    # not hypothetical: during the orphan episode on the laptop, tunnel-*.log
    # carried a stuck-retry every 30 s while this row reported green.
    $logFiles = Get-ChildItem -Path $logDir -Filter 'tunnel-*.log' -ErrorAction SilentlyContinue
    foreach ($lf in $logFiles) {
        $split = Split-TunnelName -BaseName $lf.BaseName
        # A marker for the same host and port already reports this, in red.
        if ($stuckHosts | Where-Object { $_.Name -eq $split.Name -and $_.Port -eq $split.Port }) { continue }
        $lastRetry = $null
        $lastState = ''
        foreach ($line in (Get-Content $lf.FullName -Tail 200 -ErrorAction SilentlyContinue)) {
            if ($line -notmatch '^\[([^\]]+)\] \[(stuck-retry|start-failed)\]') { continue }
            # Write-Log's format in tunnel.ps1, fixed. A truncated or
            # half-written line parses as nothing and is skipped, rather than
            # throwing and taking the whole check down with it.
            $stamp = [datetime]::MinValue
            if ([datetime]::TryParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss',
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::None, [ref]$stamp)) {
                $lastRetry = $stamp
                $lastState = $Matches[2]
            }
        }
        # A log keeps its stuck-retry lines long after the port clears, so
        # without a horizon this row would stay amber forever on the strength of
        # a wedge that resolved days ago. 300 s is two of the capped 120 s waits
        # plus slack, so a tunnel still in its backoff is inside the window.
        if ($null -ne $lastRetry -and ((Get-Date) - $lastRetry).TotalSeconds -le 300) {
            $retryHosts += [pscustomobject]@{
                Name  = $split.Name
                Port  = $split.Port
                State = $lastState
                Label = "$($split.Name)`:$($split.Port) [$lastState]"
            }
        }
    }
}

if ($stuckHosts.Count -eq 0 -and $authHosts.Count -eq 0 -and $hostKeyHosts.Count -eq 0) {
    if ($retryHosts.Count -gt 0) {
        # Amber, not red: the port is held right now, but a tunnel two attempts
        # into its backoff may well bind on the next one. Red is reserved for a
        # marker, where the retries have already outlasted the VM's reaper and a
        # human has to act. Reporting both the same way either cries wolf or
        # buries the marker.
        $who = ($retryHosts | ForEach-Object { $_.Label }) -join ', '
        $free = ($retryHosts | ForEach-Object { "bash ~/.claude/spechub/bin/vm-free-port.sh --port $($_.Port)" } |
            Select-Object -Unique) -join ' ; '
        Add-Result 'Tunnel logs' 'amber' "tunnel retrying in the last 5 min: $who (no marker yet)" `
            "stuck-retry: the VM still holds the forward - run on that VM: $free. start-failed: ssh never launched on this laptop - kill any orphaned ssh.exe holding the tunnel log files."
    } else {
        Add-Result 'Tunnel logs' 'green' 'no stuck markers, no tunnel retrying a held port'
    }
} else {
    $parts = @()
    if ($stuckHosts.Count -gt 0) { $parts += "stuck port: $(($stuckHosts | ForEach-Object { $_.Label }) -join ', ')" }
    if ($authHosts.Count -gt 0)  { $parts += "auth denied: $($authHosts -join ', ')" }
    if ($hostKeyHosts.Count -gt 0) { $parts += "host key: $($hostKeyHosts -join ', ')" }
    # A marker on VM1 must not hide a live retry on VM2. There is one row for
    # every tunnel, so the retries have to ride along with the red verdict
    # rather than living only in the branch where nothing else went wrong.
    if ($retryHosts.Count -gt 0) { $parts += "retrying now: $(($retryHosts | ForEach-Object { $_.Label }) -join ', ')" }
    $remedy = 'See handoff blocks below.'
    Add-Result 'Tunnel logs' 'red' ($parts -join '; ') $remedy

    foreach ($h in $stuckHosts) {
        # The VM agent reading this has no other context, so every line has to
        # name the port that is actually wedged. vm-free-port.sh defaults to
        # the bridge's port, which is the wrong port whenever the marker was
        # the opener's, and a bare call would send it to free the wrong socket.
        $hn = $h.Name
        $hp = $h.Port
        $tail = ''
        if (Test-Path $h.Marker) { $tail = (Get-Content $h.Marker -Raw).Trim() }
        $handoffs += @"
--- BEGIN WINDOWS-SIDE HANDOFF (to VM agent on $hn) ---
Context: the Playwriter bridge tunnel to $hn is stuck on port $hp. $($h.Log)
shows "remote port forwarding failed for listen port $hp", meaning something
on the VM already holds that port. The tunnel task is still retrying, so it
will bind on its own once the port is free. Marker contents:

$tail

Run on ${hn}:
  bash ~/.claude/spechub/bin/vm-free-port.sh --port $hp

Expected result:
  ss -lnt 'sport = :$hp' is empty, or vm-free-port.sh refuses and tells
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
