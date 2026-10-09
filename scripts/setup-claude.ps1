#Requires -Version 5.1
<#
.SYNOPSIS
    Set up Claude Code on Windows from the dotfiles.

.DESCRIPTION
    Windows analog of setup-claude.sh. Links settings, global instructions,
    agents, commands, workflow refs and the status line scripts from
    .claude/ into $HOME\.claude\:

      .claude\settings.json   -> ~\.claude\settings.json
      .claude\CLAUDE.md       -> ~\.claude\CLAUDE.md
      .claude\workflow-refs\  -> ~\.claude\workflow-refs
      .claude\agents\         -> ~\.claude\agents
      .claude\commands\       -> ~\.claude\commands
      .claude\statusline.py   -> ~\.claude\statusline.py
      .claude\cc-sessions.py  -> ~\.claude\cc-sessions.py

    Existing non-link targets are moved to ~\.dotfiles_backup. Symlinks need
    Developer Mode (or an elevated session); directories fall back to a
    junction and files to a copy (re-run this script to refresh copies).

    Also installs psutil for the status line's CPU/RAM segments, since
    Windows has no /proc.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\scripts\setup-claude.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$DotfilesDir = Split-Path -Parent $PSScriptRoot
$ClaudeSrc   = Join-Path $DotfilesDir '.claude'
$ClaudeDir   = Join-Path $env:USERPROFILE '.claude'
$BackupDir   = Join-Path $env:USERPROFILE '.dotfiles_backup'

function Write-Info  { param([string]$M) Write-Host "  $M" -ForegroundColor Gray }
function Write-Ok    { param([string]$M) Write-Host "  $M" -ForegroundColor Green }
function Write-Warn2 { param([string]$M) Write-Host "  $M" -ForegroundColor Yellow }

foreach ($d in @($ClaudeDir, $BackupDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

function New-ClaudeLink {
    param(
        [Parameter(Mandatory)][string]$Name
    )
    $src    = Join-Path $ClaudeSrc $Name
    $target = Join-Path $ClaudeDir $Name

    if (-not (Test-Path $src)) {
        Write-Warn2 "Source not found: $src — skipping."
        return
    }

    $existing = Get-Item $target -Force -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.LinkType -in @('SymbolicLink','Junction')) {
            if ($existing.Target -contains $src) {
                Write-Ok "$target already linked."
                return
            }
            # Stale link: drop the link itself, never what it points at.
            $existing.Delete()
        } else {
            $dest = Join-Path $BackupDir ("claude-$Name." + (Get-Date -Format 'yyyyMMdd-HHmmss'))
            Write-Info "Backing up $target -> $dest"
            Move-Item -Path $target -Destination $dest -Force
        }
    }

    $isDir = (Get-Item $src).PSIsContainer
    try {
        New-Item -ItemType SymbolicLink -Path $target -Value $src -ErrorAction Stop | Out-Null
        Write-Ok "Symlinked $target -> $src"
    } catch {
        if ($isDir) {
            New-Item -ItemType Junction -Path $target -Value $src | Out-Null
            Write-Ok "Junctioned $target -> $src"
        } else {
            Write-Warn2 "Symlink failed (enable Developer Mode for symlinks). Copying instead."
            Copy-Item -Path $src -Destination $target -Force
            Write-Ok "Copied $src -> $target"
        }
    }
}

Write-Host "Setting up Claude Code environment..." -ForegroundColor Cyan

foreach ($name in @(
    'settings.json',
    'CLAUDE.md',
    'workflow-refs',
    'agents',
    'commands',
    'statusline.py',
    'cc-sessions.py'
)) {
    New-ClaudeLink -Name $name
}

# The status line runs `python3`; without /proc it needs psutil for CPU/RAM.
$py = Get-Command python3 -ErrorAction SilentlyContinue
if ($py) {
    & $py.Source -c 'import psutil' 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Installing psutil for the status line..."
        & $py.Source -m pip install --user --quiet psutil
        if ($LASTEXITCODE -eq 0) { Write-Ok "psutil installed." }
        else { Write-Warn2 "pip install psutil failed — status line will omit CPU/RAM." }
    } else {
        Write-Ok "psutil already installed."
    }
} else {
    Write-Warn2 "python3 not on PATH — the status line needs it."
}

Write-Host ""
Write-Host "Claude Code setup complete!" -ForegroundColor Green
Write-Host "  Settings:   ~\.claude\settings.json"
Write-Host "  CLAUDE.md:  ~\.claude\CLAUDE.md"
Write-Host "  Agents:     ~\.claude\agents\"
Write-Host "  Commands:   ~\.claude\commands\"
Write-Host "  Statusline: ~\.claude\statusline.py"
Write-Host "  Sessions:   ~\.claude\cc-sessions.py"
