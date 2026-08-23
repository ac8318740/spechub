# opener.ps1 - SpecHub document opener, with auto-reconnect.
#
# Runs opener.js (Node) in a loop, the same shape relay.ps1 uses for the
# Playwriter relay. Intended to be invoked through launcher.exe by a scheduled
# task registered by register-tasks.ps1. Logs to
# %LOCALAPPDATA%\playwriter-bridge\opener-supervisor.log.
#
# The opener is what shows a page from a dev VM in this machine's default
# browser. It is not the bridge - see docs/adr/0002-document-opener-service.md
# for why those are two services and not one.
#
# Console hiding is handled by launcher.exe (spawns PowerShell with
# CREATE_NO_WINDOW). Nothing to do here.

$ErrorActionPreference = "Continue"

$logDir = Join-Path $env:LOCALAPPDATA "playwriter-bridge"
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$logFile = Join-Path $logDir "opener-supervisor.log"
$tokenFile = Join-Path $logDir "opener.token"

function Write-Log {
    param([string]$Message)
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Out-File -Append -FilePath $logFile
}

# The service refuses every request from the VM without this, so generate it
# rather than starting a listener nobody can talk to. register-tasks.ps1 copies
# whatever is here to the VM; generating it here too means the service is never
# running tokenless, whichever ran first.
if (-not (Test-Path $tokenFile)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
    Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
    Write-Log "Generated opener token at $tokenFile"
}

$openerJs = Join-Path $PSScriptRoot "opener.js"
if (-not (Test-Path $openerJs)) {
    Write-Log "FATAL: opener.js not found beside this script at $openerJs"
    exit 1
}

function Resolve-NodeCommand {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "'node' is not on PATH. Install Node LTS - the Playwriter relay needs it too."
    }
    return $node.Source
}

while ($true) {
    try {
        $node = Resolve-NodeCommand
        Write-Log "Starting opener ($node $openerJs)"
        & $node $openerJs 2>&1 | Out-File -Append -FilePath $logFile
        Write-Log "Opener exited (code $LASTEXITCODE), sleeping 5s"
    } catch {
        Write-Log "Error: $($_.Exception.Message). Sleeping 5s"
    }
    Start-Sleep -Seconds 5
}
