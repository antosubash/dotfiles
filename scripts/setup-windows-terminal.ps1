#Requires -Version 5.1
<#
.SYNOPSIS
    Configure the Windows terminal experience: Windows Terminal + oh-my-posh
    + PSReadLine + Alacritty.

.DESCRIPTION
    The Windows analog of scripts/setup-terminal.sh. Installs and configures:
      - MesloLGS Nerd Font (required by oh-my-posh/Powerlevel10k-style themes)
      - Windows Terminal: Catppuccin Mocha scheme + Meslo font defaults
      - oh-my-posh + posh-git + Terminal-Icons + PSReadLine
      - PowerShell $PROFILE with predictions, history search, prompt theme
      - Alacritty, linked to dotfiles/config/alacritty.toml

    Idempotent: re-runs skip what's already in place.

.PARAMETER SkipAlacritty
    Skip Alacritty install + config.

.PARAMETER SkipWindowsTerminal
    Skip Windows Terminal settings.json customization.

.PARAMETER SkipProfile
    Skip writing the PowerShell profile.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\scripts\setup-windows-terminal.ps1
#>

[CmdletBinding()]
param(
    [switch]$SkipAlacritty,
    [switch]$SkipWindowsTerminal,
    [switch]$SkipProfile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$DotfilesDir = Split-Path -Parent $PSScriptRoot

function Write-Section { param([string]$T) Write-Host "`n=== $T ===" -ForegroundColor Cyan }
function Write-Info    { param([string]$M) Write-Host "  $M" -ForegroundColor Gray }
function Write-Ok      { param([string]$M) Write-Host "  $M" -ForegroundColor Green }
function Write-Warn2   { param([string]$M) Write-Host "  $M" -ForegroundColor Yellow }

function Test-Command  { param([string]$N) [bool](Get-Command $N -ErrorAction SilentlyContinue) }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Backup-File {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path $Path) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$Path.bak-$stamp"
        Copy-Item -Path $Path -Destination $backup -Force
        Write-Info "Backed up $Path -> $backup"
    }
}

# ---------------------------------------------------------------------------
# Font
# ---------------------------------------------------------------------------

Write-Section "Meslo Nerd Font"
if (-not (Test-Command scoop)) {
    Write-Warn2 "scoop not found — run setup-windows.ps1 first, or install scoop manually."
} else {
    $buckets = scoop bucket list 2>$null
    $hasNerd = $buckets -and (($buckets | ForEach-Object { $_.Name }) -contains 'nerd-fonts')
    if (-not $hasNerd) {
        Write-Info "Adding scoop nerd-fonts bucket..."
        scoop bucket add nerd-fonts | Out-Null
    }
    $installed = scoop list 2>$null | Where-Object { $_.Name -eq 'Meslo-NF' }
    if ($installed) {
        Write-Ok "Meslo-NF already installed."
    } elseif (Test-Admin) {
        Write-Info "Installing Meslo-NF (system-wide; requires admin)..."
        scoop install nerd-fonts/Meslo-NF
    } else {
        Write-Warn2 "Skipping font install — needs an elevated session."
        Write-Warn2 "Run from admin PowerShell: scoop install nerd-fonts/Meslo-NF"
    }
}

# ---------------------------------------------------------------------------
# oh-my-posh + PowerShell modules
# ---------------------------------------------------------------------------

Write-Section "oh-my-posh + PowerShell modules"

