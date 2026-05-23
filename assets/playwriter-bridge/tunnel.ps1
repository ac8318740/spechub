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
# - "remote port forwarding failed" is recoverable: it clears once the VM's
#   sshd reaps the orphaned forward channel left by the dropped session
#   (ClientAliveInterval × ClientAliveCountMax – ~90 s on a VM configured per
#   the runbook, up to ~360 s on a default/cloud-image VM). We retry it at a
#   30 s cadence for ~10 min so the bridge self-heals from a network drop
#   without a manual restart. Only after that window do we treat the port as
#   genuinely wedged (a non-sshd holder, or keepalive disabled), write a
#   stuck marker, and exit.
# - "Permission denied" or "Host key verification failed" exit immediately
#   with a marker. These require user action.
#
# Marker file: tunnel-<host>.stuck next to the log. Contains the reason,
# timestamp, and the last 20 log lines. doctor.ps1 reads this.
#
# Port 19988 is the bridge's canonical CDP port and is hardcoded across
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
    [string]$User = $env:USERNAME
)

# Console hiding is handled by launcher.exe (spawns PowerShell with
# CREATE_NO_WINDOW). Nothing to do here.

$ErrorActionPreference = "Continue"

$logDir = Join-Path $env:LOCALAPPDATA "playwriter-bridge"
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$logFile = Join-Path $logDir "tunnel-$TargetHost.log"
$markerFile = Join-Path $logDir "tunnel-$TargetHost.stuck"

# The stuck marker is NOT cleared on start. The scheduler can restart this
# task within its backstop window after an `exit 10`, so clearing on start
# would let doctor.ps1 sample green during a still-wedged restart loop. The
# marker now reflects "still needs attention until a real bind succeeds" – it
# is cleared only after a successful bind (see the proof-of-life path below).

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

# Stuck-port retry budget. "remote port forwarding failed" clears once the VM
# reaps the orphaned forward channel of the dropped session; we retry across
# that window before giving up. 20 × 30 s ≈ 10 min outlasts both a tightened
# (~90 s) and a default cloud-image (~360 s) reap window, so the bridge
# self-heals without a manual restart. Past that, the port is genuinely wedged.
$stuckRetrySeconds = 30
$stuckMaxStreak = 20

while ($true) {
    Rotate-Log
    Write-Log -State 'start' -ExitCode 0 -Message "Starting tunnel to $remote"

    $startedAt = Get-Date
    $output = & $sshExe -N `
        -R 19988:127.0.0.1:19988 `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ExitOnForwardFailure=yes `
        -o BatchMode=yes `
        -o StrictHostKeyChecking=accept-new `
        $remote 2>&1
    $code = $LASTEXITCODE
    $ranSeconds = ((Get-Date) - $startedAt).TotalSeconds

    $output | ForEach-Object { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ssh-stderr] [$code] $_" } |
        Out-File -Append -FilePath $logFile -Encoding utf8

    $class = Classify-Output -Lines $output
    Write-Log -State 'exit' -ExitCode $code -Message "Tunnel to $remote exited after $([int]$ranSeconds)s, class=$class"

    switch ($class) {
        'stuck-port' {
            $stuckStreak++
            if ($stuckStreak -ge $stuckMaxStreak) {
                $mins = [int]($stuckMaxStreak * $stuckRetrySeconds / 60)
                Write-Log -State 'fatal' -ExitCode $code -Message "Remote port still bound on $TargetHost after ~$mins min of retries. Writing marker and exiting."
                Write-Marker -Reason "remote port forwarding failed – port 19988 still bound on VM after ~$mins min of retries (the VM's sshd has not reaped the orphaned forward channel)" `
                    -Remediation "Run ~/.claude/spechub/bin/vm-free-port.sh on $TargetHost, then retrigger this task from Task Scheduler. If this recurs, tighten the VM's sshd ClientAliveInterval per the bridge SKILL-VM runbook so orphaned forwards reap faster."
                exit 10
            }
            # The port is held by the orphaned forward channel of the dropped
            # session. Wait for the VM's sshd ClientAlive reaper to release it;
            # the next attempt then binds. This is the bridge's self-heal path,
            # so the wait is sized to outlast the reap window, not a token 10 s.
            Write-Log -State 'stuck-retry' -ExitCode $code -Message "Port 19988 still held on $TargetHost (attempt $stuckStreak/$stuckMaxStreak); waiting ${stuckRetrySeconds}s for the VM to reap the orphaned forward."
            Start-Sleep -Seconds $stuckRetrySeconds
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
            if ($ranSeconds -ge 30) {
                $stuckStreak = 0
                $backoffIndex = 0
                # A real bind succeeded, so the bridge no longer needs
                # attention – clear any stuck marker left by a prior wedged run.
                Remove-Item $markerFile -ErrorAction SilentlyContinue
            }
            $wait = $backoff[[Math]::Min($backoffIndex, $backoff.Length - 1)]
            Write-Log -State 'retry' -ExitCode $code -Message "Sleeping ${wait}s (class=$class, lasted $([int]$ranSeconds)s)"
            Start-Sleep -Seconds $wait
            if ($backoffIndex -lt $backoff.Length - 1) { $backoffIndex++ }
        }
    }
}
