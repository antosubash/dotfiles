#Requires -Version 5.1
<#
.SYNOPSIS
    Cross-platform dotfile installation for Windows.

.DESCRIPTION
    Windows analog of install.sh. Symlinks (or junctions/copies as a fallback)
    the relevant config files into their Windows-native locations:

      git/.gitconfig    -> $HOME/.gitconfig
      vim/.vimrc        -> $HOME/_vimrc       (Windows vim convention)
      tmux/.tmux.conf   -> $HOME/.tmux.conf   (useful from Git Bash / WSL)
      nvim/             -> $env:LOCALAPPDATA\nvim

    Symlinks need Developer Mode (or an elevated session). Directory targets
    fall back to a junction (no admin required); files fall back to a copy.

    Skipped on Windows: shell rc files (.zshrc / .bashrc / .profile) and
    .p10k.zsh — those belong inside WSL, where install.sh handles them.

    After linking, the script invokes setup-windows-terminal.ps1 to wire up
    the PowerShell profile, Windows Terminal, and Alacritty.

.PARAMETER SkipTerminal
    Skip running setup-windows-terminal.ps1.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\install.ps1
#>

[CmdletBinding()]
param(
    [switch]$SkipTerminal
)

$ErrorActionPreference = 'Stop'

$DotfilesDir = $PSScriptRoot
$BackupDir   = Join-Path $env:USERPROFILE '.dotfiles_backup'

function Write-Section { param([string]$T) Write-Host "`n=== $T ===" -ForegroundColor Cyan }
function Write-Info    { param([string]$M) Write-Host "  $M" -ForegroundColor Gray }
function Write-Ok      { param([string]$M) Write-Host "  $M" -ForegroundColor Green }
function Write-Warn2   { param([string]$M) Write-Host "  $M" -ForegroundColor Yellow }

if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

function Backup-Existing {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path $Path)) { return }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $name  = Split-Path -Leaf $Path
    $dest  = Join-Path $BackupDir "$name.$stamp"
    Write-Info "Backing up $Path -> $dest"
    Move-Item -Path $Path -Destination $dest -Force
}

function New-DotfileLink {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target
    )

    if (-not (Test-Path $Source)) {
        Write-Warn2 "Source not found: $Source — skipping."
        return
    }

    $targetDir = Split-Path -Parent $Target
    if ($targetDir -and -not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    # No-op if already pointing at the right source.
    if (Test-Path $Target) {
        $item = Get-Item $Target -Force
        if ($item.LinkType -in @('SymbolicLink','Junction') -and $item.Target -contains $Source) {
            Write-Ok "$Target already linked."
            return
        }
        Backup-Existing -Path $Target
    }

    $isDir = (Get-Item $Source).PSIsContainer
    try {
        New-Item -ItemType SymbolicLink -Path $Target -Value $Source -ErrorAction Stop | Out-Null
        Write-Ok "Symlinked $Target -> $Source"
    } catch {
        if ($isDir) {
            # Junctions work for directories without admin/Developer Mode.
            New-Item -ItemType Junction -Path $Target -Value $Source | Out-Null
            Write-Ok "Junctioned $Target -> $Source"
        } else {
            Write-Warn2 "Symlink failed (enable Developer Mode for symlinks). Copying instead."
            Copy-Item -Path $Source -Destination $Target -Force
            Write-Ok "Copied $Source -> $Target"
        }
    }
}

# ---------------------------------------------------------------------------
# Mappings
# ---------------------------------------------------------------------------

Write-Section "Dotfile links"

$mappings = @(
    @{ Src = 'git\.gitconfig'; Dest = (Join-Path $env:USERPROFILE '.gitconfig') }
    @{ Src = 'vim\.vimrc';     Dest = (Join-Path $env:USERPROFILE '_vimrc') }
    @{ Src = 'tmux\.tmux.conf';Dest = (Join-Path $env:USERPROFILE '.tmux.conf') }
    @{ Src = 'nvim';           Dest = (Join-Path $env:LOCALAPPDATA 'nvim') }
    @{ Src = '.claude\agents'; Dest = (Join-Path $env:USERPROFILE '.claude\agents') }
)

foreach ($m in $mappings) {
    $src = Join-Path $DotfilesDir $m.Src
    New-DotfileLink -Source $src -Target $m.Dest
}

# ---------------------------------------------------------------------------
# Terminal setup
# ---------------------------------------------------------------------------

if (-not $SkipTerminal) {
    Write-Section "Terminal setup"
    $terminalScript = Join-Path $DotfilesDir 'scripts\setup-windows-terminal.ps1'
    if (Test-Path $terminalScript) {
        & $terminalScript
    } else {
        Write-Warn2 "scripts\setup-windows-terminal.ps1 not found."
    }
} else {
    Write-Section "Terminal setup (skipped via -SkipTerminal)"
}

Write-Section "Done"
Write-Host "  Dotfiles installed. Open a new shell to pick up changes." -ForegroundColor Green
Write-Host "  Shell rc files (.zshrc/.bashrc/.profile) are configured inside WSL, not on host Windows." -ForegroundColor Yellow
