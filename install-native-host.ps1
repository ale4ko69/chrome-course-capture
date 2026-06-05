param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $root "native-host\com.hotpepper.course_capture.json"
$cmdPath = Join-Path $root "native-host\native-host.cmd"

if (-not (Test-Path $cmdPath)) {
  throw "Native host command not found: $cmdPath"
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$manifest.path = $cmdPath
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.hotpepper.course_capture"
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath

Write-Host "Registered native host:"
Write-Host "  $registryPath"
Write-Host "  $manifestPath"
