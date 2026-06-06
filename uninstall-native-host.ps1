# Video Course Capture
# Purpose: Removes Video Course Capture native messaging host registry entries from the current Windows user.
# Most to know: this also removes the old legacy host id so renamed installs do not leave stale registry keys.
# Developed and maintained by Alexey Kagansky
# Copyright (c) 2026 Alexey Kagansky
# Repository: https://github.com/ale4ko69/chrome-course-capture

$ErrorActionPreference = "Stop"

$registryRoot = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
$registryPaths = @(
  (Join-Path $registryRoot "com.video_course_capture.native_host"),
  (Join-Path $registryRoot "com.hotpepper.course_capture")
)

$removed = $false
foreach ($registryPath in $registryPaths) {
  if (-not (Test-Path $registryPath)) {
    continue
  }
  Remove-Item -Path $registryPath -Force
  Write-Host "Removed $registryPath"
  $removed = $true
}

if (-not $removed) {
  Write-Host "Native host is not registered."
}
