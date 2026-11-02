param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
try {
  $absolute = [IO.Path]::GetFullPath($Target)
  $current = $absolute
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) { throw 'INVALID_PRIVATE_DIRECTORY' }
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
  [IO.Directory]::CreateDirectory($absolute) | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($absolute, $acl)
  exit 0
} catch {
  [Console]::Error.WriteLine('PRIVATE_DIRECTORY_FAILED')
  exit 1
}
