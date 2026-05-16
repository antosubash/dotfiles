#Requires -Version 5.1
<#
.SYNOPSIS
    Windows development environment setup.

.DESCRIPTION
    Installs development tools on Windows using winget for GUI apps and
    scoop for CLI dev tools. Optionally enables WSL2 + Ubuntu so
    setup-ubuntu.sh can run inside WSL.

    Idempotent: re-running skips anything already installed.

.PARAMETER SkipWSL
    Skip enabling/installing WSL2 + Ubuntu.

.PARAMETER SkipFonts
    Skip Nerd Font installation.

.PARAMETER SkipGUI
    Skip GUI app installation (browsers, IDEs, Docker Desktop, comms).

.PARAMETER SkipTerminal
    Skip the terminal configuration step (Windows Terminal scheme, oh-my-posh,
    PowerShell profile, Alacritty config).

.PARAMETER BootstrapWSL
    After Ubuntu is installed AND first-run user setup is complete, clone
    this dotfiles repo inside Ubuntu and run install.sh. Skipped automatically
    if the distro hasn't been initialized (still on the root prompt).

.PARAMETER WSLDotfilesRepo
    Git URL to clone inside WSL when -BootstrapWSL is set. Defaults to the
    upstream repo.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1

.NOTES
    Run from an elevated PowerShell session for WSL and some winget installs.
    Recommended shell: PowerShell 7+ (pwsh).
#>

