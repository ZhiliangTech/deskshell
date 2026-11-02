# Installed package/culture metadata only. This script does not load UIAutomation,
# inspect windows, start Notepad, register hooks, read documents or access credentials.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  $versions = @(Get-AppxPackage -Name Microsoft.WindowsNotepad | Where-Object { $_.PublisherId -ceq '8wekyb3d8bbwe' } | ForEach-Object { $_.Version.ToString() })
  @{ version = 1; packageVersions = $versions; uiLocale = [Globalization.CultureInfo]::CurrentUICulture.Name } | ConvertTo-Json -Compress
} catch { exit 1 }
