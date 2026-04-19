# register-tasks.ps1 – Register Playwriter bridge scheduled tasks.
#
# Creates three kinds of scheduled tasks, all at user logon, LogonType=S4U
# (batch logon – no desktop session, so no console window ever appears):
#
#   Playwriter-Relay         – runs relay.ps1 (always one)
#   Playwriter-Tunnel-VM1    – runs tunnel.ps1 -TargetHost <vm1>
#   Playwriter-Tunnel-VM2    – runs tunnel.ps1 -TargetHost <vm2>
#   ...                       (one per VM in -VMs, auto-numbered)
#
# S4U registration requires admin. Runtime runs as the invoking user – so the
# ssh-agent named pipe (SID-ACL'd to the user) stays reachable and no password
# is ever stored.
#
# Usage (from an elevated PowerShell):
#
#   .\register-tasks.ps1 -VMs @("vm1.example.com", "vm2.internal")
#   .\register-tasks.ps1 -VMs @("vm1.example.com") -TunnelUser dev
#
# Scripts are expected to live in %USERPROFILE%\playwriter-bridge\ by default.

param(
    [Parameter(Mandatory = $true)]
    [string[]]$VMs,

    [Parameter(Mandatory = $false)]
    [string]$TunnelUser = $env:USERNAME,

    [Parameter(Mandatory = $false)]
    [string]$ScriptsDir = (Join-Path $env:USERPROFILE "playwriter-bridge")
)

$ErrorActionPreference = "Stop"

# Elevation check – S4U registration requires admin. Fail fast with a clear
# message rather than letting Register-ScheduledTask throw "Access is denied".
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "register-tasks.ps1 must be run from an elevated PowerShell (Run as Administrator). S4U task registration requires admin; the tasks themselves will run as the current user at runtime."
    exit 1
}

# Validate that the script files are actually where we expect them.
foreach ($file in @("relay.ps1", "tunnel.ps1")) {
    $full = Join-Path $ScriptsDir $file
    if (-not (Test-Path $full)) {
        Write-Error "Missing required script: $full. Copy relay.ps1 and tunnel.ps1 into $ScriptsDir before running this."
        exit 1
    }
}

$psExe = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$userId = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId

function Register-BridgeTask {
    param(
        [string]$Name,
        [string]$ScriptFile,
        [string[]]$ExtraArgs = @()
    )
    $scriptPath = Join-Path $ScriptsDir $ScriptFile
    $psArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$scriptPath`""
    ) + $ExtraArgs
    $argString = $psArgs -join ' '

    $action = New-ScheduledTaskAction -Execute $psExe -Argument $argString

    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask `
        -TaskName $Name `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings | Out-Null

    Write-Host "Registered: $Name"
}

Register-BridgeTask -Name "Playwriter-Relay" -ScriptFile "relay.ps1"

for ($i = 0; $i -lt $VMs.Count; $i++) {
    $vm = $VMs[$i]
    $taskName = "Playwriter-Tunnel-VM$($i + 1)"
    Register-BridgeTask `
        -Name $taskName `
        -ScriptFile "tunnel.ps1" `
        -ExtraArgs @("-TargetHost", $vm, "-User", $TunnelUser)
}

Write-Host ""
Write-Host "Starting tasks..."
Start-ScheduledTask -TaskName "Playwriter-Relay"
Start-Sleep -Seconds 2
for ($i = 0; $i -lt $VMs.Count; $i++) {
    Start-ScheduledTask -TaskName "Playwriter-Tunnel-VM$($i + 1)"
}

Write-Host "Done. Logs: $env:LOCALAPPDATA\playwriter-bridge\"