[CmdletBinding()]
param(
    [switch]$SkipWSL,
    [switch]$SkipFonts,
    [switch]$SkipGUI,
    [switch]$SkipTerminal,
    [switch]$BootstrapWSL,
    [string]$WSLDotfilesRepo = 'https://github.com/antosubash/dotfiles'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Section { param([string]$Title) Write-Host "`n=== $Title ===" -ForegroundColor Cyan }
function Write-Info    { param([string]$Msg)   Write-Host "  $Msg" -ForegroundColor Gray }
function Write-Ok      { param([string]$Msg)   Write-Host "  $Msg" -ForegroundColor Green }
function Write-Warn2   { param([string]$Msg)   Write-Host "  $Msg" -ForegroundColor Yellow }

function Test-Command {
    param([Parameter(Mandatory)][string]$Name)
    [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Id,
        [string]$Name = $Id
    )
    # winget exits 0 when the package is installed, -1978335212 (NO_INSTALLED_PACKAGE_FOUND)
    # when it isn't. Relying on the exit code is more reliable than scraping output —
    # header rows can otherwise false-positive when the id appears in column labels.
    $null = winget list --id $Id -e --accept-source-agreements --disable-interactivity 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "$Name already installed (winget)."
        return
    }
    Write-Info "Installing $Name via winget..."
    winget install --id $Id -e --silent `
        --accept-source-agreements --accept-package-agreements | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "winget install $Name exited with code $LASTEXITCODE (may already be present)."
    } else {
        Write-Ok "$Name installed."
    }
}

function Install-ScoopPackage {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$Bucket
    )
    $installed = scoop list 2>$null | Where-Object { $_.Name -eq $Name }
    if ($installed) {
        Write-Ok "$Name already installed (scoop)."
        return
    }
    $target = if ($Bucket) { "$Bucket/$Name" } else { $Name }
    Write-Info "Installing $Name via scoop..."
    scoop install $target
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "scoop install $Name failed."
    } else {
        Write-Ok "$Name installed."
    }
}

function Add-ScoopBucket {
    param([Parameter(Mandatory)][string]$Bucket)
    $buckets = scoop bucket list 2>$null
    if ($buckets -and ($buckets | ForEach-Object { $_.Name }) -contains $Bucket) {
        Write-Ok "scoop bucket '$Bucket' already added."
        return
    }
    Write-Info "Adding scoop bucket '$Bucket'..."
    scoop bucket add $Bucket | Out-Null
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

Write-Section "Preflight"
Write-Info "PowerShell:   $($PSVersionTable.PSVersion)"
Write-Info "Working dir:  $(Get-Location)"
Write-Info "Admin:        $(Test-Admin)"

if (-not (Test-Command winget)) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
}

# ---------------------------------------------------------------------------
# Scoop
# ---------------------------------------------------------------------------

Write-Section "Scoop"
if (-not (Test-Command scoop)) {
    Write-Info "Installing scoop..."
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
    $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                [Environment]::GetEnvironmentVariable('Path','Machine')
} else {
    Write-Ok "scoop already installed. Updating..."
    scoop update | Out-Null
}

# git is required for `scoop bucket add` — install it first so bucket adds below
# don't fail on systems where scoop survived but git was removed.
if (-not (Test-Command git)) {
    Install-ScoopPackage -Name 'git'
    $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                [Environment]::GetEnvironmentVariable('Path','Machine')
} else {
    Write-Ok "git already installed."
}

Add-ScoopBucket -Bucket 'main'
Add-ScoopBucket -Bucket 'extras'
Add-ScoopBucket -Bucket 'nerd-fonts'

# ---------------------------------------------------------------------------
# Core CLI tools (scoop)
# ---------------------------------------------------------------------------

Write-Section "Core CLI tools"
$scoopCli = @(
    'curl', 'wget', 'fastfetch', 'vim', 'neovim',
    'fzf', 'ripgrep', 'fd', 'bat', 'eza',
    'zoxide', 'gsudo', 'delta',
    'jq', 'yq', 'httpie', 'curlie',
    'gh', 'lazygit', 'lazydocker',
    'openssh', 'gnupg',
    'kubectl', 'helm',
    'nmap',
    'ollama'
)
foreach ($pkg in $scoopCli) { Install-ScoopPackage -Name $pkg }

# ---------------------------------------------------------------------------
# Languages (winget for installers with PATH management)
# ---------------------------------------------------------------------------

Write-Section "Languages & runtimes"

Install-WingetPackage -Id 'Python.Python.3.12'              -Name 'Python 3.12'
Install-WingetPackage -Id 'OpenJS.NodeJS.LTS'               -Name 'Node.js LTS'
Install-WingetPackage -Id 'GoLang.Go'                       -Name 'Go'
Install-WingetPackage -Id 'Rustlang.Rustup'                 -Name 'Rustup'
Install-WingetPackage -Id 'EclipseAdoptium.Temurin.21.JDK'  -Name 'Temurin JDK 21'

# .NET SDKs — match setup-ubuntu.sh: 7, 8, 9, 10
foreach ($v in '7','8','9') {
    Install-WingetPackage -Id "Microsoft.DotNet.SDK.$v" -Name ".NET SDK $v"
}
try { Install-WingetPackage -Id 'Microsoft.DotNet.SDK.Preview' -Name '.NET SDK Preview (10)' }
catch { Write-Warn2 ".NET SDK 10 not yet available via winget." }

# uv (Python package manager)
if (-not (Test-Command uv)) {
    Write-Info "Installing uv..."
    Invoke-RestMethod -Uri https://astral.sh/uv/install.ps1 | Invoke-Expression
} else {
    Write-Ok "uv already installed."
}

# pnpm
if (-not (Test-Command pnpm)) {
    Write-Info "Installing pnpm..."
    Invoke-RestMethod -Uri https://get.pnpm.io/install.ps1 | Invoke-Expression
} else {
    Write-Ok "pnpm already installed."
}

# ---------------------------------------------------------------------------
# Database / geospatial
# ---------------------------------------------------------------------------

Write-Section "Database & geospatial"
Install-ScoopPackage -Name 'postgresql'
Install-ScoopPackage -Name 'gdal' -Bucket 'extras'

# ---------------------------------------------------------------------------
# GUI apps (winget)
# ---------------------------------------------------------------------------

if (-not $SkipGUI) {
    Write-Section "GUI apps — browsers"
    Install-WingetPackage -Id 'Google.Chrome'   -Name 'Google Chrome'
    Install-WingetPackage -Id 'Mozilla.Firefox' -Name 'Mozilla Firefox'
    Install-WingetPackage -Id 'Brave.Brave'     -Name 'Brave'

    Write-Section "GUI apps — editors & IDEs"
    Install-WingetPackage -Id 'Microsoft.VisualStudioCode' -Name 'VS Code'
    Install-WingetPackage -Id 'Anysphere.Cursor'           -Name 'Cursor'
    Install-WingetPackage -Id 'JetBrains.Toolbox'          -Name 'JetBrains Toolbox'

    Write-Section "GUI apps — containers"
    Install-WingetPackage -Id 'Docker.DockerDesktop' -Name 'Docker Desktop'

    Write-Section "GUI apps — communication"
    Install-WingetPackage -Id 'SlackTechnologies.Slack' -Name 'Slack'
    Install-WingetPackage -Id 'Discord.Discord'         -Name 'Discord'
    Install-WingetPackage -Id 'Zoom.Zoom'               -Name 'Zoom'
    Install-WingetPackage -Id 'Mozilla.Thunderbird'     -Name 'Thunderbird'

    Write-Section "GUI apps — terminal"
    Install-WingetPackage -Id 'Microsoft.WindowsTerminal' -Name 'Windows Terminal'
} else {
    Write-Section "GUI apps (skipped via -SkipGUI)"
}

# ---------------------------------------------------------------------------
# VPN / networking
# ---------------------------------------------------------------------------

Write-Section "VPN & networking"
Install-WingetPackage -Id 'tailscale.tailscale' -Name 'Tailscale'
Install-WingetPackage -Id 'WireGuard.WireGuard' -Name 'WireGuard'

# ---------------------------------------------------------------------------
# Nerd Fonts
# ---------------------------------------------------------------------------

if (-not $SkipFonts) {
    Write-Section "Nerd Fonts"
    if (Test-Admin) {
        Install-ScoopPackage -Name 'JetBrainsMono-NF' -Bucket 'nerd-fonts'
        Install-ScoopPackage -Name 'FiraCode-NF'      -Bucket 'nerd-fonts'
        Install-ScoopPackage -Name 'Meslo-NF'         -Bucket 'nerd-fonts'
    } else {
        Write-Warn2 "Skipping Nerd Font install — needs an elevated session."
        Write-Warn2 "From admin PowerShell: scoop install nerd-fonts/JetBrainsMono-NF FiraCode-NF Meslo-NF"
    }
} else {
    Write-Section "Nerd Fonts (skipped via -SkipFonts)"
}

# ---------------------------------------------------------------------------
# WSL2 + Ubuntu
# ---------------------------------------------------------------------------

if (-not $SkipWSL) {
    Write-Section "WSL2 + Ubuntu"
    if (-not (Test-Admin)) {
        Write-Warn2 "WSL install requires an elevated session. Skipping."
        Write-Warn2 "Re-run from admin PowerShell, or run: wsl --install -d Ubuntu"
    } else {
        $wslList = & wsl.exe --list --quiet 2>$null
        $ubuntuPresent = ($LASTEXITCODE -eq 0 -and $wslList -match 'Ubuntu')

        if ($ubuntuPresent) {
            Write-Ok "WSL Ubuntu distro already present."
        } else {
            Write-Info "Installing WSL2 + Ubuntu (a reboot may be required)..."
            wsl --install -d Ubuntu
            Write-Warn2 "If this is the first WSL install, reboot and launch Ubuntu to finish first-run setup."
        }

        if ($BootstrapWSL) {
            # Bootstrapping only works once the distro has a real (non-root) user
            # account; on a fresh `wsl --install`, the user must launch Ubuntu
            # once to create one.
            $defaultUser = & wsl.exe -d Ubuntu --exec whoami 2>$null
            $userReady   = ($LASTEXITCODE -eq 0 -and $defaultUser -and $defaultUser.Trim() -ne 'root')

            if (-not $userReady) {
                Write-Warn2 "Ubuntu distro is not yet initialized with a user account."
                Write-Warn2 "Launch Ubuntu from the Start menu, create your user, then re-run with -BootstrapWSL."
            } else {
                Write-Info "Bootstrapping dotfiles inside Ubuntu (user: $($defaultUser.Trim()))..."
                $repo = $WSLDotfilesRepo
                $bootstrap = @"
set -e
if [ ! -d ~/dotfiles ]; then
    git clone $repo ~/dotfiles
else
    git -C ~/dotfiles pull --ff-only || true
fi
cd ~/dotfiles
chmod +x install.sh scripts/*.sh
./install.sh
"@
                wsl.exe -d Ubuntu -- bash -c $bootstrap
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "Dotfiles bootstrapped inside Ubuntu."
                    Write-Warn2 "Optional: inside Ubuntu, run ./scripts/setup-ubuntu.sh for the full dev toolchain."
                } else {
                    Write-Warn2 "WSL bootstrap exited with code $LASTEXITCODE."
                }
            }
        } else {
            Write-Info "Skip dotfiles bootstrap inside WSL. Pass -BootstrapWSL to enable."
        }
    }
} else {
    Write-Section "WSL2 (skipped via -SkipWSL)"
}

# ---------------------------------------------------------------------------
# Terminal setup
# ---------------------------------------------------------------------------

if (-not $SkipTerminal) {
    $terminalScript = Join-Path $PSScriptRoot 'setup-windows-terminal.ps1'
    if (Test-Path $terminalScript) {
        & $terminalScript
    } else {
        Write-Section "Terminal setup"
        Write-Warn2 "setup-windows-terminal.ps1 not found alongside this script."
    }
} else {
    Write-Section "Terminal setup (skipped via -SkipTerminal)"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Section "Versions"
$checks = @(
    @{ Name = 'git';     Cmd = { git --version } },
    @{ Name = 'gh';      Cmd = { gh --version | Select-Object -First 1 } },
    @{ Name = 'python';  Cmd = { python --version } },
    @{ Name = 'node';    Cmd = { node --version } },
    @{ Name = 'npm';     Cmd = { npm --version } },
    @{ Name = 'pnpm';    Cmd = { pnpm --version } },
    @{ Name = 'go';      Cmd = { go version } },
    @{ Name = 'rustc';   Cmd = { rustc --version } },
    @{ Name = 'java';    Cmd = { java -version 2>&1 | Select-Object -First 1 } },
    @{ Name = 'dotnet';  Cmd = { dotnet --list-sdks } },
    @{ Name = 'uv';      Cmd = { uv --version } },
    @{ Name = 'jq';      Cmd = { jq --version } },
    @{ Name = 'yq';      Cmd = { yq --version } },
    @{ Name = 'rg';      Cmd = { rg --version | Select-Object -First 1 } },
    @{ Name = 'fd';      Cmd = { fd --version } },
    @{ Name = 'fzf';     Cmd = { fzf --version } },
    @{ Name = 'nvim';    Cmd = { nvim --version | Select-Object -First 1 } },
    @{ Name = 'lazygit'; Cmd = { lazygit --version } },
    @{ Name = 'docker';  Cmd = { docker --version } },
    @{ Name = 'kubectl'; Cmd = { kubectl version --client 2>$null | Select-Object -First 1 } },
    @{ Name = 'helm';    Cmd = { helm version --short } },
    @{ Name = 'ollama';  Cmd = { ollama --version } }
)
foreach ($c in $checks) {
    if (Test-Command $c.Name) {
        try { Write-Host ("  {0,-10} {1}" -f $c.Name, ((& $c.Cmd) -join ' ')) }
        catch { Write-Host ("  {0,-10} (installed; version check failed)" -f $c.Name) }
    } else {
        Write-Host ("  {0,-10} not found in PATH" -f $c.Name) -ForegroundColor DarkGray
    }
}

Write-Host "`nDone. Open a new shell so PATH updates take effect." -ForegroundColor Green
Write-Host "If WSL was just installed, reboot and launch Ubuntu once to finish first-time setup." -ForegroundColor Yellow
