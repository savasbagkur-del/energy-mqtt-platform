param(
  [string]$BaseUrl = 'http://localhost:3001',
  [string]$Sn = '24042809890002',
  [string]$DbContainer = 'communication-postgres',
  [string]$DbName = 'communication',
  [string]$DbUser = 'postgres',
  [int]$Runs = 5,
  [int]$WaitPerRunSec = 30,
  [int]$PollEverySec = 1,
  [string]$OutFile = '.\refresh_probe_results.json'
)

$ErrorActionPreference = 'Stop'

function Invoke-PsqlJson {
  param([string]$Sql)

  $cmd = "psql -U $DbUser -d $DbName -t -A -F '|' -c \"$Sql\""
  $raw = docker exec -i $DbContainer sh -lc $cmd
  return ($raw | Out-String).Trim()
}

function Get-CommandState {
  param([string]$CommandId)

  $sql = @"
SELECT json_build_object(
  'id', id,
  'status', status,
  'published_at', published_at,
  'ack_at', ack_at,
  'verified_at', verified_at,
  'completed_at', completed_at,
  'request_payload', request_payload,
  'ack_payload', ack_payload,
  'error_message', error_message,
  'ack_latency_ms', CASE
    WHEN published_at IS NOT NULL AND ack_at IS NOT NULL
    THEN ROUND(EXTRACT(EPOCH FROM (ack_at - published_at)) * 1000)
    ELSE NULL
  END,
  'verify_latency_ms', CASE
    WHEN ack_at IS NOT NULL AND verified_at IS NOT NULL
    THEN ROUND(EXTRACT(EPOCH FROM (verified_at - ack_at)) * 1000)
    ELSE NULL
  END,
  'end_to_end_ms', CASE
    WHEN published_at IS NOT NULL AND completed_at IS NOT NULL
    THEN ROUND(EXTRACT(EPOCH FROM (completed_at - published_at)) * 1000)
    ELSE NULL
  END
)
FROM commands
WHERE id = $CommandId;
"@

  $raw = Invoke-PsqlJson -Sql $sql
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

function Get-CommandEvents {
  param([string]$CommandId)

  $sql = @"
SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.created_at), '[]'::json)
FROM (
  SELECT event_type, created_at, payload
  FROM command_events
  WHERE command_id = $CommandId
  ORDER BY created_at ASC
) x;
"@

  $raw = Invoke-PsqlJson -Sql $sql
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  return $raw | ConvertFrom-Json
}

function Get-RecentTelemetryRaw {
  param([string]$SnValue)

  $sql = @"
SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.created_at DESC), '[]'::json)
FROM (
  SELECT id, topic, method, msgid, created_at, device_sample_at, device_sent_at, worker_received_at
  FROM telemetry_raw
  WHERE sn = '$SnValue'
  ORDER BY created_at DESC
  LIMIT 5
) x;
"@

  $raw = Invoke-PsqlJson -Sql $sql
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  return $raw | ConvertFrom-Json
}

function Is-TerminalStatus {
  param([string]$Status)

  return $Status -in @(
    'verified_success',
    'verified_mismatch',
    'failed',
    'delivery_timeout',
    'expired'
  )
}

$results = New-Object System.Collections.Generic.List[object]

for ($i = 1; $i -le $Runs; $i++) {
  Write-Host "`n===== REFRESH RUN $i / $Runs =====" -ForegroundColor Cyan

  $response = Invoke-WebRequest "$BaseUrl/devices/$Sn/commands/refresh" -Method POST -UseBasicParsing
  $body = $response.Content | ConvertFrom-Json
  $commandId = [string]$body.id
  $commandMsgId = [string]$body.msgid

  Write-Host "created commandId=$commandId msgid=$commandMsgId" -ForegroundColor Yellow

  $deadline = (Get-Date).AddSeconds($WaitPerRunSec)
  $lastState = $null

  while ((Get-Date) -lt $deadline) {
    $lastState = Get-CommandState -CommandId $commandId
    if ($null -eq $lastState) {
      Start-Sleep -Seconds $PollEverySec
      continue
    }

    $status = [string]$lastState.status
    $ack = if ($lastState.ack_at) { 'yes' } else { 'no' }
    $ver = if ($lastState.verified_at) { 'yes' } else { 'no' }
    Write-Host ("status={0} ack={1} verified={2}" -f $status, $ack, $ver)

    if (Is-TerminalStatus -Status $status) {
      break
    }

    Start-Sleep -Seconds $PollEverySec
  }

  $finalState = Get-CommandState -CommandId $commandId
  $events = Get-CommandEvents -CommandId $commandId
  $recentTelemetry = Get-RecentTelemetryRaw -SnValue $Sn

  $summary = [pscustomobject]@{
    run = $i
    command_id = $commandId
    msgid = $commandMsgId
    final = $finalState
    events = $events
    recent_telemetry_raw = $recentTelemetry
  }

  $results.Add($summary)

  if ($null -ne $finalState) {
    Write-Host "FINAL => status=$($finalState.status) ack_latency_ms=$($finalState.ack_latency_ms) verify_latency_ms=$($finalState.verify_latency_ms) end_to_end_ms=$($finalState.end_to_end_ms)" -ForegroundColor Green
  } else {
    Write-Host "FINAL => command state not found" -ForegroundColor Red
  }

  if ($i -lt $Runs) {
    Write-Host "waiting 5 seconds before next run..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
  }
}

$results | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "`nSaved: $OutFile" -ForegroundColor Cyan

# Compact summary table
$results |
  ForEach-Object {
    [pscustomobject]@{
      run = $_.run
      command_id = $_.command_id
      msgid = $_.msgid
      status = $_.final.status
      ack_at = $_.final.ack_at
      verified_at = $_.final.verified_at
      completed_at = $_.final.completed_at
      ack_latency_ms = $_.final.ack_latency_ms
      verify_latency_ms = $_.final.verify_latency_ms
      end_to_end_ms = $_.final.end_to_end_ms
      error_message = $_.final.error_message
    }
  } |
  Format-Table -AutoSize
