# EasyTech API demo — Arge müşterisi (3. parti yazılım simülasyonu)
#
# Kullanım:
#   .\scripts\easytech-arge-demo.ps1
#   .\scripts\easytech-arge-demo.ps1 -RoomNo Arge2
#   .\scripts\easytech-arge-demo.ps1 -PlainPassword "EasyTech-Gateway-2026!"
#
# Not: /login body parolasi MD5 hex olarak gider (EasyTech vendor formati).

param(
  [string]$ApiBase = "https://api.volt4amper.com",
  [string]$Username = "easyarge",
  [string]$PlainPassword = "EasyTech-Gateway-2026!",
  [string]$PasswordMd5 = "",
  [string]$RoomNo = "Arge1",
  [switch]$TryControl
)

$ErrorActionPreference = "Stop"

function Get-Md5Hex([string]$text) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  return ([BitConverter]::ToString($md5.ComputeHash($bytes)) -replace "-", "").ToLowerInvariant()
}

function Invoke-EasyTechJson {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Body = $null,
    [string]$Token = $null
  )
  $uri = "$ApiBase$Path"
  $headers = @{ "Content-Type" = "application/json" }
  if ($Token) { $headers["token"] = $Token }
  $params = @{
    Uri = $uri
    Method = $Method
    Headers = $headers
  }
  if ($Body) {
    $params.Body = ($Body | ConvertTo-Json -Compress)
  }
  return Invoke-RestMethod @params
}

$md5 = if ($PasswordMd5) { $PasswordMd5.ToLowerInvariant() } else { Get-Md5Hex $PlainPassword }

Write-Host ""
Write-Host "=== EasyTech API demo ===" -ForegroundColor Cyan
Write-Host "API:      $ApiBase"
Write-Host "User:     $Username"
Write-Host "roomNo:   $RoomNo"
Write-Host "pass MD5: $md5"
Write-Host ""

Write-Host "1 - POST /login" -ForegroundColor Yellow
$login = Invoke-EasyTechJson -Method POST -Path "/login" -Body @{
  username = $Username
  password = $md5
}
$login | ConvertTo-Json -Depth 5
if ($login.success -ne 1) {
  Write-Host "Login basarisiz." -ForegroundColor Red
  exit 1
}
$userToken = $login.userToken
$adminToken = $login.adminToken
Write-Host "OK - userToken + adminToken alindi" -ForegroundColor Green

Write-Host ""
Write-Host "2 - GET /getMeterList" -ForegroundColor Yellow
$list = Invoke-EasyTechJson -Method GET -Path "/getMeterList" -Token $userToken
$list | ConvertTo-Json -Depth 6

Write-Host ""
Write-Host "3 - POST /getMeterInfo roomNo=$RoomNo" -ForegroundColor Yellow
$info = Invoke-EasyTechJson -Method POST -Path "/getMeterInfo" -Token $userToken -Body @{
  roomNo = $RoomNo
}
$info | ConvertTo-Json -Depth 6

if ($info.success -eq 1 -and $info.data) {
  $d = $info.data
  Write-Host ""
  Write-Host "Ozet:" -ForegroundColor Cyan
  Write-Host "  meterID:    $($d.meterID)"
  Write-Host "  balance:    $($d.balance)"
  Write-Host "  epi:        $($d.epi)"
  Write-Host "  switchSta:  $($d.switchSta)"
  Write-Host "  unConnect:  $($d.unConnect)"
  Write-Host "  ua/Ia/P:    $($d.ua) V / $($d.Ia) A / $($d.p) kW"
}

if ($TryControl) {
  Write-Host ""
  Write-Host "4 - POST /meterControl FORCESWITCH adminToken" -ForegroundColor Yellow
  Write-Host "   UYARI: Gercek sayac rolesi etkilenir" -ForegroundColor Red
  $ctrl = Invoke-EasyTechJson -Method POST -Path "/meterControl" -Token $adminToken -Body @{
    meterSn = $info.data.meterID
    method = "FORCESWITCH"
    value = @{ ForceSwitch = 1 }
  }
  $ctrl | ConvertTo-Json -Depth 5
} else {
  Write-Host ""
  Write-Host "Komut testi atlandi. Fiziksel ac/kapa denemek icin: -TryControl" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Bitti." -ForegroundColor Green
