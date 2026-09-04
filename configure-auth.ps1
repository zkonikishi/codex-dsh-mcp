#Requires -Version 7.2
# Interactive local credential import. Never pass a real credential as a CLI argument.
$ErrorActionPreference='Stop'
$root='D:\Servers\AI\Data\Codex\integrations\codex-dsh-mcp'
$secret=Read-Host 'Paste an authorized DSH launch URL or token (input hidden)' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if($value.StartsWith('http')) {
    $uri=[Uri]$value
    if($uri.GetLeftPart([UriPartial]::Authority) -cne 'http://127.0.0.1:3080' -or $uri.AbsolutePath -ne '/' -or $uri.Fragment -or $uri.UserInfo){throw 'Invalid loopback launch URL'}
    if($uri.Query -notmatch '^\?token=([A-Za-z0-9_-]{32,256})$'){throw 'Invalid token query'}
    $value=$Matches[1]
  }
  if($value -notmatch '^[A-Za-z0-9_-]{32,256}$'){throw 'Invalid launch token'}
  $dir=Join-Path $root 'auth'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $dir -AclObject $acl
  $file=Join-Path $dir 'connection.json'
  @{baseUrl='http://127.0.0.1:3080';launchToken=$value}|ConvertTo-Json|Set-Content -LiteralPath $file -Encoding utf8NoBOM
  $configPath=Join-Path $root 'config.json'
  $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json -AsHashtable
  $config.authFile=$file
  $config|ConvertTo-Json|Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
  Write-Host 'Credential stored with current-user ACL. Checking authenticated access...'
  & (Join-Path $PSScriptRoot 'bridge\dsh-bridge.ps1') status -AuthFile $file
  if($LASTEXITCODE){throw 'Authentication was not accepted. No task submitted.'}
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $value=$null
  $secret.Dispose()
}
