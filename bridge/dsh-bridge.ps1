#Requires -Version 7.2
[CmdletBinding()]
param(
  [Parameter(Position=0,Mandatory=$true)]
  [ValidateSet('status','sessions','create','delegate','prompt','wait','history','cancel')][string]$Action,
  [string]$ProjectPath, [string]$Task, [string]$TaskFile, [string]$SessionId,
  [string]$AgentPreset, [string]$AuthFile = $env:DSH_BRIDGE_AUTH_FILE,
  [string]$RequestId, [string]$ClientTimeZone = 'Asia/Shanghai',
  [ValidateRange(1,86400)][int]$TimeoutSeconds = 3600,
  [ValidateRange(1,60)][int]$PollSeconds = 2,
  [ValidateRange(1,200)][int]$MaxMessages = 50
)
$ErrorActionPreference='Stop'
. "$PSScriptRoot/dsh-bridge-core.ps1"
$connection=$null
try {
  # Check all local input before creating a session or sending a prompt.
  $text=$null; $resolved=$null
  if ($Action -in @('create','delegate')) {
    if (-not $ProjectPath) { throw 'DSH_PROJECT_REQUIRED' }
    $resolved=Get-Item -LiteralPath $ProjectPath -ErrorAction Stop
    if (-not $resolved.PSIsContainer) { throw 'DSH_PROJECT_INVALID' }
    $resolved=$resolved.FullName
    if (-not $SessionId) { $SessionId='session-'+[guid]::NewGuid().ToString() }
  }
  if ($Action -in @('prompt','wait','history','cancel') -and -not $SessionId) { throw 'DSH_SESSION_REQUIRED' }
  if ($Action -in @('delegate','prompt')) {
    if ($Task -and $TaskFile) { throw 'DSH_PROMPT_INVALID: use Task or TaskFile, not both.' }
    $text=if ($TaskFile) { Read-DshUtf8 $TaskFile } else { $Task }
    if (-not $RequestId) { $RequestId=[guid]::NewGuid().ToString() }
    $prompt=New-DshPromptRequest $SessionId $text $RequestId $ClientTimeZone
  }
  $connection=Open-DshConnection $AuthFile
  switch ($Action) {
    'status' {
      @{connected=$true;state='RPC_READY';baseUrl=$connection.baseUrl;processId=$connection.endpoint.processId;protocol='typert-remote';scope='authenticated session/list only; no task created'} | ConvertTo-Json
    }
    'sessions' { Invoke-DshRpc $connection 'session/list' @{_request=@{}} | ConvertTo-Json -Depth 50 }
    { $_ -in @('create','delegate') } {
      $request=@{cwd=$resolved;sessionId=$SessionId}
      if ($AgentPreset) { $request.agentPreset=$AgentPreset }
      $created=Invoke-DshRpc $connection 'session/create' @{request=$request}
      if ($created.sessionId -cne $SessionId) { throw 'DSH_CREATED_SESSION_MISMATCH' }
      if ($Action -eq 'delegate') {
        $receipt=Invoke-DshRpc $connection 'session/prompt' @{request=$prompt}
        if ($receipt.accepted -ne $true) { throw 'DSH_PROMPT_NOT_ACCEPTED' }
      }
      @{sessionId=$SessionId;requestId=$RequestId;projectPath=$resolved;created=$true;accepted=($Action -eq 'delegate')} | ConvertTo-Json
    }
    'prompt' {
      $receipt=Invoke-DshRpc $connection 'session/prompt' @{request=$prompt}
      if ($receipt.accepted -ne $true) { throw 'DSH_PROMPT_NOT_ACCEPTED' }
      @{sessionId=$SessionId;requestId=$RequestId;accepted=$true} | ConvertTo-Json
    }
    'history' {
      $snapshot=Read-DshStreamItem $connection 'session/follow' @{request=@{address=@{kind='session';sessionId=$SessionId};maxMessages=$MaxMessages}}
      if ($snapshot.type -ne 'snapshot') { throw 'DSH_HISTORY_SNAPSHOT_INVALID' }
      $snapshot | ConvertTo-Json -Depth 100
    }
    'wait' {
      $clock=[Diagnostics.Stopwatch]::StartNew(); $done=$false
      while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $listing=Invoke-DshRpc $connection 'session/list' @{_request=@{}}
        $session=@($listing.items | Where-Object {$_.sessionId -ceq $SessionId})
        if ($session.Count -ne 1) { throw 'DSH_SESSION_NOT_FOUND' }
        if (-not $session[0].running -and -not $session[0].blank) {
          $control=Read-DshStreamItem $connection 'session/control' @{}
          if ($control.type -ne 'baseline') { throw 'DSH_CONTROL_BASELINE_INVALID' }
          $queues=@($control.value.queues[$SessionId] | Where-Object {$_ -and $_.placement -in @('queued','steering')})
          $jobs=@($control.value.jobs[$SessionId] | Where-Object {$_ -and $_.status -in @('running','stopping')})
          if (-not $queues.Count -and -not $jobs.Count) {
            @{sessionId=$SessionId;state='IDLE_OBSERVED';verifiedSuccess=$false;note='Review history and workspace; idle is not acceptance.'} | ConvertTo-Json
            $done=$true; break
          }
        }
        Start-Sleep -Seconds $PollSeconds
      }
      if (-not $done) { throw 'DSH_WAIT_TIMEOUT: session was not cancelled.' }
    }
    'cancel' { Invoke-DshRpc $connection 'session/cancel' @{request=@{sessionId=$SessionId}} | ConvertTo-Json -Depth 20 }
  }
} catch {
  $message=$_.Exception.Message
  if ($message -notmatch '^DSH_[A-Z_]+:?') { $message='DSH_BRIDGE_FAILED: invalid input or unexpected local error; inspect locally without publishing credentials.' }
  @{connected=$false;error=$message;sessionId=$SessionId;requestId=$RequestId;note='No automatic retry, configuration change, process termination or credential extraction.'} | ConvertTo-Json -Depth 5
  exit 2
} finally { if ($connection) { $connection.client.Dispose() } }
