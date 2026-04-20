# relay.ps1 – Playwriter relay with auto-reconnect.
#
# Runs `playwriter serve --host 127.0.0.1 --replace` in a loop. Intended to
# be invoked through launcher.exe by a scheduled task registered by
# register-tasks.ps1. Logs to %LOCALAPPDATA%\playwriter-bridge\relay.log.
#
# Console hiding is handled by launcher.exe (spawns PowerShell with
# CREATE_NO_WINDOW). Nothing to do here.

$ErrorActionPreference = "Continue"

$logDir = Join-Path $env:LOCALAPPDATA "playwriter-bridge"
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$logFile = Join-Path $logDir "relay.log"

function Write-Log {
    param([string]$Message)
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" | Out-File -Append -FilePath $logFile
}

function Resolve-PlaywriterCommand {
    # Prefer the npm shim on PATH – it routes through Node correctly without
    # us needing to know where either lives.
    $cmd = Get-Command playwriter -ErrorAction SilentlyContinue
    if ($cmd) { return @{ Exe = $cmd.Source; Args = @() } }

    # Fallback: invoke Node directly against the installed CLI JS.
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Neither 'playwriter' nor 'node' is on PATH. Install Node LTS and 'npm install -g playwriter' first."
    }
    $cliJs = Join-Path $env:APPDATA "npm\node_modules\playwriter\dist\cli.js"
    if (-not (Test-Path $cliJs)) {
        throw "Found Node but not Playwriter CLI at $cliJs. Run 'npm install -g playwriter'."
    }
    return @{ Exe = $node.Source; Args = @($cliJs) }
}

while ($true) {
    try {
        $resolved = Resolve-PlaywriterCommand
        Write-Log "Starting Playwriter relay ($($resolved.Exe))"
        $allArgs = $resolved.Args + @("serve", "--host", "127.0.0.1", "--replace")
        & $resolved.Exe @allArgs 2>&1 | Out-File -Append -FilePath $logFile
        Write-Log "Relay exited (code $LASTEXITCODE), sleeping 5s"
    } catch {
        Write-Log "Error: $($_.Exception.Message). Sleeping 5s"
    }
    Start-Sleep -Seconds 5
}