if (-not (Test-Command oh-my-posh)) {
    Write-Info "Installing oh-my-posh via winget..."
    winget install --id JanDeDobbeleer.OhMyPosh -e --silent `
        --accept-source-agreements --accept-package-agreements | Out-Null
    # Refresh PATH so oh-my-posh is callable in this session.
    $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                [Environment]::GetEnvironmentVariable('Path','Machine')
} else {
    Write-Ok "oh-my-posh already installed."
}

# Trust PSGallery so module installs don't prompt.
if ((Get-PSRepository -Name PSGallery).InstallationPolicy -ne 'Trusted') {
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
}

$modules = @('PSReadLine', 'posh-git', 'Terminal-Icons', 'ZLocation', 'PSFzf')
foreach ($m in $modules) {
    if (Get-Module -ListAvailable -Name $m) {
        Write-Ok "$m already installed. Updating..."
        try { Update-Module -Name $m -ErrorAction Stop } catch { Write-Warn2 "Update of $m failed: $_" }
    } else {
        Write-Info "Installing module $m..."
        Install-Module -Name $m -Scope CurrentUser -Force -AllowClobber -AcceptLicense
    }
}

# ---------------------------------------------------------------------------
# PowerShell $PROFILE
# ---------------------------------------------------------------------------

if (-not $SkipProfile) {
    Write-Section "PowerShell profile"

    # Strategy: keep the real profile OUTSIDE OneDrive at
    # $env:USERPROFILE\.config\powershell\profile.ps1, and drop one-line stubs
    # at $PROFILE so the engine still finds it. Reasons:
    #   * OneDrive doesn't churn-sync this file on every edit.
    #   * pwsh and Windows PowerShell share the same profile content.
    #   * Profile has an idempotency guard so the AllHosts + CurrentHost case
    #     can't double-execute.
    $profileSrc   = Join-Path $DotfilesDir 'shell\windows-profile.ps1'
    if (-not (Test-Path $profileSrc)) {
        Write-Warn2 "shell\windows-profile.ps1 not found in dotfiles — skipping profile setup."
    } else {
        $localDir  = Join-Path $env:USERPROFILE '.config\powershell'
        $localPath = Join-Path $localDir 'profile.ps1'
        if (-not (Test-Path $localDir)) {
            New-Item -ItemType Directory -Path $localDir -Force | Out-Null
        }

        # Symlink the local profile to the dotfiles source (so future edits in
        # the repo show up immediately). Fall back to a copy if symlinking is
        # not permitted (no Developer Mode, no admin).
        $needWrite = $true
        if (Test-Path $localPath) {
            $item = Get-Item $localPath -Force
            if ($item.LinkType -eq 'SymbolicLink' -and $item.Target -eq $profileSrc) {
                Write-Ok "Local profile already linked: $localPath"
                $needWrite = $false
            } else {
                Backup-File -Path $localPath
                Remove-Item $localPath -Force
            }
        }
        if ($needWrite) {
            try {
                New-Item -ItemType SymbolicLink -Path $localPath -Target $profileSrc | Out-Null
                Write-Ok "Symlinked $localPath -> $profileSrc"
            } catch {
                Write-Warn2 "Symlink failed ($($_.Exception.Message)). Copying instead."
                Copy-Item -Path $profileSrc -Destination $localPath -Force
                Write-Ok "Copied profile to $localPath"
            }
        }

        # Place the stub at $PROFILE for BOTH editions. Use ONLY the
        # CurrentUserCurrentHost path; the AllHosts path would also fire,
        # causing the profile to load twice in pwsh (the guard catches it,
        # but it's still a wasted file-system roundtrip).
        $myDocs = [Environment]::GetFolderPath('MyDocuments')
        $stubPaths = @(
            (Join-Path $myDocs 'PowerShell\Microsoft.PowerShell_profile.ps1'),       # pwsh
            (Join-Path $myDocs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1') # Windows PowerShell 5.1
        )
        $stub = @'
# Stub profile — real profile lives outside OneDrive at:
#   $env:USERPROFILE\.config\powershell\profile.ps1
# Edit it there; this file is intentionally tiny so OneDrive sync stays quiet.
$__local = Join-Path $env:USERPROFILE '.config\powershell\profile.ps1'
if (Test-Path $__local) { . $__local }
'@
        foreach ($stubPath in $stubPaths) {
            $stubDir = Split-Path -Parent $stubPath
            if (-not (Test-Path $stubDir)) { New-Item -ItemType Directory -Path $stubDir -Force | Out-Null }
            $existing = if (Test-Path $stubPath) { Get-Content -Raw $stubPath } else { '' }
            if ($existing.Trim() -eq $stub.Trim()) {
                Write-Ok "Stub already in place: $stubPath"
            } else {
                if (Test-Path $stubPath) { Backup-File -Path $stubPath }
                Set-Content -Path $stubPath -Value $stub -Encoding UTF8
                Write-Ok "Wrote stub: $stubPath"
            }
        }

        # Remove the redundant AllHosts profile if it exists — it would cause
        # the profile to be sourced twice.
        $orphans = @(
            (Join-Path $myDocs 'PowerShell\profile.ps1'),
            (Join-Path $myDocs 'WindowsPowerShell\profile.ps1')
        )
        foreach ($o in $orphans) {
            if (Test-Path $o) {
                $content = Get-Content -Raw $o
                # Only remove if it looks like our stub or a prior dotfiles managed block;
                # leave hand-written AllHosts profiles alone.
                if ($content -match 'dotfiles\\powershell\\profile\.ps1' -or $content -match 'dotfiles managed block') {
                    Backup-File -Path $o
                    Remove-Item $o -Force
                    Write-Ok "Removed redundant AllHosts profile: $o"
                } else {
                    Write-Warn2 "Leaving hand-written AllHosts profile: $o"
                    Write-Warn2 "  (delete it manually to avoid double-loading the dotfiles profile)"
                }
            }
        }
    }
} else {
    Write-Section "PowerShell profile (skipped via -SkipProfile)"
}

# ---------------------------------------------------------------------------
# Windows Terminal
# ---------------------------------------------------------------------------

if (-not $SkipWindowsTerminal) {
    Write-Section "Windows Terminal"

    $wtCandidates = @(
        "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json",
        "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json",
        "$env:LOCALAPPDATA\Microsoft\Windows Terminal\settings.json"
    )
    $wtPath = $wtCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $wtPath) {
        Write-Warn2 "Windows Terminal settings.json not found."
        Write-Warn2 "Launch Windows Terminal at least once, then re-run this script."
    } else {
        Write-Info "Found settings.json: $wtPath"
        Backup-File -Path $wtPath

        $json = Get-Content -Raw $wtPath | ConvertFrom-Json

        $catppuccinScheme = @{
            name                = 'Catppuccin Mocha'
            cursorColor         = '#F5E0DC'
            selectionBackground = '#585B70'
            background          = '#1E1E2E'
            foreground          = '#CDD6F4'
            black               = '#45475A'
            blue                = '#89B4FA'
            cyan                = '#94E2D5'
            green               = '#A6E3A1'
            purple              = '#F5C2E7'
            red                 = '#F38BA8'
            white               = '#BAC2DE'
            yellow              = '#F9E2AF'
            brightBlack         = '#585B70'
            brightBlue          = '#89B4FA'
            brightCyan          = '#94E2D5'
            brightGreen         = '#A6E3A1'
            brightPurple        = '#F5C2E7'
            brightRed           = '#F38BA8'
            brightWhite         = '#A6ADC8'
            brightYellow        = '#F9E2AF'
        }

        # Ensure schemes array contains Catppuccin Mocha (replace if present).
        if (-not $json.schemes) {
            $json | Add-Member -NotePropertyName schemes -NotePropertyValue @() -Force
        }
        $json.schemes = @(
            ($json.schemes | Where-Object { $_.name -ne 'Catppuccin Mocha' })
            [PSCustomObject]$catppuccinScheme
        ) | Where-Object { $_ }

        # Ensure profiles.defaults exists with our preferred settings.
        if (-not $json.profiles)            { $json | Add-Member -NotePropertyName profiles -NotePropertyValue ([PSCustomObject]@{}) -Force }
        if (-not $json.profiles.defaults)   { $json.profiles | Add-Member -NotePropertyName defaults -NotePropertyValue ([PSCustomObject]@{}) -Force }

        $defaults = $json.profiles.defaults
        $set = {
            param($obj, $name, $value)
            if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
            else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force }
        }
        & $set $defaults 'colorScheme' 'Catppuccin Mocha'

        $fontObj = [PSCustomObject]@{ face = 'MesloLGS NF'; size = 12 }
        & $set $defaults 'font' $fontObj

        & $set $defaults 'padding' '10'
        & $set $defaults 'useAcrylic' $false
        & $set $defaults 'cursorShape' 'bar'

        # Prefer PowerShell 7 (pwsh) as the default if installed.
        if (Test-Command pwsh) {
            $pwshProfile = $json.profiles.list | Where-Object { $_.commandline -match 'pwsh' -or $_.name -match 'PowerShell$' } | Select-Object -First 1
            if ($pwshProfile -and $pwshProfile.guid) {
                & $set $json 'defaultProfile' $pwshProfile.guid
            }
        }

        $json | ConvertTo-Json -Depth 32 | Set-Content -Path $wtPath -Encoding UTF8
        Write-Ok "Windows Terminal configured (Catppuccin Mocha + MesloLGS NF)."
    }
} else {
    Write-Section "Windows Terminal (skipped via -SkipWindowsTerminal)"
}

# ---------------------------------------------------------------------------
# Alacritty
# ---------------------------------------------------------------------------

if (-not $SkipAlacritty) {
    Write-Section "Alacritty"

    if (-not (Test-Command alacritty)) {
        Write-Info "Installing Alacritty via winget..."
        winget install --id Alacritty.Alacritty -e --silent `
            --accept-source-agreements --accept-package-agreements | Out-Null
    } else {
        Write-Ok "Alacritty already installed."
    }

    $alacrittySrc = Join-Path $DotfilesDir 'config\alacritty.toml'
    if (-not (Test-Path $alacrittySrc)) {
        Write-Warn2 "config/alacritty.toml not found in dotfiles — skipping config."
    } else {
        $alacrittyDir  = Join-Path $env:APPDATA 'alacritty'
        $alacrittyDest = Join-Path $alacrittyDir 'alacritty.toml'
        if (-not (Test-Path $alacrittyDir)) { New-Item -ItemType Directory -Path $alacrittyDir -Force | Out-Null }

        $needWrite = $true
        if (Test-Path $alacrittyDest) {
            $item = Get-Item $alacrittyDest -Force
            if ($item.LinkType -eq 'SymbolicLink' -and $item.Target -eq $alacrittySrc) {
                Write-Ok "Alacritty config already symlinked."
                $needWrite = $false
            } else {
                Backup-File -Path $alacrittyDest
                Remove-Item $alacrittyDest -Force
            }
        }
        if ($needWrite) {
            try {
                New-Item -ItemType SymbolicLink -Path $alacrittyDest -Target $alacrittySrc | Out-Null
                Write-Ok "Symlinked $alacrittyDest -> $alacrittySrc"
            } catch {
                # Symlink creation can require Developer Mode or admin on Windows.
                Write-Warn2 "Symlink failed ($($_.Exception.Message)). Falling back to copy."
                Copy-Item -Path $alacrittySrc -Destination $alacrittyDest -Force
                Write-Ok "Copied alacritty.toml to $alacrittyDest"
            }
        }
    }
} else {
    Write-Section "Alacritty (skipped via -SkipAlacritty)"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Section "Done"
Write-Host "  Open a new PowerShell session to pick up profile + prompt." -ForegroundColor Green
Write-Host "  Set your terminal font to 'MesloLGS NF' if not already." -ForegroundColor Yellow
Write-Host "  Tweak the oh-my-posh theme by editing the dotfiles managed block in your `$PROFILE." -ForegroundColor Yellow
