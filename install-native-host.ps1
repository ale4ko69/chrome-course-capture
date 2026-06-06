# Video Course Capture
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
$oldHostName = "com.hotpepper.course_capture"
$manifestPath = Join-Path $root "native-host\$hostName.json"
$cmdPath = Join-Path $root "native-host\native-host.cmd"

if (-not (Test-Path $cmdPath)) {
  throw "Native host command not found: $cmdPath"
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$manifest.path = $cmdPath
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

$registryRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
$oldRegistryPath = Join-Path $registryRoot $oldHostName
if (Test-Path $oldRegistryPath) {
  Remove-Item -Path $oldRegistryPath -Force
}

$registryPath = Join-Path $registryRoot $hostName
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath

Write-Host "Registered native host:"
Write-Host "  $registryPath"
Write-Host "  $manifestPath"
