#Requires -Version 5.1
<#
.SYNOPSIS
    Make Windows keep the hardware clock in UTC, like Linux does.

.DESCRIPTION
    Windows writes local time to the hardware (RTC) clock; Linux reads it as
    UTC. On a dual boot machine each boot of one system leaves the clock off
    by the UTC offset for the other (2 hours in CEST) until it syncs with NTP.

    Setting RealTimeIsUniversal makes Windows read and write the RTC as UTC,
    so both systems agree. Reboot Windows once after running this.

.PARAMETER Revert
    Remove the setting so Windows uses local time again.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\scripts\fix-dualboot-clock.ps1

.NOTES
    Needs an elevated (Administrator) PowerShell session.
#>

[CmdletBinding()]
param(
    [switch]$Revert
)

$ErrorActionPreference = 'Stop'

$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation'
$name = 'RealTimeIsUniversal'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated (Administrator) PowerShell session.'
}

if ($Revert) {
    Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
    Write-Host 'Removed RealTimeIsUniversal. Windows keeps the hardware clock in local time again.' -ForegroundColor Yellow
    return
}

$current = (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name
if ($current -eq 1) {
    Write-Host 'Windows already keeps the hardware clock in UTC.' -ForegroundColor Green
    return
}

# QWORD: the DWORD form is ignored on some 64-bit Windows builds
New-ItemProperty -Path $key -Name $name -PropertyType QWord -Value 1 -Force | Out-Null

# Resync now so Windows writes the correct time back as UTC
try {
    Start-Service w32time -ErrorAction Stop
    w32tm /resync /force | Out-Null
} catch {
    Write-Host "  Time resync skipped: $($_.Exception.Message)" -ForegroundColor DarkGray
}

Write-Host 'Windows now keeps the hardware clock in UTC. Reboot once to finish.' -ForegroundColor Green
