# tunnel.ps1 – Reverse SSH tunnel with exponential backoff and fatal-error
# classification.
#
# Opens `ssh -N -R 19988:127.0.0.1:19988 <user>@<host>` so the VM can reach
# the local Playwriter relay at 127.0.0.1:19988. Intended to be invoked by a
# scheduled task registered by register-tasks.ps1. Logs to
# %LOCALAPPDATA%\playwriter-bridge\tunnel-<host>.log.
#
# ExitOnForwardFailure=yes is load-bearing: if the remote side already has
# something bound to 19988 (stale forward), ssh would otherwise report
# success without the forward and the bridge would silently not work.
#
# Retry policy:
# - Transient errors (connection refused / timed out / no route / TCP reset
#   under a live session / Win32 connect "Unknown error") are retried with
#   exponential backoff 5 → 10 → 20 → 40 → 80 → 120 s cap.
# - Successful bind (process ran at least 30 s) resets the backoff.
# - "remote port forwarding failed" is retried for as long as it takes, and
#   never surrendered. It clears once the VM's sshd reaps the orphaned
#   forward channel left by the dropped session (ClientAliveInterval ×
#   ClientAliveCountMax – ~90 s on a VM configured per the runbook, up to
#   ~360 s on a default/cloud-image VM), and a holder that outlasts that is
#   still a port that comes back the moment someone frees it. The wait grows
#   30 → 60 → 120 s and caps there, so a long wedge costs one attempt every
#   two minutes rather than a hammered port. After 8 consecutive stuck
#   attempts (~11 min) the port is held by something the reaper is not going
#   to release, so a stuck marker goes down for doctor.ps1 to report – but the
#   retries carry on underneath it, and the marker is cleared as soon as a
#   forward stays bound for 30 s, observed live rather than after ssh exits.
# - "Permission denied" or "Host key verification failed" exit immediately
#   with a marker. These require user action.
#
# Marker file: tunnel-<host>.stuck next to the log. Contains the reason,
# timestamp, and the last 20 log lines. doctor.ps1 reads this.
#
# Port 19988 is the bridge's canonical CDP port and is the default here.
# Port 19989 carries the document opener, registered as a second task
# instance of this same script. 19988 is hardcoded across
# the setup. If you ever need to change it, update every occurrence in:
#   assets/playwriter-bridge/{tunnel.ps1, relay.ps1, stop.ps1, doctor.ps1,
#                             register-tasks.ps1, vm-free-port.sh}
#   agents/frontend-verifier.md, skills/browser-verify/SKILL.md,
#   skills/bridge/{SKILL.md, SKILL-WINDOWS.md, SKILL-VM.md, HANDOFF.md}
# The relay binds it via `playwriter serve`'s default; the rest reference
# it literally.

param(
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [Parameter(Mandatory = $false)]
    [string]$User = $env:USERNAME,

    # Which port to carry. 19988 is the bridge's CDP port; 19989 is the
    # document opener. They are forwarded by separate task instances rather
    # than as two -R flags on one connection, deliberately: with
    # ExitOnForwardFailure=yes a single wedged port fails the whole ssh, so
    # sharing a connection would let a stuck opener port take the bridge down
    # with it. Separate connections keep the two failures independent.
    [Parameter(Mandatory = $false)]
    [int]$Port = 19988
)

# Console hiding is handled by launcher.exe (spawns PowerShell with
# CREATE_NO_WINDOW). Nothing to do here.

$ErrorActionPreference = "Continue"

$logDir = Join-Path $env:LOCALAPPDATA "playwriter-bridge"
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$logSuffix = if ($Port -eq 19988) { "" } else { "-$Port" }
$logFile = Join-Path $logDir "tunnel-$TargetHost$logSuffix.log"
$markerFile = Join-Path $logDir "tunnel-$TargetHost$logSuffix.stuck"
# ssh is started as a child we can watch rather than run inline, so its streams
# have to land somewhere we can read after it exits. Two files: PowerShell 5.1
# refuses to redirect both streams to one.
$errFile = Join-Path $logDir "tunnel-$TargetHost$logSuffix.err"
$outFile = Join-Path $logDir "tunnel-$TargetHost$logSuffix.out"

