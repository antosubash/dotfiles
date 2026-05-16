#Requires -Version 5.1
<#
.SYNOPSIS
    Update every package manager, language runtime, and PowerShell module
    on a Windows machine. Windows analog of update-all.sh.

.PARAMETER Quick
    Skip the slow pieces (PowerShell module updates, dotnet workloads,
    WSL distro upgrade). Matches update-quick.sh in spirit.

.PARAMETER SkipWSL
    Don't run apt upgrades inside WSL.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\scripts\update-windows.ps1
.EXAMPLE
    pwsh -File .\scripts\update-windows.ps1 -Quick
#>

[CmdletBinding()]
param(
    [switch]$Quick,
    [switch]$SkipWSL
)

$ErrorActionPreference = 'Continue'  # never abort the whole script on one failure
$ProgressPreference    = 'SilentlyContinue'

function Write-Section { param([string]$T) Write-Host "`n=== $T ===" -ForegroundColor Cyan }
function Write-Info    { param([string]$M) Write-Host "  $M" -ForegroundColor Gray }
function Write-Ok      { param([string]$M) Write-Host "  $M" -ForegroundColor Green }
function Write-Warn2   { param([string]$M) Write-Host "  $M" -ForegroundColor Yellow }
function Write-Err2    { param([string]$M) Write-Host "  $M" -ForegroundColor Red }

function Test-Command  { param([string]$N) [bool](Get-Command $N -ErrorAction SilentlyContinue) }

# ---------------------------------------------------------------------------
# winget
# ---------------------------------------------------------------------------

if (Test-Command winget) {
    Write-Section "winget"
    winget upgrade --all --include-unknown --silent `
        --accept-source-agreements --accept-package-agreements
} else {
    Write-Warn2 "winget not found, skipping."
}

# ---------------------------------------------------------------------------
# scoop
# ---------------------------------------------------------------------------

if (Test-Command scoop) {
    Write-Section "scoop"
    scoop update
    scoop update '*'
    if (-not $Quick) {
        Write-Info "Cleaning old scoop versions..."
        scoop cleanup '*'
        scoop cache rm '*'
    }
} else {
    Write-Warn2 "scoop not found, skipping."
}

# ---------------------------------------------------------------------------
# Language toolchains
# ---------------------------------------------------------------------------

if (Test-Command rustup) {
    Write-Section "rustup"
    rustup update
}

if ((Test-Command dotnet) -and (-not $Quick)) {
    Write-Section "dotnet workloads"
    dotnet workload update
}

if (Test-Command uv) {
    Write-Section "uv"
    uv self update
}

if (Test-Command pnpm) {
    Write-Section "pnpm"
    pnpm self-update
}

if (Test-Command npm) {
    Write-Section "npm (global packages)"
    npm update -g
}

# ---------------------------------------------------------------------------
# PowerShell modules
# ---------------------------------------------------------------------------

if (-not $Quick) {
    Write-Section "PowerShell modules"
    try {
        $modules = Get-InstalledModule -ErrorAction SilentlyContinue
        if ($modules) {
            foreach ($m in $modules) {
                Write-Info "Updating $($m.Name)..."
                try { Update-Module -Name $m.Name -ErrorAction Stop }
                catch { Write-Warn2 "  $($m.Name): $($_.Exception.Message)" }
            }
            Write-Ok "Modules updated."
        } else {
            Write-Info "No PowerShellGet-managed modules found."
        }
    } catch {
        Write-Warn2 "Module update failed: $_"
    }
}

# ---------------------------------------------------------------------------
# oh-my-posh self-upgrade
# ---------------------------------------------------------------------------

if (Test-Command oh-my-posh) {
    Write-Section "oh-my-posh"
    oh-my-posh upgrade
}

# ---------------------------------------------------------------------------
# WSL distros
# ---------------------------------------------------------------------------

if ((-not $SkipWSL) -and (Test-Command wsl) -and (-not $Quick)) {
    Write-Section "WSL distros"
    Write-Info "Updating WSL kernel..."
    wsl --update
    $distros = & wsl.exe --list --quiet 2>$null | Where-Object { $_ -and $_ -notmatch '^\s*$' }
    foreach ($d in $distros) {
        $name = $d.Trim()
        if (-not $name) { continue }
        Write-Info "apt update/upgrade inside $name..."
        wsl -d $name -- bash -lc 'sudo apt update && sudo apt upgrade -y && sudo apt autoremove -y'
    }
}

Write-Section "Done"
Write-Host "  Update pass complete." -ForegroundColor Green
if ($Quick) { Write-Host "  Ran in -Quick mode; re-run without -Quick for a full pass." -ForegroundColor Yellow }
