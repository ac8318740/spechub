# register-tasks.ps1 – Register Playwriter bridge scheduled tasks.
#
# Creates three kinds of scheduled tasks, all at user logon, LogonType=Interactive:
#
#   Playwriter-Relay         – runs relay.ps1 (always one)
#   Playwriter-Tunnel-VM1    – runs tunnel.ps1 -TargetHost <vm1>
#   Playwriter-Tunnel-VM2    – runs tunnel.ps1 -TargetHost <vm2>
#   ...                       (one per VM in -VMs, auto-numbered)
#
# The tasks run as the current user, so the ssh-agent named pipe (SID-ACL'd
# to the user) stays reachable and no password is ever stored. Console
# windows are hidden by relay.ps1 and tunnel.ps1 via an in-process
# ShowWindow call – expect a brief flash at logon, then nothing.
#
# Usage:
#
#   .\register-tasks.ps1 -VMs @("vm1.example.com", "vm2.internal")
#   .\register-tasks.ps1 -VMs @("vm1.example.com") -TunnelUser dev
#
# A fresh install does not need admin. Re-registering tasks that were
# previously created from an elevated shell will fail with "Access is
# denied" – re-run this script from an elevated PowerShell in that case.
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

# Soft elevation check. Fresh installs register fine without admin. Replacing
# tasks that were previously registered from an elevated shell does require
# admin – warn now so the user knows what to do if Register-ScheduledTask
# later throws "Access is denied".
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Not running elevated. Fresh installs work fine. If the tasks already exist and were registered elevated, Register-ScheduledTask will fail with 'Access is denied' – re-run this from an elevated PowerShell in that case."
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
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
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
