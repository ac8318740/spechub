# tunnel.ps1 – Reverse SSH tunnel with auto-reconnect.
#
# Opens `ssh -N -R 19988:127.0.0.1:19988 <user>@<host>` so the VM can reach
# the local Playwriter relay at 127.0.0.1:19988. Intended to be invoked by a
# scheduled task registered by register-tasks.ps1. Logs to
# %LOCALAPPDATA%\playwriter-bridge\tunnel-<host>.log.
#
# ExitOnForwardFailure=yes is load-bearing: if the remote side already has
# something bound to 19988 (stale forward), ssh would otherwise report success
# without the forward and the bridge would silently not work.

param(
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [Parameter(Mandatory = $false)]
    [string]$User = $env:USERNAME
)

$ErrorActionPreference = "Continue"

$logDir = Join-Path $env:LOCALAPPDATA "playwriter-bridge"
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$logFile = Join-Path $logDir "tunnel-$TargetHost.log"

function Write-Log {
    param([string]$Message)
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Out-File -Append -FilePath $logFile
}

$sshExe = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
if (-not (Test-Path $sshExe)) {
    $onPath = Get-Command ssh -ErrorAction SilentlyContinue
    if ($onPath) { $sshExe = $onPath.Source }
    else { throw "ssh.exe not found. Enable the Windows OpenSSH Client optional feature." }
}

$remote = "$User@$TargetHost"

while ($true) {
    Write-Log "Starting tunnel to $remote"
    & $sshExe -N `
        -R 19988:127.0.0.1:19988 `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ExitOnForwardFailure=yes `
        -o BatchMode=yes `
        -o StrictHostKeyChecking=accept-new `
        $remote 2>&1 | Out-File -Append -FilePath $logFile
    Write-Log "Tunnel to $remote exited (code $LASTEXITCODE), sleeping 5s"
    Start-Sleep -Seconds 5
}
