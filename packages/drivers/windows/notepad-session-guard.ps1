# Product helper. Do not launch this monitor during offline tests.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false, $true)
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'notepad-session-guard.cs') -ReferencedAssemblies @('System.Windows.Forms','System.Web.Extensions','System.Core','System.Security')
  [DeskshellNotepadSessionGuard]::Run()
} catch { exit 1 }
