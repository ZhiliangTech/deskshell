param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ImportClipboard', 'Status', 'Read')]
  [string]$Operation
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskSecretText = $null
$taskSecretBytes = $null
$taskVerifiedBytes = $null
$taskTempFile = $null
$taskStage = 'initialization'

function Assert-Key([string]$Value) {
  if ($Value -notmatch '^sk-[A-Za-z0-9_-]{16,256}$') {
    throw 'INVALID_CREDENTIAL_FORMAT'
  }
}

function Set-PrivateAcl([string]$Target, [bool]$Directory) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($Directory) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  if ($Directory) { [IO.Directory]::SetAccessControl($Target, $acl) }
  else { [IO.File]::SetAccessControl($Target, $acl) }
}

try {
  Add-Type -AssemblyName System.Security
  $taskSecretDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'deskshell\secrets'
  $taskSecretFile = Join-Path $taskSecretDir 'deepseek.v1.dpapi'
  $taskEntropy = [Text.Encoding]::UTF8.GetBytes('deskshell:deepseek:credential:v1')
  $taskEncoding = New-Object System.Text.UTF8Encoding($false)

  # A link in this app-owned path is not a credential destination.
  foreach ($checkPath in @((Split-Path $taskSecretDir -Parent), $taskSecretDir, $taskSecretFile)) {
    if ((Test-Path -LiteralPath $checkPath) -and ((Get-Item -LiteralPath $checkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'INVALID_CREDENTIAL_PATH'
    }
  }

  if ($Operation -eq 'Status') {
    @{ configured = [bool](Test-Path -LiteralPath $taskSecretFile -PathType Leaf); protection = 'Windows DPAPI CurrentUser'; path = $taskSecretFile } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Operation -eq 'ImportClipboard') {
    $taskStage = 'clipboard-read'
    $taskSecretText = [string](Get-Clipboard -Raw)
    $taskSecretText = $taskSecretText.Trim()
    $taskStage = 'clipboard-format'
    Assert-Key $taskSecretText
    $taskStage = 'directory-acl'
    [IO.Directory]::CreateDirectory($taskSecretDir) | Out-Null
    Set-PrivateAcl $taskSecretDir $true
    $taskStage = 'encrypt'
    $taskSecretBytes = [Text.Encoding]::UTF8.GetBytes($taskSecretText)
    $cipher = [Security.Cryptography.ProtectedData]::Protect($taskSecretBytes, $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $payload = @{ version = 1; provider = 'deepseek'; cipher = [Convert]::ToBase64String($cipher) } | ConvertTo-Json -Compress
    $taskTempFile = Join-Path $taskSecretDir ('credential-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($taskTempFile, $payload, $taskEncoding)
    $taskStage = 'file-acl'
    Set-PrivateAcl $taskTempFile $false
    $taskStage = 'verify'
    # Verify the encrypted artifact in memory before replacing the existing credential.
    $verified = [IO.File]::ReadAllText($taskTempFile, $taskEncoding) | ConvertFrom-Json
    $taskVerifiedBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($verified.cipher), $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ([Text.Encoding]::UTF8.GetString($taskVerifiedBytes) -cne $taskSecretText) { throw 'CREDENTIAL_VERIFICATION_FAILED' }
    $taskStage = 'persist'
    if (Test-Path -LiteralPath $taskSecretFile) {
      [IO.File]::Replace($taskTempFile, $taskSecretFile, [NullString]::Value, $true)
    } else {
      [IO.File]::Move($taskTempFile, $taskSecretFile)
    }
    $taskTempFile = $null
    Set-PrivateAcl $taskSecretFile $false
    $clipboardCleared = $false
    # Preserve anything the user has copied since the import began.
    try {
      if (([string](Get-Clipboard -Raw)).Trim() -ceq $taskSecretText) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.Clipboard]::Clear()
        $clipboardCleared = $true
      }
    } catch { $clipboardCleared = $false }
    @{ configured = $true; protection = 'Windows DPAPI CurrentUser'; clipboardCleared = $clipboardCleared; path = $taskSecretFile } | ConvertTo-Json -Compress
    exit 0
  }

  # Read is private IPC to the local Node adapter. Never invoke this operation for display.
  if (-not (Test-Path -LiteralPath $taskSecretFile -PathType Leaf)) { throw 'CREDENTIAL_NOT_CONFIGURED' }
  $payload = [IO.File]::ReadAllText($taskSecretFile, $taskEncoding) | ConvertFrom-Json
  if ($payload.version -ne 1 -or $payload.provider -ne 'deepseek') { throw 'INVALID_CREDENTIAL_STORE' }
  $taskSecretBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($payload.cipher), $taskEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $taskSecretText = [Text.Encoding]::UTF8.GetString($taskSecretBytes)
  Assert-Key $taskSecretText
  [Console]::Out.Write($taskSecretText)
  exit 0
} catch {
  # Never serialize the exception, clipboard, plaintext, ciphertext, or subprocess context.
  [Console]::Error.WriteLine('CREDENTIAL_OPERATION_FAILED:' + $taskStage + ':' + $_.Exception.GetType().Name + ':' + $_.Exception.HResult)
  exit 1
} finally {
  if ($null -ne $taskSecretBytes) { [Array]::Clear($taskSecretBytes, 0, $taskSecretBytes.Length) }
  if ($null -ne $taskVerifiedBytes) { [Array]::Clear($taskVerifiedBytes, 0, $taskVerifiedBytes.Length) }
  $taskSecretText = $null
  if ($null -ne $taskTempFile -and (Test-Path -LiteralPath $taskTempFile)) {
    Remove-Item -LiteralPath $taskTempFile -Force
  }
}
