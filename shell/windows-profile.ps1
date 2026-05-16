# =========================================================================
#  PowerShell profile  (works in pwsh 7+ and Windows PowerShell 5.1)
#  Location: $env:USERPROFILE\.config\powershell\profile.ps1
#  Loaded via stubs at $PROFILE so OneDrive doesn't churn this file.
#
#  Optimization principles applied here:
#   * NEVER `Get-Command X -EA Ignore` at load time — each call walks PATH.
#     Define wrappers unconditionally; let them error if tool isn't there.
#   * NEVER `Get-Module -ListAvailable` — it walks every PSModulePath dir.
#     Use lazy try/catch on Import-Module instead.
#   * Cache anything that spawns an .exe to compute init text.
#   * Defer everything that isn't needed at first prompt.
# =========================================================================

# Idempotency guard — pwsh loads CurrentUserAllHosts AND CurrentUserCurrentHost
# and if both stubs source this file we'd double-execute. Cheap early-out.
if ($global:__DotfilesProfileLoaded) { return }
$global:__DotfilesProfileLoaded = $true

$script:ProfileRoot = Split-Path -Parent $PSCommandPath
$script:CacheDir    = Join-Path $script:ProfileRoot 'cache'
if (-not (Test-Path $script:CacheDir)) {
    New-Item -ItemType Directory -Path $script:CacheDir -Force | Out-Null
}

# -------------------------------------------------------------------------
# oh-my-posh  (cached with --print so we don't re-spawn omp on every shell)
# -------------------------------------------------------------------------
$script:PoshConfig = "$env:USERPROFILE\antosubash.omp.json"
$script:PoshUrl    = 'https://raw.githubusercontent.com/antosubash/terminal/main/antosubash.omp.json'
$script:PoshCache  = Join-Path $script:CacheDir 'omp-init.ps1'

if (-not (Test-Path $script:PoshConfig)) {
    try { Invoke-WebRequest -Uri $script:PoshUrl -OutFile $script:PoshConfig -UseBasicParsing } catch {}
}
if ((-not (Test-Path $script:PoshCache)) -or
    ((Get-Item $script:PoshCache).LastWriteTime -lt (Get-Date).AddDays(-7))) {
    try {
        # --print emits the full init script; without it, the cache is just a
        # one-line stub that re-spawns oh-my-posh.exe on every shell load.
        oh-my-posh init pwsh --config $script:PoshConfig --print 2>$null |
            Set-Content -LiteralPath $script:PoshCache -Encoding UTF8
    } catch {}
}
if (Test-Path $script:PoshCache) { . $script:PoshCache }

function Update-PoshInit {
    oh-my-posh init pwsh --config $script:PoshConfig --print |
        Set-Content -LiteralPath $script:PoshCache -Encoding UTF8
    . $script:PoshCache
    Write-Host "oh-my-posh init cache refreshed." -ForegroundColor Green
}

# -------------------------------------------------------------------------
# fnm  (cached env init)
# -------------------------------------------------------------------------
$script:FnmCache = Join-Path $script:CacheDir 'fnm-env.ps1'
if ((-not (Test-Path $script:FnmCache)) -or
    ((Get-Item $script:FnmCache).LastWriteTime -lt (Get-Date).AddDays(-7))) {
    try { fnm env --use-on-cd 2>$null | Set-Content -LiteralPath $script:FnmCache -Encoding UTF8 } catch {}
}
if (Test-Path $script:FnmCache) { . $script:FnmCache }

function Update-FnmEnv {
    fnm env --use-on-cd | Set-Content -LiteralPath $script:FnmCache -Encoding UTF8
    . $script:FnmCache
    Write-Host "fnm env cache refreshed." -ForegroundColor Green
}

# -------------------------------------------------------------------------
# PSReadLine  (auto-loaded by pwsh; no explicit Import-Module needed)
# -------------------------------------------------------------------------
Set-PSReadLineOption -EditMode Windows
Set-PSReadLineOption -PredictionSource History
Set-PSReadLineOption -PredictionViewStyle InlineView
Set-PSReadLineOption -HistorySearchCursorMovesToEnd
Set-PSReadLineOption -HistoryNoDuplicates
Set-PSReadLineOption -MaximumHistoryCount 8192
Set-PSReadLineKeyHandler -Key Tab       -Function MenuComplete
Set-PSReadLineKeyHandler -Key UpArrow   -Function HistorySearchBackward
Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward
Set-PSReadLineKeyHandler -Key Ctrl+r    -Function ReverseSearchHistory

