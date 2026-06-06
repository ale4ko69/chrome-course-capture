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