# The stuck marker is NOT cleared on start. This loop never exits on a wedged
# port, but the task can still be restarted underneath it, and clearing on
# start would let doctor.ps1 sample green during a still-wedged restart. The
# marker reflects "still needs attention until a real bind succeeds" – it is
# cleared only after a successful bind (see the proof-of-life path below).

function Write-Log {
    param(
        [string]$State,
        [int]$ExitCode,
        [string]$Message
    )
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[$ts] [$State] [$ExitCode] $Message" | Out-File -Append -FilePath $logFile -Encoding utf8
}

function Rotate-Log {
    if (-not (Test-Path $logFile)) { return }
    $size = (Get-Item $logFile).Length
    if ($size -lt 1MB) { return }
    $prior = "$logFile.1"
    Remove-Item $prior -ErrorAction SilentlyContinue
    Move-Item $logFile $prior -ErrorAction SilentlyContinue
}

function Write-Marker {
    param(
        [string]$Reason,
        [string]$Remediation
    )
    $tail = @()
    if (Test-Path $logFile) {
        $tail = Get-Content $logFile -Tail 20
    }
    $content = @()
    $content += "timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $content += "target: $remote"
    $content += "reason: $Reason"
    $content += "remediation: $Remediation"
    $content += ""
    $content += "--- last 20 log lines ---"
    $content += $tail
    $content | Out-File -FilePath $markerFile -Encoding utf8
}

function Classify-Output {
    param([string[]]$Lines)
    $joined = ($Lines -join "`n")
    if ($joined -match 'remote port forwarding failed for listen port') {
        return 'stuck-port'
    }
    if ($joined -match 'Permission denied \(publickey') {
        return 'auth-denied'
    }
    if ($joined -match 'Host key verification failed') {
        return 'host-key'
    }
    # 'Connection reset' / 'client_loop: send disconnect' is OpenSSH's message
    # when the TCP socket of a live session is reset under it (wifi roam, VPN
    # flap, suspend/resume). 'port <n>: Unknown error' is Win32-OpenSSH's
    # WSAEHOSTUNREACH/WSAENETUNREACH on connect. Both are recoverable network
    # events – classify transient so they back off and reconnect rather than
    # falling through to 'unknown'.
    if ($joined -match 'Connection refused|Connection timed out|Connection reset|client_loop: send disconnect|No route to host|Network is unreachable|Could not resolve hostname|port \d+: Unknown error') {
        return 'transient'
    }
    return 'unknown'
}

$sshExe = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
if (-not (Test-Path $sshExe)) {
    $onPath = Get-Command ssh -ErrorAction SilentlyContinue
    if ($onPath) { $sshExe = $onPath.Source }
    else { throw "ssh.exe not found. Enable the Windows OpenSSH Client optional feature." }
}

$remote = "$User@$TargetHost"

$backoff = @(5, 10, 20, 40, 80, 120)
$backoffIndex = 0
$stuckStreak = 0
$startFailStreak = 0

# Stuck-port retry policy. There is no budget: giving up hands recovery to the
# Scheduler backstop, which on a wedged port is a restart loop nobody watches,
# and the bridge is simply down between the exit and the restart. So the loop
# outlasts the wedge instead. The first wait is sized to the reap window and
# then doubles to a 120 s cap – the same ceiling the transient path uses – so
# a port held for hours costs one attempt every two minutes.
$stuckRetrySeconds = 30
$stuckMaxRetrySeconds = 120
$stuckWait = $stuckRetrySeconds
# How many consecutive stuck attempts before the port counts as genuinely held
# rather than mid-reap. The waits before the 8th attempt are
# 30 + 60 + 5 × 120 = 690 s, so the marker lands about 11 min in. That outlasts
# both a tightened (~90 s) and a default cloud-image (~360 s) reap window, so a
# marker written past it means a non-sshd holder or keepalive disabled –
# something a human has to clear. Retune this if the backoff above changes:
# with the doubling wait, a streak of 20 would be ~35 min, far too quiet.
$stuckMaxStreak = 8

