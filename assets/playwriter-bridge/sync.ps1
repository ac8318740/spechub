# sync.ps1 - Reconcile the deployed Playwriter bridge with the plugin cache.
#
# The bridge runs as OS scheduled tasks from %USERPROFILE%\playwriter-bridge\,
# a location that does not track the plugin version. A plugin auto-update
# refreshes the cache but never reaches those deployed copies, and a running
# tunnel.ps1 will not pick up a new script without a restart. This script
# closes that gap: it is invoked by the SpecHub SessionStart hook, compares
# each deployed script against the cache by content hash, copies the ones that
# changed, rebuilds launcher.exe when its source changed, and restarts only the
# affected tasks.
#
# It is a quiet no-op unless the bridge is actually installed (deploy dir
# present AND at least one Playwriter-* task registered), so it costs nothing
# for sessions and machines that never use the bridge.
#
# Runs as the current user, non-elevated - same rights the scheduled tasks use.

param(
    [Parameter(Mandatory = $true)]
    [string]$PluginRoot,

    [Parameter(Mandatory = $false)]
    [string]$ScriptsDir = (Join-Path $env:USERPROFILE "playwriter-bridge")
)

$ErrorActionPreference = 'Continue'

# Relay, tunnel and launcher only exist on Windows.
if ($env:OS -ne 'Windows_NT') { exit 0 }

$cacheDir = Join-Path $PluginRoot 'assets\playwriter-bridge'
if (-not (Test-Path $cacheDir)) { exit 0 }

# Gate: only act when the bridge is installed.
if (-not (Test-Path $ScriptsDir)) { exit 0 }
$tasks = @(Get-ScheduledTask -TaskName 'Playwriter-*' -ErrorAction SilentlyContinue)
if ($tasks.Count -eq 0) { exit 0 }

# Windows-side runtime files. vm-free-port.sh is VM-only; sync.ps1 itself runs
# from the cache and is never deployed.
$files = @(
    'launcher-src.cs',
    'build-launcher.ps1',
    'relay.ps1',
    'tunnel.ps1',
    'register-tasks.ps1',
    'stop.ps1',
    'doctor.ps1',
    'opener.ps1',
    'opener.js'
)

