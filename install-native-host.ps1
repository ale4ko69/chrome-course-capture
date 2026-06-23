# Video Course Capture
# Purpose: Registers the Windows Chrome native messaging host for the current unpacked extension ID.
# Most to know: this script writes the extension-specific native host manifest path and allowed origin.
# Developed and maintained by Alexey Kagansky
# Copyright (c) 2026 Alexey Kagansky
# Repository: https://github.com/ale4ko69/chrome-course-capture

param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName = "com.video_course_capture.native_host"
$manifestTemplatePath = Join-Path $root "native-host\$hostName.json"
$localConfigDir = Join-Path $env:LOCALAPPDATA "VideoCourseCapture"
$manifestPath = Join-Path $localConfigDir "$hostName.json"
$cmdPath = Join-Path $root "native-host\native-host.cmd"

if (-not (Test-Path $cmdPath)) {
  throw "Native host command not found: $cmdPath"
}

if (-not (Test-Path $manifestTemplatePath)) {
  throw "Native host manifest template not found: $manifestTemplatePath"
}

New-Item -ItemType Directory -Path $localConfigDir -Force | Out-Null

$manifest = Get-Content -Raw -Path $manifestTemplatePath | ConvertFrom-Json
$manifest.path = $cmdPath
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

$registryRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
$registryPath = Join-Path $registryRoot $hostName
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath

Write-Host "Registered native host:"
Write-Host "  $registryPath"
Write-Host "  $manifestPath"