while ($true) {
    Rotate-Log
    Write-Log -State 'start' -ExitCode 0 -Message "Starting tunnel to $remote"

    Remove-Item $errFile -ErrorAction SilentlyContinue
    Remove-Item $outFile -ErrorAction SilentlyContinue
    $sshArgs = @(
        '-N',
        '-R', "$($Port):127.0.0.1:$Port",
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        $remote
    )

    $startedAt = Get-Date
    $proc = $null
    try {
        $proc = Start-Process -FilePath $sshExe -ArgumentList $sshArgs -NoNewWindow -PassThru `
            -RedirectStandardError $errFile -RedirectStandardOutput $outFile
    } catch {
        Write-Log -State 'error' -ExitCode 1 -Message "Could not start ${sshExe}: $($_.Exception.Message)"
    }
    if (-not $proc) {
        # A start that never happened is a tunnel that is down, and it used to be
        # a silent one: the catch above logged 'error', backed off, and looped
        # forever with no marker and no state word doctor.ps1 scans for, so the
        # report stayed green on a tunnel that had never run. An orphaned ssh
        # still holding tunnel-<host>.err is enough to cause it - Remove-Item
        # fails, the redirect cannot open, and Start-Process throws.
        $startFailStreak++
        $startWait = $backoff[[Math]::Min($backoffIndex, $backoff.Length - 1)]
        Write-Log -State 'start-failed' -ExitCode 1 -Message "ssh did not start for $remote (attempt $startFailStreak); retrying in ${startWait}s."
        if ($startFailStreak -ge $stuckMaxStreak) {
            # Same threshold as a wedged port, for the same reason: past it,
            # this is not going to clear without a human.
            Write-Marker -Reason "ssh could not be started for $remote after $startFailStreak consecutive attempts" `
                -Remediation "Look in %LOCALAPPDATA%\playwriter-bridge for an orphaned ssh.exe holding tunnel-$TargetHost$logSuffix.err or .out, and check free disk space. Kill any stray ssh.exe carrying the -R $Port forward. This task keeps retrying, so it recovers on its own once the file is free."
        }
        Start-Sleep -Seconds $startWait
        if ($backoffIndex -lt $backoff.Length - 1) { $backoffIndex++ }
        continue
    }
    $startFailStreak = 0

    # Proof of life, taken while the tunnel is still up rather than after it
    # falls over. ExitOnForwardFailure=yes makes ssh die at once when the remote
    # port will not bind, so a child still running at 30 s IS a bound forward.
    # Waiting for the exit to notice that was the bug: a healthy tunnel stays up
    # for days, and until it dropped, a stuck marker from an earlier wedge sat
    # there with doctor.ps1 reporting red on a bridge that had worked all along.
    $provenAlive = $false
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 1
        if (-not $provenAlive -and ((Get-Date) - $startedAt).TotalSeconds -ge 30) {
            $provenAlive = $true
            $stuckStreak = 0
            $stuckWait = $stuckRetrySeconds
            $backoffIndex = 0
            Remove-Item $markerFile -ErrorAction SilentlyContinue
            Write-Log -State 'up' -ExitCode 0 -Message "Forward for port $Port bound to $remote and up for 30s. Backoff reset, any stuck marker cleared."
        }
    }
    $proc.WaitForExit()
    $code = $proc.ExitCode
    $ranSeconds = ((Get-Date) - $startedAt).TotalSeconds

    $output = @()
    foreach ($streamFile in @($errFile, $outFile)) {
        if (Test-Path $streamFile) { $output += @(Get-Content $streamFile -ErrorAction SilentlyContinue) }
    }

    $output | ForEach-Object { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ssh-stderr] [$code] $_" } |
        Out-File -Append -FilePath $logFile -Encoding utf8

    $class = Classify-Output -Lines $output
    Write-Log -State 'exit' -ExitCode $code -Message "Tunnel to $remote exited after $([int]$ranSeconds)s, class=$class"

    switch ($class) {
        'stuck-port' {
            $stuckStreak++
            if ($stuckStreak -ge $stuckMaxStreak) {
                # Past the reap window, so this is a holder the VM will not let
                # go of on its own. Say so where doctor.ps1 can read it – and
                # keep retrying, because the marker is a report, not a verdict:
                # the moment someone frees the port, the next attempt binds.
                Write-Log -State 'stuck' -ExitCode $code -Message "Port $Port still bound on $TargetHost after $stuckStreak consecutive attempts. Marker written; still retrying every ${stuckWait}s."
                Write-Marker -Reason "remote port forwarding failed – port $Port still bound on VM after $stuckStreak consecutive attempts (the VM's sshd has not reaped the orphaned forward channel)" `
                    -Remediation "Run ~/.claude/spechub/bin/vm-free-port.sh --port $Port on $TargetHost. This task is still retrying, so it will bind on its own once the port is free – no restart needed. If this recurs, tighten the VM's sshd ClientAliveInterval per the bridge SKILL-VM runbook so orphaned forwards reap faster."
            }
            # The port is held by the orphaned forward channel of the dropped
            # session. Wait for the VM's sshd ClientAlive reaper to release it;
            # the next attempt then binds. This is the bridge's self-heal path,
            # so the wait is sized to outlast the reap window, not a token 10 s,
            # and doubles to the cap so a long wedge is not hammered.
            Write-Log -State 'stuck-retry' -ExitCode $code -Message "Port $Port still held on $TargetHost (attempt $stuckStreak); waiting ${stuckWait}s for the VM to reap the orphaned forward."
            Start-Sleep -Seconds $stuckWait
            $stuckWait = [Math]::Min($stuckWait * 2, $stuckMaxRetrySeconds)
            continue
        }
        'auth-denied' {
            Write-Log -State 'fatal' -ExitCode $code -Message "Permission denied. Writing marker and exiting."
            Write-Marker -Reason 'Permission denied (publickey)' `
                -Remediation "Run 'ssh-add' on Windows and confirm the matching public key is in ~/.ssh/authorized_keys on $TargetHost."
            exit 11
        }
        'host-key' {
            Write-Log -State 'fatal' -ExitCode $code -Message "Host key verification failed. Writing marker and exiting."
            Write-Marker -Reason 'Host key verification failed' `
                -Remediation "Resolve the host key mismatch for $TargetHost before retrying."
            exit 12
        }
        default {
            # Transient or unknown – apply backoff. Reset if the previous
            # run lasted at least 30 s (implies the forward was bound and
            # the session stayed up).
            # A short transient blip must NOT zero the stuck-streak – only a
            # successful bind does, so the give-up budget can't be starved by
            # a single brief failure between stuck-port retries.
            # Backstop for a run the poll above never got to observe – a
            # suspend/resume can swallow its one-second ticks. On any normal
            # long run $provenAlive already did all of this; repeating it is
            # idempotent, and a run this long bound its forward either way.
            if ($ranSeconds -ge 30) {
                $stuckStreak = 0
                $stuckWait = $stuckRetrySeconds
                $backoffIndex = 0
                Remove-Item $markerFile -ErrorAction SilentlyContinue
            }
            $wait = $backoff[[Math]::Min($backoffIndex, $backoff.Length - 1)]
            Write-Log -State 'retry' -ExitCode $code -Message "Sleeping ${wait}s (class=$class, lasted $([int]$ranSeconds)s)"
            Start-Sleep -Seconds $wait
            if ($backoffIndex -lt $backoff.Length - 1) { $backoffIndex++ }
        }
    }
}