function Get-FileHashOrNull($path) {
    if (-not (Test-Path $path)) { return $null }
    return (Get-FileHash -Path $path -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
}

$changed = @()
foreach ($f in $files) {
    $src = Join-Path $cacheDir $f
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $ScriptsDir $f
    if ((Get-FileHashOrNull $src) -ne (Get-FileHashOrNull $dst)) { $changed += $f }
}

if ($changed.Count -eq 0) { exit 0 }

Write-Host "spechub bridge: $($changed.Count) script(s) changed in the plugin cache: $($changed -join ', ')"

# Concurrency guard: two Claude Code sessions can start near-simultaneously and
# both pass the hash gate above, then race on copy/rebuild/stop-start. A system
# mutex serializes the mutating section so only one session reconciles at a time.
# Creation can require elevation in some environments - if that fails we proceed
# without the guard rather than crashing the hook.
$mutex = $null
try {
    $mutex = New-Object System.Threading.Mutex($false, 'Global\spechub-bridge-sync')
} catch {
    $mutex = $null
}
if ($mutex) {
    $haveLock = $false
    try { $haveLock = $mutex.WaitOne(2000) } catch { $haveLock = $false }
    if (-not $haveLock) {
        Write-Host "spechub bridge: another session is already syncing - skipping."
        $mutex.Dispose()
        exit 0
    }
}

# Everything from here mutates the deploy dir, so it runs inside try/finally to
# guarantee the mutex is released on every exit path (including the FIX A early
# exit below - PowerShell runs finally even when 'exit' fires inside the try).
try {

# Restart eligibility, snapshotted BEFORE we stop anything. A Running task is
# restarted so the fix goes live. A Ready task is restarted only if it ended on
# a failure (e.g. tunnel.ps1 exit 10) - that both applies the fix and recovers
# it. A Ready task that exited cleanly is left alone: the user stopped it on
# purpose. Benign last-result codes mirror doctor.ps1 - doctor.ps1 holds the
# canonical copy of this list; keep both in sync if either changes.
$benign = @(0, 267009, 267011, 267014)
$eligible = @{}
foreach ($t in $tasks) {
    $ok = $false
    if ($t.State -eq 'Running') {
        $ok = $true
    } elseif ($t.State -eq 'Ready') {
        $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction SilentlyContinue
        if ($info -and ($benign -notcontains [int]$info.LastTaskResult)) { $ok = $true }
    }
    $eligible[$t.TaskName] = $ok
}

$anyRunning = @($tasks | Where-Object { $_.State -eq 'Running' }).Count -gt 0

# A running task holds launcher.exe open, so it cannot be overwritten. When the
# launcher source changed, stop everything first to release the binary. Stopping
# is keyed off intent ($changed): stopping is always safe, and we must release
# the binary BEFORE the copy regardless of whether the copy later succeeds.
if (($changed -contains 'launcher-src.cs') -and $anyRunning) {
    foreach ($t in $tasks) { Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
}

# Copy the changed files into the deploy dir (byte copy preserves the BOM). Track
# which files ACTUALLY landed in $copied: a locked or permission-denied copy must
# not silently no-op and then trigger a restart on the stale script (that would
# re-thrash every session). Restart decisions below derive from $copied, not
# $changed, so a task whose backing script failed to copy is left alone.
$copied = @()
foreach ($f in $changed) {
    try {
        Copy-Item -Path (Join-Path $cacheDir $f) -Destination (Join-Path $ScriptsDir $f) -Force -ErrorAction Stop
        $copied += $f
    } catch {
        Write-Host "spechub bridge: copy FAILED for $f ($($_.Exception.Message)). Leaving its task as-is."
    }
}

# Decide which tasks each SUCCESSFULLY COPIED file forces a restart of:
#   launcher-src.cs -> every task (all run through launcher.exe)
#   relay.ps1       -> Playwriter-Relay
#   opener.ps1      -> Playwriter-Opener
#   opener.js       -> Playwriter-Opener (opener.ps1 supervises it, so the
#                      supervisor has to be bounced for the new code to run)
#   tunnel.ps1      -> every tunnel task, bridge and opener alike
# stop.ps1 / doctor.ps1 / build-launcher.ps1 / register-tasks.ps1 are invoked
# on demand, so a copy is enough - no restart.
# NOTE: any NEW task-backing script added to $files above must also be wired into
# this mapping, or it will deploy but never trigger a restart of its task.
$launcherChanged = $copied -contains 'launcher-src.cs'
$relayChanged    = $copied -contains 'relay.ps1'
$tunnelChanged   = $copied -contains 'tunnel.ps1'
$openerChanged   = ($copied -contains 'opener.ps1') -or ($copied -contains 'opener.js')

$affected = New-Object System.Collections.Generic.HashSet[string]
if ($launcherChanged) {
    foreach ($t in $tasks) { [void]$affected.Add($t.TaskName) }
} else {
    if ($relayChanged) { [void]$affected.Add('Playwriter-Relay') }
    if ($openerChanged) { [void]$affected.Add('Playwriter-Opener') }
    if ($tunnelChanged) {
        # Both families run tunnel.ps1. 'Playwriter-Tunnel-*' alone would miss
        # the opener's tunnel tasks, which are named Playwriter-OpenerTunnel-*.
        foreach ($t in $tasks) {
            if ($t.TaskName -like 'Playwriter-Tunnel-*' -or $t.TaskName -like 'Playwriter-OpenerTunnel-*') {
                [void]$affected.Add($t.TaskName)
            }
        }
    }
}

$restartList = @($affected | Where-Object { $eligible[$_] })

# Rebuild launcher.exe from the freshly copied source. $rebuildOk starts true
# (true when no rebuild was needed); the catch and a missing output both clear
# it. If launcher-src.cs failed to copy, $launcherChanged is already false, so
# no rebuild is attempted and the source is stale - that is also a
# rebuild-can't-happen case, so we force $rebuildOk false to skip the restart.
$rebuildOk = $true
if ($launcherChanged) {
    try {
        & (Join-Path $ScriptsDir 'build-launcher.ps1') | Out-Null
        if (Test-Path (Join-Path $ScriptsDir 'launcher.exe')) {
            Write-Host "spechub bridge: rebuilt launcher.exe"
        } else {
            $rebuildOk = $false
            Write-Host "spechub bridge: launcher rebuild produced no launcher.exe."
        }
    } catch {
        $rebuildOk = $false
        Write-Host "spechub bridge: launcher rebuild FAILED ($($_.Exception.Message))."
    }
} elseif (($changed -contains 'launcher-src.cs') -and -not ($copied -contains 'launcher-src.cs')) {
    # launcher-src.cs changed but the copy failed: the deployed source is stale
    # and launcher.exe cannot be trusted to match it, so do not restart anything.
    $rebuildOk = $false
}

# If the rebuild did not produce a good launcher.exe, the tasks were already
# stopped above to release the binary. Restarting any of them now would run them
# against a broken or missing exe and leave the bridge down. Skip the restart
# loop, surface a loud actionable message, and leave the tasks stopped.
if (-not $rebuildOk) {
    Write-Host "spechub bridge: launcher.exe is NOT in a known-good state - skipping all task restarts. Run build-launcher.ps1 manually, then start the Playwriter-* tasks."
    exit 0
}

# Restart the affected, eligible tasks. Stop is a no-op if a task is already
# stopped (e.g. it was stopped above for the launcher rebuild, or it had failed).
foreach ($name in $restartList) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Write-Host "spechub bridge: restarted $name"
}

exit 0

} finally {
    # Release the mutex on every exit path. Runs even when 'exit' fires inside the
    # try above (FIX A early exit, the normal exit 0, or an uncaught throw).
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch { }
        $mutex.Dispose()
    }
}