# Don't save anything that looks like a secret to history.
Set-PSReadLineOption -AddToHistoryHandler {
    param([string]$line)
    if ($line -match '(?i)\b(password|secret|token|api[_-]?key|bearer)\b') {
        return [Microsoft.PowerShell.PSConsoleReadLine+AddToHistoryOption]::MemoryOnly
    }
    return [Microsoft.PowerShell.PSConsoleReadLine+AddToHistoryOption]::MemoryAndFile
}

# -------------------------------------------------------------------------
# Lazy: ZLocation / z  (first call imports the module)
# -------------------------------------------------------------------------
function z {
    Remove-Item Function:\z
    Import-Module ZLocation -ErrorAction SilentlyContinue
    z @args
}

# -------------------------------------------------------------------------
# Lazy: WinGet CommandNotFound  (imported the first time a cmd isn't found)
# Skips ~226ms upfront cost in every shell that never triggers it.
# -------------------------------------------------------------------------
$ExecutionContext.InvokeCommand.CommandNotFoundAction = {
    param($cmdName, $cmdLookup)
    $ExecutionContext.InvokeCommand.CommandNotFoundAction = $null  # one-shot
    try {
        Import-Module -Name Microsoft.WinGet.CommandNotFound -ErrorAction Stop
        $handler = $ExecutionContext.InvokeCommand.CommandNotFoundAction
        if ($handler) { & $handler $cmdName $cmdLookup }
    } catch {}
}

# -------------------------------------------------------------------------
# Lazy: PSFzf  (first Ctrl+T / Alt+C imports the module + wires real handlers)
# -------------------------------------------------------------------------
$script:LoadPsFzf = {
    Set-PSReadLineKeyHandler -Key Ctrl+t -Function SelfInsert  # detach lazy stub
    Set-PSReadLineKeyHandler -Key Alt+c  -Function SelfInsert
    try {
        Import-Module PSFzf -ErrorAction Stop
        Set-PsFzfOption -PSReadlineChordProvider 'Ctrl+t' `
                        -PSReadlineChordReverseHistory 'Ctrl+r' `
                        -PSReadlineChordSetLocation 'Alt+c'
    } catch {}
}
Set-PSReadLineKeyHandler -Key Ctrl+t -ScriptBlock { & $script:LoadPsFzf }
Set-PSReadLineKeyHandler -Key Alt+c  -ScriptBlock { & $script:LoadPsFzf }

# -------------------------------------------------------------------------
# Environment
# -------------------------------------------------------------------------
$env:UV_LINK_MODE = 'copy'

# -------------------------------------------------------------------------
# Aliases & wrappers
# Defined unconditionally — call-time will error if the underlying tool is
# missing. This avoids one PATH walk per Get-Command at profile load (~100ms each).
# -------------------------------------------------------------------------
function pnpx  { pnpm exec @args }
function ll    { eza -lh --git --icons @args }
function la    { eza -lha --git --icons @args }
function lt    { eza --tree --git-ignore --icons @args }
function bcat  { bat --paging=never @args }   # call it `bcat` to avoid clobbering Get-Content alias
Set-Alias -Name g -Value git -Option AllScope -Force

