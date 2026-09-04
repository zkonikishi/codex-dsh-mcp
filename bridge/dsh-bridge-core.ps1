# PowerShell 7; current Desktop HTTP + Typert protocol. No secret discovery.
Set-StrictMode -Version Latest

function Get-DshWebConfig {
  if (-not $env:DSH_MCP_WEB) { throw 'DSH_WEB_CONFIG_REQUIRED' }
  $c=$env:DSH_MCP_WEB | ConvertFrom-Json -AsHashtable
  if (-not $c.node -or -not $c.cli -or -not $c.port -or
      -not [IO.Path]::IsPathRooted($c.node) -or -not [IO.Path]::IsPathRooted($c.cli) -or
      $c.port -lt 1 -or $c.port -gt 65535) { throw 'DSH_WEB_CONFIG_REQUIRED' }
  return $c
}

function Read-DshUtf8([string]$Path, [int]$MaxBytes = 1048576) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -gt $MaxBytes) { throw 'DSH_INPUT_INVALID: file must be bounded and regular.' }
  return [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($item.FullName)).TrimStart([char]0xFEFF)
}
function Assert-DshOrigin([string]$Origin) {
  $uri = $null
  if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1','[::1]','::1') -or
      $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
    throw 'DSH_ORIGIN_INVALID: only an exact HTTP loopback origin is allowed.'
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}
function Test-DshWebOwner($Owner) {
  if (!$Owner) { return $false }
  $config=Get-DshWebConfig
  $expectedNode=$config.node
  $expectedCli=$config.cli
  if ($Owner.ExecutablePath -ine $expectedNode) { return $false }
  $argv=@([regex]::Matches([string]$Owner.CommandLine,'"([^"]*)"|(\S+)') | ForEach-Object { if($_.Groups[1].Success){$_.Groups[1].Value}else{$_.Groups[2].Value} })
  $expected=@($expectedNode,$expectedCli,'web','--port',[string]$config.port,'--no-open','--host','127.0.0.1')
  if($argv.Count -ne $expected.Count){return $false}
  for($i=0;$i -lt $expected.Count;$i++){if($argv[$i] -ine $expected[$i]){return $false}}
  return $true
}
function Get-DshListenerPid {
  $config=Get-DshWebConfig
  $pattern='^\s*TCP\s+127\.0\.0\.1:'+([string]$config.port)+'\s+\S+\s+LISTENING\s+(\d+)\s*$'
  $ids=@(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp | ForEach-Object {
    if($_ -match $pattern){[int]$Matches[1]}
  } | Select-Object -Unique)
  if($ids.Count -gt 1){throw 'DSH_MULTIPLE_LISTENERS'}
  if($ids.Count -eq 1){return $ids[0]}
  return 0
}
function Get-DshEndpoints {
  $listenerId=Get-DshListenerPid
  if(!$listenerId){throw 'DSH_WEB_NOT_LISTENING: configured loopback endpoint unavailable.'}
  $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId"
  if(!(Test-DshWebOwner $owner)){throw 'DSH_FOREIGN_LISTENER: listener is not the configured DSH Web process.'}
  $config=Get-DshWebConfig
  [pscustomobject]@{baseUrl="http://127.0.0.1:$($config.port)";processId=$owner.ProcessId;startedAt=$owner.CreationDate;port=$config.port;address='127.0.0.1'}
}
function Assert-DshOwner($Endpoint) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($Endpoint.processId)" -ErrorAction Stop
  if (!(Test-DshWebOwner $owner) -or $owner.CreationDate -ne $Endpoint.startedAt) {
    throw 'DSH_GENERATION_CHANGED: rediscover the listener; request was not retried.'
  }
  if ((Get-DshListenerPid) -ne $Endpoint.processId) { throw 'DSH_LISTENER_CHANGED: rediscover the listener; request was not retried.' }
}
function New-DshConnection($Endpoint, [string]$AuthFile) {
  $origin = Assert-DshOrigin $Endpoint.baseUrl
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.UseProxy=$false; $handler.AllowAutoRedirect=$false
  $handler.CookieContainer=[Net.CookieContainer]::new()
  $client=[Net.Http.HttpClient]::new($handler)
  $client.Timeout=[TimeSpan]::FromSeconds(30)
  $connection=[pscustomobject]@{endpoint=$Endpoint;baseUrl=$origin;handler=$handler;client=$client;launchToken=$null}
  try {
    if ($AuthFile) {
      $auth=Read-DshUtf8 $AuthFile 16384 | ConvertFrom-Json -AsHashtable
      if (-not $auth.ContainsKey('baseUrl') -or (Assert-DshOrigin $auth.baseUrl) -cne $origin) { throw 'DSH_AUTH_ORIGIN_MISMATCH: supplied credential belongs to another listener.' }
      if ($auth.ContainsKey('cookie') -and $auth.ContainsKey('launchToken')) { throw 'DSH_AUTH_INVALID: provide one credential type.' }
      if ($auth.ContainsKey('cookie')) {
        if ($auth.cookie -isnot [string] -or $auth.cookie -notmatch '^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$') { throw 'DSH_AUTH_INVALID: invalid cookie format.' }
        $handler.CookieContainer.SetCookies([Uri]$origin,$auth.cookie)
      } elseif ($auth.ContainsKey('launchToken')) {
        if ($auth.launchToken -isnot [string] -or $auth.launchToken -notmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'DSH_AUTH_INVALID: invalid launch token format.' }
        $connection.launchToken=$auth.launchToken
      } else { throw 'DSH_AUTH_INVALID: no supported credential was supplied.' }
    }
    return $connection
  } catch { $client.Dispose(); throw }
}
function Invoke-DshHttp($Connection,[string]$Path,[string]$Body,[int]$TimeoutSeconds=30) {
  Assert-DshOwner $Connection.endpoint
  if (-not $Path.StartsWith('/') -or $Path.StartsWith('//')) { throw 'DSH_PATH_INVALID' }
  $method=if ([string]::IsNullOrEmpty($Body)) { [Net.Http.HttpMethod]::Get } else { [Net.Http.HttpMethod]::Post }
  $request=[Net.Http.HttpRequestMessage]::new($method,"$($Connection.baseUrl)$Path")
  $request.Headers.Add('Origin',$Connection.baseUrl)
  if ($method -eq [Net.Http.HttpMethod]::Post) { $request.Content=[Net.Http.StringContent]::new($Body,[Text.Encoding]::UTF8,'application/json') }
  $cts=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
  $response=$null; $stream=$null; $buffered=[IO.MemoryStream]::new()
  try {
    $response=$Connection.client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cts.Token).GetAwaiter().GetResult()
    $stream=$response.Content.ReadAsStreamAsync($cts.Token).GetAwaiter().GetResult()
    $bytes=[byte[]]::new(16384)
    while (($count=$stream.ReadAsync($bytes,0,$bytes.Length,$cts.Token).GetAwaiter().GetResult()) -gt 0) {
      if ($buffered.Length+$count -gt 8388608) { throw 'DSH_RESPONSE_TOO_LARGE' }
      $buffered.Write($bytes,0,$count)
    }
    return @{status=[int]$response.StatusCode;text=[Text.UTF8Encoding]::new($false,$true).GetString($buffered.ToArray());location=[string]$response.Headers.Location}
  } catch {
    # Transport errors can contain auth URLs. Never relay them or retry writes.
    throw 'DSH_TRANSPORT_FAILED: request failed or exceeded its time/size limit; write outcome may be unknown. Do not blindly retry.'
  } finally {
    if ($stream) { $stream.Dispose() }; if ($response) { $response.Dispose() }
    $request.Dispose(); $cts.Dispose(); $buffered.Dispose()
  }
}
function Get-DshAccessCode([int]$Status,[string]$Text) {
  switch ($Status) {
    403 { return 'DESKTOP_ACCESS_DENIED' }
    401 { return 'AUTH_REQUIRED' }
    200 { if ($Text -match '__DSH_BOOT__') { return 'INDEX_READY' }; return 'UNRECOGNIZED_SERVICE' }
    default { return "HTTP_$Status" }
  }
}
function Open-DshConnection([string]$AuthFile) {
  $endpoints=@(Get-DshEndpoints)
  if (-not $endpoints.Count) { throw 'DSH_NO_LISTENER: Desktop is running but has no loopback listener.' }
  $observations=[Collections.Generic.List[string]]::new()
  foreach ($endpoint in $endpoints) {
    $connection=New-DshConnection $endpoint $AuthFile
    try {
      $path='/'
      if ($connection.launchToken) { $path+='?token='+[Uri]::EscapeDataString($connection.launchToken) }
      $response=Invoke-DshHttp $connection $path '' 5
      $connection.launchToken=$null
      if ($response.status -eq 303) {
        if ($response.location -ne '/') { throw 'DSH_AUTH_REDIRECT_REJECTED' }
        $response=Invoke-DshHttp $connection '/' '' 5
      }
      $code=Get-DshAccessCode $response.status $response.text
      if ($code -eq 'INDEX_READY') {
        $null=Invoke-DshRpc $connection 'session/list' @{_request=@{}}
        return $connection
      }
      $observations.Add($code)
    } catch { $connection.client.Dispose(); throw }
    $connection.client.Dispose()
  }
  if ($observations.Contains('DESKTOP_ACCESS_DENIED')) {
    throw 'DSH_DESKTOP_ACCESS_DENIED: Desktop is running but external HTTP access returned 403. Browser access may be disabled even in compatibility mode; 403 alone does not identify the active mode. Use an approved automation interface or compatibility mode with browser access enabled and loopback exposure. The bridge will not change settings or extract renderer secrets.'
  }
  if ($observations.Contains('AUTH_REQUIRED')) { throw 'DSH_AUTH_REQUIRED: supply a valid operator-provided launch token or cookie in -AuthFile. No Desktop credential storage was read.' }
  throw ('DSH_API_UNAVAILABLE: '+($observations -join ', '))
}
function New-DshRpcEnvelope([string]$Endpoint,[hashtable]$WireArgs) {
  if ($Endpoint -notmatch '^[A-Za-z][A-Za-z0-9]*/[A-Za-z][A-Za-z0-9]*$') { throw 'DSH_ENDPOINT_INVALID: expected namespace/method.' }
  return @{type='client-request';rpcId=[guid]::NewGuid().ToString();method=$Endpoint;payload=@{args=$WireArgs}}
}
function Read-DshRpcResponse($Envelope,$Response) {
  if ($Response.status -eq 401) { throw 'DSH_AUTH_EXPIRED: authenticate again; no automatic retry.' }
  if ($Response.status -eq 403) { throw 'DSH_DESKTOP_ACCESS_DENIED: HTTP access revoked; no automatic retry.' }
  if ($Response.status -ne 200) { throw "DSH_RPC_HTTP_ERROR: HTTP $($Response.status); request was not retried." }
  $value=$Response.text | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  if ($value.type -ne 'server-response' -or $value.rpcId -cne $Envelope.rpcId -or $value.result.ok -isnot [bool]) { throw 'DSH_RPC_CORRELATION_INVALID' }
  if (-not $value.result.ok) {
    $code=[string]$value.result.error.code
    if ($code -notmatch '^[A-Za-z0-9_/-]{1,100}$') { $code='unknown' }
    throw "DSH_RPC_REJECTED: $code. Remote message omitted to protect request data."
  }
  return $value.result.value
}
function Invoke-DshRpc($Connection,[string]$Endpoint,[hashtable]$WireArgs) {
  $envelope=New-DshRpcEnvelope $Endpoint $WireArgs
  $body=$envelope | ConvertTo-Json -Depth 40 -Compress
  $response=Invoke-DshHttp $Connection "/api/$Endpoint" $body
  return Read-DshRpcResponse $envelope $response
}
function Read-DshStreamItem($Connection,[string]$Endpoint,[hashtable]$WireArgs,[int]$TimeoutSeconds=30) {
  Assert-DshOwner $Connection.endpoint
  $null=New-DshRpcEnvelope $Endpoint $WireArgs
  $socket=[Net.WebSockets.ClientWebSocket]::new()
  $socket.Options.Proxy=$null; $socket.Options.Cookies=$Connection.handler.CookieContainer
  $socket.Options.SetRequestHeader('Origin',$Connection.baseUrl)
  $cts=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
  $id=[guid]::NewGuid().ToString(); $buffer=[byte[]]::new(16384); $message=[IO.MemoryStream]::new()
  try {
    $uri=[Uri]($Connection.baseUrl.Replace('http:','ws:')+'/api/remote.mux')
    $socket.ConnectAsync($uri,$cts.Token).GetAwaiter().GetResult() | Out-Null
    $frame=@{type='open';streamId=$id;endpoint=$Endpoint;payload=@{args=$WireArgs}} | ConvertTo-Json -Depth 30 -Compress
    $send=[ArraySegment[byte]]::new([Text.Encoding]::UTF8.GetBytes($frame))
    $socket.SendAsync($send,[Net.WebSockets.WebSocketMessageType]::Text,$true,$cts.Token).GetAwaiter().GetResult() | Out-Null
    do {
      $read=$socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cts.Token).GetAwaiter().GetResult()
      if ($read.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text -or $message.Length+$read.Count -gt 8388608) { throw 'DSH_STREAM_FRAME_INVALID' }
      $message.Write($buffer,0,$read.Count)
    } while (-not $read.EndOfMessage)
    $item=[Text.UTF8Encoding]::new($false,$true).GetString($message.ToArray()) | ConvertFrom-Json -AsHashtable
    if ($item.streamId -cne $id -or $item.type -ne 'item') { throw 'DSH_STREAM_REJECTED_OR_INVALID' }
    return $item.value
  } catch { throw 'DSH_STREAM_FAILED: no valid bounded initial snapshot; no session was cancelled.' }
  finally {
    # Closing this dedicated carrier releases subscriptions, not the task.
    if ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
      $closeCts=[Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(2))
      try { $socket.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure,'snapshot read',$closeCts.Token).GetAwaiter().GetResult() | Out-Null }
      catch { <# Best-effort close only; Dispose below releases the socket. #> } finally { $closeCts.Dispose() }
    }
    $socket.Dispose(); $cts.Dispose(); $message.Dispose()
  }
}
function New-DshPromptRequest([string]$SessionId,[string]$Text,[string]$RequestId,[string]$TimeZone) {
  if ([string]::IsNullOrWhiteSpace($SessionId) -or [string]::IsNullOrWhiteSpace($RequestId) -or [string]::IsNullOrWhiteSpace($Text) -or [Text.Encoding]::UTF8.GetByteCount($Text) -gt 1048576) { throw 'DSH_PROMPT_INVALID: nonempty bounded text and identities required.' }
  if ($TimeZone -notmatch '^([A-Za-z_+-]+/[A-Za-z0-9_+./-]+|UTC)$') { throw 'DSH_TIMEZONE_INVALID: use an IANA zone such as Asia/Shanghai.' }
  $null=[TimeZoneInfo]::FindSystemTimeZoneById($TimeZone)
  return @{sessionId=$SessionId;requestId=$RequestId;mode='queue';clientTimeZone=$TimeZone;content=@(@{type='text';text=$Text})}
}
