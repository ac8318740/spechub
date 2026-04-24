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
# - Transient network errors (connection refused / timed out / no route) are
#   retried with exponential backoff 5 → 10 → 20 → 40 → 80 → 120 s cap.
# - Successful bind (process ran at least 30 s) resets the backoff.
# - Three consecutive "remote port forwarding failed" results exit the
#   script and write a stuck marker. A stuck remote port never clears
#   itself; spinning is pure cost.
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

# Clear any previous stuck marker on start. The script only writes a new
# one when it decides to exit.
Remove-Item $markerFile -ErrorAction SilentlyContinue

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
    if ($joined -match 'Connection refused|Connection timed out|No route to host|Network is unreachable|Could not resolve hostname') {
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
            if ($stuckStreak -ge 3) {
                Write-Log -State 'fatal' -ExitCode $code -Message "Stuck remote port (3 consecutive). Writing marker and exiting."
                Write-Marker -Reason 'remote port forwarding failed – port 19988 already bound on VM' `
                    -Remediation "Run vm-free-port.sh on $TargetHost, then retrigger this task from Task Scheduler."
                exit 10
            }
            # Short wait between stuck attempts; sshd cleanup might free
            # the port in rare cases (e.g. ClientAlive just fired).
            Start-Sleep -Seconds 10
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
            $stuckStreak = 0
            if ($ranSeconds -ge 30) { $backoffIndex = 0 }
            $wait = $backoff[[Math]::Min($backoffIndex, $backoff.Length - 1)]
            Write-Log -State 'retry' -ExitCode $code -Message "Sleeping ${wait}s (class=$class, lasted $([int]$ranSeconds)s)"
            Start-Sleep -Seconds $wait
            if ($backoffIndex -lt $backoff.Length - 1) { $backoffIndex++ }
        }
    }
}
