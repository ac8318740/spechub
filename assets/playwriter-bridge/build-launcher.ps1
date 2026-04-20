# build-launcher.ps1 – one-shot: compile launcher-src.cs to launcher.exe.
#
# Run this once before register-tasks.ps1. The launcher.exe it produces is a
# tiny WindowsApplication (no console allocated) that starts the child
# PowerShell with CREATE_NO_WINDOW. Without this shim, relay.ps1 and
# tunnel.ps1 would show console windows at logon under the Windows 11 22H2+
# default terminal host (Windows Terminal).
#
# No admin, no SDK install – PowerShell's Add-Type compiles in-place against
# the .NET Framework libs already on the machine.

$scriptsDir = $PSScriptRoot
if (-not $scriptsDir) { $scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

$srcPath = Join-Path $scriptsDir "launcher-src.cs"
$outPath = Join-Path $scriptsDir "launcher.exe"

if (-not (Test-Path $srcPath)) {
    Write-Error "Missing $srcPath. Copy launcher-src.cs into the same directory as this script."
    exit 1
}

$src = Get-Content $srcPath -Raw
Add-Type -TypeDefinition $src -OutputAssembly $outPath -OutputType WindowsApplication

Write-Host "Built: $outPath"
Get-Item $outPath | Select-Object Name, Length, LastWriteTime | Format-List
