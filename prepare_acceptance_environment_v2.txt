param(
  [string]$RepoRoot = 'C:\projeler\energy-mqtt-platform',
  [string]$Sn = '24042809890002',
  [switch]$StartServices = $true,
  [switch]$VerifyPolicy = $true,
  [switch]$ShowLastCommands = $true
)

$ErrorActionPreference = 'Stop'

function Start-CmdWindow {
  param(
    [string]$Title,
    [string]$Command
  )

  $cmdArgs = "/k title $Title && cd /d `"$RepoRoot`" && $Command"
  Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs | Out-Null
}

function Wait-ForApi {
  param([int]$TimeoutSec = 120)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $null = Invoke-WebRequest 'http://localhost:3001/command-policy-profiles' -UseBasicParsing -TimeoutSec 5
      return
    }
    catch {
      Start-Sleep -Seconds 2
    }
  }

  throw 'API did not become ready in time.'
}

if ($StartServices) {
  Write-Host 'Starting API and worker windows...' -ForegroundColor Cyan
  Start-CmdWindow -Title 'energy-api' -Command 'pnpm --filter @communication/db build && pnpm --filter api dev'
  Start-CmdWindow -Title 'energy-worker' -Command 'set COMMAND_ACK_TIMEOUT_SEC=20 && set COMMAND_ACK_RETRY_MIN_DELAY_SEC=5 && set COMMAND_VERIFY_TIMEOUT_SEC=420 && pnpm --filter mqtt-worker dev'
  Wait-ForApi
}

Set-ExecutionPolicy -Scope Process Bypass | Out-Null
if (Test-Path (Join-Path $RepoRoot 'command_probe.ps1')) {
  Unblock-File (Join-Path $RepoRoot 'command_probe.ps1')
}
if (Test-Path (Join-Path $RepoRoot 'run_acceptance_suite.ps1')) {
  Unblock-File (Join-Path $RepoRoot 'run_acceptance_suite.ps1')
}
if (Test-Path (Join-Path $RepoRoot 'prepare_acceptance_environment.ps1')) {
  Unblock-File (Join-Path $RepoRoot 'prepare_acceptance_environment.ps1')
}

Write-Host "`nEnvironment prepared." -ForegroundColor Green
Write-Host "RepoRoot: $RepoRoot"
Write-Host "Device SN: $Sn"

if ($VerifyPolicy) {
  Write-Host "`nResolved policy:" -ForegroundColor Cyan
  $policy = (Invoke-WebRequest "http://localhost:3001/devices/$Sn/command-policy" -UseBasicParsing).Content | ConvertFrom-Json
  $policy.resolvedOrchestration | Format-List | Out-Host
}

if ($ShowLastCommands) {
  Write-Host "`nLast commands:" -ForegroundColor Cyan
  docker exec -i communication-postgres psql -U postgres -d communication -c "SELECT id, command_type, status, published_at, ack_at, verified_at, completed_at, error_message FROM commands WHERE sn = '$Sn' ORDER BY id DESC LIMIT 10;" | Out-Host
}

Write-Host "`nNow you can run commands manually when you want:" -ForegroundColor Yellow
Write-Host "  & .\command_probe.ps1 -Command refresh -Runs 1 -WaitPerRunSec 900"
Write-Host "  & .\command_probe.ps1 -Command force_switch_0 -Runs 1 -WaitPerRunSec 900"
Write-Host "  & .\command_probe.ps1 -Command force_switch_1 -Runs 1 -WaitPerRunSec 900"