# -------------------------------------------------------------------------
# Navigation
# -------------------------------------------------------------------------
function ..      { Set-Location .. }
function ....    { Set-Location ../.. }
function ......  { Set-Location ../../.. }
function home    { Set-Location $HOME }
function repos   { Set-Location "D:\" }
function ssh_home   { Set-Location "$HOME\.ssh" }
function ssh_config { code "$HOME\.ssh\config" }
function profile { code $script:ProfileRoot }
function which { param($name) (Get-Command $name -ErrorAction SilentlyContinue).Source }
function mkcd  { param($p) New-Item -ItemType Directory -Path $p -Force | Out-Null; Set-Location $p }

# -------------------------------------------------------------------------
# Docker shortcuts
# -------------------------------------------------------------------------
function dps    { docker ps @args }
function dcu    { docker-compose up @args }
function dcd    { docker-compose down @args }
function dcb    { docker-compose build @args }
function dex    { docker exec -it $args[0] bash }
function dprune {
    docker container prune -f
    docker image prune -f
    docker volume prune -f
}
function dsd { docker stack deploy -c $args[0] $args[1] }
function dsr { docker stack rm $args[0] }
function dsl { docker service logs $args[0] }
function dss { docker stack services $args[0] }

# -------------------------------------------------------------------------
# Git shortcuts
# -------------------------------------------------------------------------
function gb       { git checkout -b $args }
function gbt      { param([string]$taskid) git checkout -b "task/$taskid" }
function gs       { git checkout $args; git pull }
function gmaster  { gs 'master' }
function gmain    { gs 'main' }
function gdev     { gs 'develop' }
function grb      { git fetch; git rebase origin/$args }
function gco      { git add .; git commit -m $args }
function gpu      { git pull }
function goops    { git add .; git commit --amend --no-edit }
function gfp      { git push --force-with-lease }
function gr       { git reset --hard; git clean -f -d }
function gcb      { git checkout $(git rev-parse --abbrev-ref HEAD) }
function gpl      { git pull origin $(git rev-parse --abbrev-ref HEAD) }
function gph      { git push origin $(git rev-parse --abbrev-ref HEAD) }
function gd       { git diff @args }
function gst      { git status @args }
function gl       { git log --oneline --graph --decorate @args }
function gsync {
    $branch = git rev-parse --abbrev-ref HEAD
    git checkout main
    git pull
    git checkout $branch
    git rebase main
}

# Conventional commit helpers (one shared implementation, eight wrappers)
function script:Conventional-Commit {
    param([string]$Type, [string[]]$Args)
    $msg = if ($Args.Count -ge 2) { "$Type($($Args[0])): $($Args[1])" } else { "${Type}: $($Args[0])" }
    gco $msg
}
function gfeat     { script:Conventional-Commit feat     $args }
function gfix      { script:Conventional-Commit fix      $args }
function gtest     { script:Conventional-Commit test     $args }
function gdocs     { script:Conventional-Commit docs     $args }
function gstyle    { script:Conventional-Commit style    $args }
function grefactor { script:Conventional-Commit refactor $args }
function gperf     { script:Conventional-Commit perf     $args }
function gchore    { script:Conventional-Commit chore    $args }

# -------------------------------------------------------------------------
# GitHub (web)
# -------------------------------------------------------------------------
function script:Get-RepoUrl {
    $remote = git config --get remote.origin.url 2>$null
    if ($remote -match 'github\.com[:/]([^/]+)/([^/]+?)(\.git)?$') {
        return @{ Owner = $matches[1]; Repo = $matches[2] }
    }
    return $null
}
function ghb   { $r = script:Get-RepoUrl; if ($r) { Start-Process "https://github.com/$($r.Owner)/$($r.Repo)" } }
function ghpr  { $r = script:Get-RepoUrl; if ($r) { Start-Process "https://github.com/$($r.Owner)/$($r.Repo)/pulls" } }
function ghnpr {
    $r = script:Get-RepoUrl
    if ($r) {
        $branch = git rev-parse --abbrev-ref HEAD
        Start-Process "https://github.com/$($r.Owner)/$($r.Repo)/compare/$branch`?expand=1"
    }
}
function ghi  { $r = script:Get-RepoUrl; if ($r) { Start-Process "https://github.com/$($r.Owner)/$($r.Repo)/issues" } }
function ghni { $r = script:Get-RepoUrl; if ($r) { Start-Process "https://github.com/$($r.Owner)/$($r.Repo)/issues/new" } }
function gha  { $r = script:Get-RepoUrl; if ($r) { Start-Process "https://github.com/$($r.Owner)/$($r.Repo)/actions" } }
function ghc  { param([string]$repo)
    if ($repo -match '^([^/]+)/([^/]+)$') { git clone "https://github.com/$($matches[1])/$($matches[2]).git" }
}
function ghf {
    $r = script:Get-RepoUrl
    if ($r) {
        $branch = git rev-parse --abbrev-ref HEAD
        $rel = git ls-files --full-name (Get-Location)
        Start-Process "https://github.com/$($r.Owner)/$($r.Repo)/blob/$branch/$rel"
    }
}

# -------------------------------------------------------------------------
# gh CLI shortcuts
# -------------------------------------------------------------------------
function ghpl { gh pr list @args }
function ghnp { gh pr create --web }
function ghpv { param([string]$n) gh pr view $n --web }
function ghpc { param([string]$n) gh pr checkout $n }
function ghpm { param([string]$n) gh pr merge $n }
function ghil { gh issue list @args }
function ghin { gh issue create --web }
function ghiv { param([string]$n) gh issue view $n --web }
function ghic { param([string]$n) gh issue close $n }
function ghir { param([string]$n) gh issue reopen $n }
function ghrl { gh repo list @args }
function ghrc { param([string]$repo) gh repo clone $repo }
function ghrn { gh repo create --public --source=. }
function ghrf { gh repo fork --remote }
function ghgl { gh gist list @args }
function ghgc { param([string]$file) gh gist create $file }
function ghgv { param([string]$id) gh gist view $id --web }
function ghal { gh run list @args }
function ghav { param([string]$id) gh run view $id }
function ghaw { param([string]$id) gh run watch $id }

# -------------------------------------------------------------------------
# VS Code
# -------------------------------------------------------------------------
function c  { code . @args }
function cr { code -r . @args }

# -------------------------------------------------------------------------
# Project helpers
# -------------------------------------------------------------------------
function restore {
    if (Test-Path "*.sln")           { dotnet restore }
    elseif (Test-Path "*.csproj")    { dotnet restore }
    elseif (Test-Path "package.json"){ pnpm i }
    else { Write-Warning "No recognized project files found (*.sln, *.csproj, package.json)" }
}

# -------------------------------------------------------------------------
# PSReadLine macros — Ctrl+Shift+{B,T,S}
# -------------------------------------------------------------------------
Set-PSReadLineKeyHandler -Key Ctrl+Shift+b `
    -BriefDescription BuildCurrentDirectory -LongDescription "Build the current directory" `
    -ScriptBlock {
        [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
        $command = if (Test-Path ".\package.json") {
            $pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json
            if ($pkg.scripts.build) { "pnpm run build" } else { Write-Warning "No build script"; return }
        } elseif (Test-Path "*.sln" -or (Test-Path "*.csproj")) { "dotnet build" }
        else { Write-Warning "No recognized build files"; return }
        [Microsoft.PowerShell.PSConsoleReadLine]::Insert($command)
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }

Set-PSReadLineKeyHandler -Key Ctrl+Shift+t `
    -BriefDescription TestCurrentDirectory -LongDescription "Run tests in current directory" `
    -ScriptBlock {
        [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
        $command = if (Test-Path ".\package.json") {
            $pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json
            if ($pkg.scripts.test) { "pnpm test" } else { Write-Warning "No test script"; return }
        } elseif (Test-Path "*.sln" -or (Test-Path "*.csproj")) { "dotnet test" }
        else { Write-Warning "No recognized test config"; return }
        [Microsoft.PowerShell.PSConsoleReadLine]::Insert($command)
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }

Set-PSReadLineKeyHandler -Key Ctrl+Shift+s `
    -BriefDescription StartCurrentDirectory -LongDescription "Start the current directory" `
    -ScriptBlock {
        [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
        if (Test-Path ".\package.json") { [Microsoft.PowerShell.PSConsoleReadLine]::Insert("pnpm start") }
        else { [Microsoft.PowerShell.PSConsoleReadLine]::Insert("dotnet run") }
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }

# -------------------------------------------------------------------------
# Argument completers (registration is cheap; the script block runs per Tab)
# -------------------------------------------------------------------------
Register-ArgumentCompleter -Native -CommandName dotnet -ScriptBlock {
    param($commandName, $wordToComplete, $cursorPosition)
    dotnet complete --position $cursorPosition "$wordToComplete" | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}

Register-ArgumentCompleter -Native -CommandName winget -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Utf8Encoding]::new()
    $w = $wordToComplete.Replace('"', '""')
    $a = $commandAst.ToString().Replace('"', '""')
    winget complete --word="$w" --commandline "$a" --position $cursorPosition | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}

# gh: register a *lazy* completer. The real completer (which is ~hundreds of
# lines) gets dot-sourced from a cached file the first time you press Tab on
# `gh`, not at profile load. Saves dot-sourcing 20–50KB on every shell.
$script:GhCompleterCache = Join-Path $script:CacheDir 'gh-completion.ps1'
Register-ArgumentCompleter -Native -CommandName gh -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    if (-not $script:GhCompleterLoaded) {
        if ((-not (Test-Path $script:GhCompleterCache)) -or
            ((Get-Item $script:GhCompleterCache).LastWriteTime -lt (Get-Date).AddDays(-30))) {
            try { gh completion --shell powershell | Set-Content -LiteralPath $script:GhCompleterCache -Encoding UTF8 } catch {}
        }
        if (Test-Path $script:GhCompleterCache) { . $script:GhCompleterCache }
        $script:GhCompleterLoaded = $true
    }
    # gh's real completer is now registered; trigger it once more.
    TabExpansion2 $commandAst.ToString() $cursorPosition | Select-Object -ExpandProperty CompletionMatches
}

# -------------------------------------------------------------------------
# Kiro shell integration (host-specific)
# -------------------------------------------------------------------------
if ($env:TERM_PROGRAM -eq 'kiro') { . "$(kiro --locate-shell-integration-path pwsh)" }
