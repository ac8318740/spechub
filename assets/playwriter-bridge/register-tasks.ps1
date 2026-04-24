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
# to the user) stays reachable and no password is ever stored. Each task
# action invokes launcher.exe, which spawns PowerShell with
# CREATE_NO_WINDOW – no console is ever allocated, so there is no flash.
#
# Run build-launcher.ps1 first to produce launcher.exe; this script refuses
# to continue without it.
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

$launcherExe = Join-Path $ScriptsDir "launcher.exe"
if (-not (Test-Path $launcherExe)) {
    Write-Error "Missing launcher: $launcherExe. Run build-launcher.ps1 from $ScriptsDir first to compile it from launcher-src.cs."
    exit 1
}

$psExe = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"

# The scripts themselves own resilience (tunnel.ps1 has exponential backoff
# and fatal-error classification; relay.ps1 loops internally). The scheduler
# restart is a soft backstop for rare PowerShell-host crashes, not a retry
# engine. Keep it small so it does not fight manual stops.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

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
    # launcher.exe spawns args[0] (PowerShell) with CREATE_NO_WINDOW. Its
    # remaining args get joined and passed as PowerShell's Arguments. Any
    # path with spaces must be pre-quoted here.
    $launcherArgs = @(
        "`"$psExe`"",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$scriptPath`""
    ) + $ExtraArgs
    $argString = $launcherArgs -join ' '

    $action = New-ScheduledTaskAction -Execute $launcherExe -Argument $argString

    # Explicit Unregister: do NOT silently swallow "Access is denied".
    # Previous versions hid that error, then Register-ScheduledTask threw
    # a non-terminating CIM "Cannot create a file when that file already
    # exists" and the old task (possibly with stale settings) stayed put
    # while the script falsely reported success.
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        try {
            Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
        } catch {
            Write-Error ("Cannot replace task '{0}': {1}`n" -f $Name, $_.Exception.Message) -ErrorAction Continue
            Write-Error "This task was probably registered from an elevated PowerShell. Re-run this script from an elevated PowerShell (Run as Administrator)." -ErrorAction Continue
            throw "Unregister-ScheduledTask failed for $Name"
        }
    }

    try {
        Register-ScheduledTask `
            -TaskName $Name `
            -Action $action `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -ErrorAction Stop | Out-Null
    } catch {
        Write-Error ("Register-ScheduledTask failed for '{0}': {1}" -f $Name, $_.Exception.Message) -ErrorAction Continue
        throw
    }

    # Verify the new settings actually landed. Guards against a silent
    # partial failure where the task exists but with old settings. We check
    # every field whose property name is identical on the input
    # ScheduledTaskSettings object and on the fetched task's Settings – the
    # battery/idle switch-params invert to 'Disallow*'/'StopIf*' in the
    # stored representation and aren't safely comparable by name, so they
    # are left out. RestartCount, RestartInterval and ExecutionTimeLimit
    # map 1:1 on both sides and are the fields most likely to silently
    # reject.
    $check = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $check) {
        throw "Post-register check: task '$Name' is missing."
    }
    $fieldsToCheck = @('RestartCount', 'RestartInterval', 'ExecutionTimeLimit')
    $mismatches = @()
    foreach ($key in $fieldsToCheck) {
        $want = $settings.$key
        $got = $check.Settings.$key
        if ($got -ne $want) {
            $mismatches += ("{0}: got '{1}', expected '{2}'" -f $key, $got, $want)
        }
    }
    if ($mismatches.Count -gt 0) {
        throw ("Post-register check: task '{0}' has stale settings ({1}). The register silently applied stale settings – re-run from an elevated PowerShell." -f $Name, ($mismatches -join '; '))
    }

    Write-Host ("Registered: {0} ({1} settings fields verified: {2})" -f $Name, $fieldsToCheck.Count, ($fieldsToCheck -join ', '))
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
