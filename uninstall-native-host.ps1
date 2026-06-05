$ErrorActionPreference = "Stop"

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.hotpepper.course_capture"
if (Test-Path $registryPath) {
  Remove-Item -Path $registryPath -Force
  Write-Host "Removed $registryPath"
} else {
  Write-Host "Native host is not registered."
}
