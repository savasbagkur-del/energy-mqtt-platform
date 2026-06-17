param(
  [ValidateSet('refresh','force_switch_0','force_switch_1')]
  [string]$Command = 'refresh',
  [string]$BaseUrl = 'http://localhost:3001',
  [string]$Sn = '24042809890002',
  [string]$DbContainer = 'communication-postgres',
  [string]$DbName = 'communication',
  [string]$DbUser = 'postgres',
  [int]$Runs = 1,
  [int]$WaitPerRunSec = 480,
  [int]$PollEverySec = 5,
  [int]$GapBetweenRunsSec = 10,
  [string]$OutFile = '.\command_probe_results.json'
)

$ErrorActionPreference = 'Stop'

function Invoke-DbJson {
  param([string]$Sql)

  $raw = & docker exec -i $DbContainer psql -U $DbUser -d $DbName -t -A -c $Sql
  $text = ($raw | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text
}

function Get-CommandState {
  param([string]$CommandId)

  $sql = @"
SELECT json_build_object(
  'id', id,
  'command_type', command_type,
  'status', status,
  'published_at', published_at,
  'ack_at', ack_at,
  'verified_at', verified_at,
  'completed_at', completed_at,
  'error_message', error_message,
  'request_payload', request_payload,
  'ack_payload', ack_payload,
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

  $json = Invoke-DbJson -Sql $sql
  if ($null -eq $json) { return $null }
  return $json | ConvertFrom-Json
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

  $json = Invoke-DbJson -Sql $sql
  if ($null -eq $json) { return @() }
  return $json | ConvertFrom-Json
}

function Get-LatestState {
  param([string]$SnValue)

  $sql = @"
SELECT json_build_object(
  'sn', sn,
  'last_method', last_method,
  'last_topic', last_topic,
  'last_summary', last_summary,
  'updated_at', updated_at
)
FROM latest_state
WHERE sn = '$SnValue';
"@

  $json = Invoke-DbJson -Sql $sql
  if ($null -eq $json) { return $null }
  return $json | ConvertFrom-Json
}

function Is-TerminalStatus {
  param([string]$Status)

  return $Status -in @(
    'verified_success',
    'verified_success_with_late_confirmation',
    'verified_mismatch',
    'failed',
    'delivery_timeout',
    'verify_timeout',
    'expired'
  )
}

function Get-PathForCommand {
  switch ($Command) {
    'refresh' { return 'refresh' }
    'force_switch_0' { return 'force-switch-0' }
    'force_switch_1' { return 'force-switch-1' }
  }
}

$results = New-Object System.Collections.Generic.List[object]
$commandPath = Get-PathForCommand

for ($i = 1; $i -le $Runs; $i++) {
  Write-Host "`n===== RUN $i / $Runs : $Command =====" -ForegroundColor Cyan

  $response = Invoke-WebRequest "$BaseUrl/devices/$Sn/commands/$commandPath" -Method POST -UseBasicParsing
  $body = $response.Content | ConvertFrom-Json
  $commandId = [string]$body.id
  $msgid = [string]$body.msgid

  Write-Host "created commandId=$commandId msgid=$msgid" -ForegroundColor Yellow

  $deadline = (Get-Date).AddSeconds($WaitPerRunSec)

  do {
    $state = Get-CommandState -CommandId $commandId
    if ($null -ne $state) {
      $ack = if ($state.ack_at) { 'yes' } else { 'no' }
      $ver = if ($state.verified_at) { 'yes' } else { 'no' }
      Write-Host ("status={0} ack={1} verified={2}" -f $state.status, $ack, $ver)

      if (Is-TerminalStatus -Status ([string]$state.status)) {
        break
      }
    }

    Start-Sleep -Seconds $PollEverySec
  } while ((Get-Date) -lt $deadline)

  $finalState = Get-CommandState -CommandId $commandId
  $events = Get-CommandEvents -CommandId $commandId
  $latestState = Get-LatestState -SnValue $Sn

  $result = [pscustomobject]@{
    run = $i
    command = $Command
    command_id = $commandId
    msgid = $msgid
    final = $finalState
    latest_state = $latestState
    events = $events
  }

  $results.Add($result)

  if ($null -ne $finalState) {
    Write-Host ("FINAL => status={0} ack_ms={1} verify_ms={2} total_ms={3}" -f $finalState.status, $finalState.ack_latency_ms, $finalState.verify_latency_ms, $finalState.end_to_end_ms) -ForegroundColor Green
  } else {
    Write-Host "FINAL => state not found" -ForegroundColor Red
  }

  if ($i -lt $Runs) {
    Write-Host "waiting $GapBetweenRunsSec seconds before next run..." -ForegroundColor DarkGray
    Start-Sleep -Seconds $GapBetweenRunsSec
  }
}

$results | ConvertTo-Json -Depth 12 | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "`nSaved: $OutFile" -ForegroundColor Cyan

$results |
  ForEach-Object {
    [pscustomobject]@{
      run = $_.run
      command = $_.command
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