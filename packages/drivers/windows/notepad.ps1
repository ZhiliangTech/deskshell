# Candidate 11.2607.14.0/zh-CN driver. No production profile is enabled by default.
# Only targeted UIA/Win32 input is used; there is no global keyboard input.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$maxTextBytes = 262144
$deadline = [DateTime]::UtcNow.AddSeconds(27)
function Fail([string]$Code, [string]$Reason = 'UNSPECIFIED') { throw [InvalidOperationException]::new($Code + '|' + $Reason) }
function Check-Deadline { if ([DateTime]::UtcNow -ge $deadline) { Fail 'NOTEPAD_TIMEOUT' 'OPERATION_DEADLINE' } }
function Eq([string]$A, [string]$B) { return [string]::Equals($A, $B, [StringComparison]::Ordinal) }
function Same-Path([string]$A, [string]$B) { return [IO.Path]::IsPathRooted($A) -and [IO.Path]::IsPathRooted($B) -and [string]::Equals([IO.Path]::GetFullPath($A), [IO.Path]::GetFullPath($B), [StringComparison]::OrdinalIgnoreCase) }
function Hash-Bytes([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Assert-FilePath([string]$File, [bool]$MustExist) {
  if (-not [IO.Path]::IsPathRooted($File) -or $File -match '[\x00\r\n"]' -or $File -match '^\\\\' -or [IO.Path]::GetExtension($File) -ine '.txt') { Fail 'INVALID_NOTEPAD_PATH' }
  $absolute = [IO.Path]::GetFullPath($File)
  if ($absolute.Length -gt 8192 -or $absolute.Substring(3).Contains(':')) { Fail 'INVALID_NOTEPAD_PATH' }
  for ($current = [IO.Path]::GetDirectoryName($absolute); $current; $current = [IO.Path]::GetDirectoryName($current)) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 'INVALID_NOTEPAD_PATH' }
  }
  $item = Get-Item -LiteralPath $absolute -Force -ErrorAction SilentlyContinue
  if ($MustExist) {
    if ($null -eq $item -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $maxTextBytes) { Fail 'INVALID_NOTEPAD_PATH' }
  } elseif ($null -ne $item) { Fail 'COPY_ALREADY_EXISTS' }
  return $absolute
}
function Newline-Of([string]$Text) {
  $rest = $Text.Replace("`r`n", '')
  if ($rest.Contains("`r") -or ($Text.Contains("`r`n") -and $rest.Contains("`n"))) { Fail 'CAPABILITY_UNAVAILABLE' 'MIXED_NEWLINE_UNSUPPORTED' }
  if ($Text.Contains("`r`n")) { return 'crlf' }; if ($Text.Contains("`n")) { return 'lf' }; return 'none'
}
function Canonical-Text([string]$Raw, [string]$Newline) {
  if ($Raw.Contains("`n")) { Fail 'CAPABILITY_UNAVAILABLE' 'RICHEDIT_RAW_NEWLINE_MISMATCH' }
  if ($Newline -eq 'crlf') { return $Raw.Replace("`r", "`r`n") }; if ($Newline -eq 'lf') { return $Raw.Replace("`r", "`n") }
  if ($Newline -ne 'none' -or $Raw.Contains("`r")) { Fail 'CAPABILITY_UNAVAILABLE' 'RICHEDIT_RAW_NEWLINE_MISMATCH' }; return $Raw
}
function Raw-Text([string]$Text) { [void](Newline-Of $Text); return $Text.Replace("`r`n", "`r").Replace("`n", "`r") }
function Source-Text([string]$Source, [string]$ExpectedHash) {
  [void](Assert-FilePath $Source $true); $bytes = [IO.File]::ReadAllBytes($Source)
  if ($bytes.Length -gt $maxTextBytes -or $ExpectedHash -notmatch '^[a-f0-9]{64}$' -or -not (Eq (Hash-Bytes $bytes) $ExpectedHash)) { Fail 'SOURCE_CHANGED' }
  if (($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) -or ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254)) { Fail 'CAPABILITY_UNAVAILABLE' 'SOURCE_ENCODING_PROFILE_UNVERIFIED' }
  $encoding = New-Object Text.UTF8Encoding($false, $true); $text = $encoding.GetString($bytes)
  if ($text.Contains([string][char]0)) { Fail 'INVALID_NOTEPAD_INPUT' }; [void](Newline-Of $text); return $text
}
function Runtime-Id($Element) { return @($Element.GetRuntimeId()) }
function Same-Id($A, $B) { return Eq (($A | ForEach-Object { [string]$_ }) -join '.') (($B | ForEach-Object { [string]$_ }) -join '.') }
function Pattern($Element, $PatternId, [string]$Reason) {
  $value = $null; if (-not $Element.TryGetCurrentPattern($PatternId, [ref]$value)) { Fail 'CAPABILITY_UNAVAILABLE' $Reason }; return $value
}
function Find-Type($Parent, $Type) {
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)
  return $Parent.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Assert-Guard {
  Check-Deadline; $proof = $script:request.guard
  if ($null -eq $proof -or $proof.version -ne 1 -or $proof.pipe -notmatch '^[A-Za-z0-9._-]{1,200}$' -or
      [string]::IsNullOrEmpty($proof.nonce) -or [string]::IsNullOrEmpty($proof.leaseId) -or [DeskshellNotepadNative]::InputTick() -ne [uint32]$proof.inputTick) { Fail 'GUARD_INPUT_ACTIVITY_DETECTED' 'CONTINUITY_NOT_PROVEN' }
  $check = @{ version = 1; nonce = $proof.nonce; leaseId = $proof.leaseId; command = 'check' } | ConvertTo-Json -Compress
  $reply = [DeskshellNotepadNative]::GuardCheck([string]$proof.pipe, $check) | ConvertFrom-Json
  if ($reply.ok -ne $true) {
    $code = if ($reply.code -is [string] -and $reply.code -match '^GUARD_[A-Z0-9_]{1,64}$') { $reply.code } else { 'GUARD_UNAVAILABLE' }; Fail $code 'CONTINUITY_NOT_PROVEN'
  }
  if ([DeskshellNotepadNative]::InputTick() -ne [uint32]$proof.inputTick) { Fail 'GUARD_INPUT_ACTIVITY_DETECTED' 'CONTINUITY_NOT_PROVEN' }; Check-Deadline
}
function Main-Window($Session) {
  $process = [Diagnostics.Process]::GetProcessById([int]$Session.pid)
  if ($process.ProcessName -ine 'Notepad' -or $process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or -not (Eq $process.StartTime.ToUniversalTime().Ticks.ToString() $Session.startedTicks)) { Fail 'NOTEPAD_BINDING_CHANGED' 'PROCESS_IDENTITY_CHANGED' }
  $handle = [IntPtr]([long]$Session.hwnd)
  if (-not [DeskshellNotepadNative]::IsWindow($handle) -or [DeskshellNotepadNative]::Pid($handle) -ne $Session.pid -or [DeskshellNotepadNative]::GetWindow($handle, 4) -ne [IntPtr]::Zero) { Fail 'NOTEPAD_BINDING_CHANGED' 'WINDOW_IDENTITY_CHANGED' }
  return [Windows.Automation.AutomationElement]::FromHandle($handle)
}
function Owned-Windows($Window, $Session) {
  $main = [IntPtr]([long]$Session.hwnd)
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window)
  $candidates = @([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)) + @($Window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition))
  if ($candidates.Count -gt 256) { Fail 'CAPABILITY_UNAVAILABLE' 'WINDOW_LIMIT' }; $found = @{}
  foreach ($candidate in $candidates) {
    $hwnd = [IntPtr]$candidate.Current.NativeWindowHandle
    if ($hwnd -eq [IntPtr]::Zero -or $hwnd -eq $main -or $candidate.Current.ProcessId -ne $Session.pid -or -not [DeskshellNotepadNative]::IsWindowVisible($hwnd)) { continue }
    $owner = [DeskshellNotepadNative]::GetWindow($hwnd, 4)
    for ($depth = 0; $owner -ne [IntPtr]::Zero -and $depth -lt 12; $depth++) {
      if ($owner -eq $main) { $found[$hwnd.ToInt64().ToString()] = $candidate; break }; $owner = [DeskshellNotepadNative]::GetWindow($owner, 4)
    }
  }
  return ,@($found.Values)
}
function Read-Document($Session, [bool]$AllowOwnedDialog = $false) {
  Assert-Guard; [void](Source-Text ([string]$Session.sourcePath) ([string]$Session.sourceHash))
  $window = Main-Window $Session; $main = [IntPtr]([long]$Session.hwnd)
  if (-not $AllowOwnedDialog -and (Owned-Windows $window $Session).Count -ne 0) { Fail 'NOTEPAD_BINDING_CHANGED' 'UNEXPECTED_DIALOG' }
  $tabs = @(Find-Type $window ([Windows.Automation.ControlType]::TabItem))
  $selected = @($tabs | Where-Object { $pattern = Pattern $_ ([Windows.Automation.SelectionItemPattern]::Pattern) 'TAB_SELECTION_UNAVAILABLE'; $pattern.Current.IsSelected -and -not $_.Current.IsOffscreen })
  if ($selected.Count -ne 1) { Fail 'CAPABILITY_UNAVAILABLE' 'UNIQUE_SELECTED_TAB_REQUIRED' }
  $documents = @(Find-Type $window ([Windows.Automation.ControlType]::Document) | Where-Object { -not $_.Current.IsOffscreen })
  if ($documents.Count -ne 1) { Fail 'CAPABILITY_UNAVAILABLE' 'UNIQUE_DOCUMENT_REQUIRED' }; $document = $documents[0]; $tab = $selected[0]
  if (-not $AllowOwnedDialog -and -not $document.Current.IsEnabled) { Fail 'CAPABILITY_UNAVAILABLE' 'DOCUMENT_NOT_AVAILABLE' }
  $documentId = Runtime-Id $document; $tabId = Runtime-Id $tab
  if (-not $documentId.Count -or -not $tabId.Count) { Fail 'CAPABILITY_UNAVAILABLE' 'RUNTIME_ID_UNAVAILABLE' }
  if ($Session.documentRuntimeId -and (-not (Same-Id $documentId $Session.documentRuntimeId) -or -not (Same-Id $tabId $Session.tabRuntimeId))) { Fail 'NOTEPAD_BINDING_CHANGED' 'DOCUMENT_IDENTITY_CHANGED' }
  $textPattern = Pattern $document ([Windows.Automation.TextPattern]::Pattern) 'TEXT_PATTERN_UNAVAILABLE'
  $valuePattern = Pattern $document ([Windows.Automation.ValuePattern]::Pattern) 'VALUE_PATTERN_UNAVAILABLE'
  if ($valuePattern.Current.IsReadOnly) { Fail 'CAPABILITY_UNAVAILABLE' 'DOCUMENT_READ_ONLY' }; $range = $textPattern.DocumentRange
  if ($range.GetChildren().Length -ne 0) { Fail 'CAPABILITY_UNAVAILABLE' 'EMBEDDED_OBJECTS_UNSUPPORTED' }; $raw = $range.GetText($maxTextBytes + 1)
  if ($raw.Length -gt $maxTextBytes -or [Text.Encoding]::UTF8.GetByteCount($raw) -gt $maxTextBytes -or $raw.Contains([string][char]0)) { Fail 'NOTEPAD_BUFFER_LIMIT' }
  if (-not (Eq $raw $valuePattern.Current.Value)) { Fail 'CAPABILITY_UNAVAILABLE' 'FULL_BUFFER_NOT_PROVEN' }
  $editor = [IntPtr]$document.Current.NativeWindowHandle
  if ($editor -eq [IntPtr]::Zero -or [DeskshellNotepadNative]::GetAncestor($editor, 2) -ne $main -or [DeskshellNotepadNative]::Pid($editor) -ne $Session.pid -or [DeskshellNotepadNative]::ClassOf($editor) -cne 'RichEditD2DPT') { Fail 'CAPABILITY_UNAVAILABLE' 'EDITOR_HWND_NOT_PROVEN' }
  $text = Canonical-Text $raw ([string]$Session.documentNewline)
  $observation = @{
    appId = $script:request.appId; driverSessionId = $script:request.driverSessionId
    windowId = ([string]$Session.pid + ':' + $Session.startedTicks + ':' + $Session.hwnd)
    documentId = ('document:' + ($documentId -join '.') + ':tab:' + ($tabId -join '.'))
    documentPath = [string]$Session.documentPath; windowTitle = [string]$window.Current.Name; text = $text
    modified = ([DeskshellNotepadNative]::Message($editor, 0x00B8, [IntPtr]::Zero, [IntPtr]::Zero) -ne 0)
    focused = ([DeskshellNotepadNative]::GetForegroundWindow() -eq $main -and $document.Current.HasKeyboardFocus)
    evidence = @{ window = 'native-window'; document = 'single-tab-marker'; path = $Session.pathEvidence; buffer = 'accessibility-text'; bufferComplete = $true; inputMode = 'targeted' }
  }
  if ($observation.windowTitle.Length -gt 8192) { Fail 'NOTEPAD_BUFFER_LIMIT' }
  if ($script:request.binding) { foreach ($field in @('appId','driverSessionId','windowId','documentId')) { if (-not (Eq ([string]$script:request.binding.$field) ([string]$observation.$field))) { Fail 'NOTEPAD_BINDING_CHANGED' 'BINDING_MISMATCH' } } }
  return @{ observation = $observation; document = $document; textPattern = $textPattern; raw = $raw; editor = $editor; documentId = $documentId; tabId = $tabId; tabCount = $tabs.Count }
}
function Compare-Expected($Current, $Expected) {
  foreach ($field in @('appId','driverSessionId','windowId','documentId','documentPath','windowTitle','text')) { if (-not (Eq ([string]$Current.$field) ([string]$Expected.$field))) { Fail 'NOTEPAD_BUFFER_CHANGED' 'EXPECTED_OBSERVATION_CHANGED' } }
  if ($Expected.evidence.inputMode -cne 'targeted' -or $Current.modified -ne $Expected.modified) { Fail 'NOTEPAD_BUFFER_CHANGED' 'INPUT_MODE_OR_DIRTY_STATE_CHANGED' }
}
function Assert-Dialog($Dialog, $Session) {
  $window = Main-Window $Session; $owned = Owned-Windows $window $Session; $hwnd = [IntPtr]$Dialog.Current.NativeWindowHandle
  if ($owned.Count -ne 1 -or $owned[0].Current.NativeWindowHandle -ne $Dialog.Current.NativeWindowHandle -or
      [DeskshellNotepadNative]::ClassOf($hwnd) -cne '#32770' -or [DeskshellNotepadNative]::GetWindow($hwnd, 4) -ne [IntPtr]([long]$Session.hwnd) -or
      [DeskshellNotepadNative]::Pid($hwnd) -ne $Session.pid -or -not [DeskshellNotepadNative]::IsWindowEnabled($hwnd)) { Fail 'NOTEPAD_BINDING_CHANGED' 'OWNED_DIALOG_NOT_PROVEN' }; Assert-Guard
}
function Find-NativeControl($Dialog, $Session, [string]$Class, [int]$ControlId) {
  Assert-Dialog $Dialog $Session; $dialogHandle = [IntPtr]$Dialog.Current.NativeWindowHandle
  $found = @([DeskshellNotepadNative]::Children($dialogHandle) | Where-Object { [DeskshellNotepadNative]::ClassOf($_) -ceq $Class -and [DeskshellNotepadNative]::GetDlgCtrlID($_) -eq $ControlId -and [DeskshellNotepadNative]::IsWindowVisible($_) })
  if ($found.Count -ne 1 -or [DeskshellNotepadNative]::Pid($found[0]) -ne $Session.pid -or -not [DeskshellNotepadNative]::IsChild($dialogHandle, $found[0]) -or -not [DeskshellNotepadNative]::IsWindowEnabled($found[0])) { Fail 'CAPABILITY_UNAVAILABLE' 'DIALOG_CONTROL_NOT_PROVEN' }; return [IntPtr]$found[0]
}
function Menu-Dialog($Session, $Expected, [string]$Name) {
  $window = Main-Window $Session; $before = Read-Document $Session; Compare-Expected $before.observation $Expected
  $file = @(Find-Type $window ([Windows.Automation.ControlType]::MenuItem) | Where-Object { $_.Current.AutomationId -ceq 'File' -and $_.Current.ClassName -ceq 'Microsoft.UI.Xaml.Controls.MenuBarItem' -and -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
  if ($file.Count -ne 1) { Fail 'CAPABILITY_UNAVAILABLE' 'FILE_MENU_NOT_PROVEN' }; $invoke = Pattern $file[0] ([Windows.Automation.InvokePattern]::Pattern) 'FILE_MENU_INVOKE_UNAVAILABLE'
  Assert-Guard; $invoke.Invoke(); Assert-Guard; $item = $null
  while ($null -eq $item) {
    Assert-Guard
    $found = @(Find-Type $window ([Windows.Automation.ControlType]::MenuItem) | Where-Object { $_.Current.ClassName -ceq 'MenuFlyoutItem' -and $_.Current.Name -ceq $Name -and -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
    if ($found.Count -gt 1) { Fail 'CAPABILITY_UNAVAILABLE' 'MENU_ITEM_AMBIGUOUS' }; if ($found.Count -eq 1) { $item = $found[0]; break }; Start-Sleep -Milliseconds 40
  }
  $before = Read-Document $Session $true; Compare-Expected $before.observation $Expected; $invoke = Pattern $item ([Windows.Automation.InvokePattern]::Pattern) 'MENU_INVOKE_UNAVAILABLE'
  Assert-Guard; $invoke.Invoke(); Assert-Guard
  while ($true) { Assert-Guard; $owned = Owned-Windows $window $Session; if ($owned.Count -gt 1) { Fail 'NOTEPAD_BINDING_CHANGED' 'UNEXPECTED_DIALOG' }; if ($owned.Count -eq 1) { Assert-Dialog $owned[0] $Session; return $owned[0] }; Start-Sleep -Milliseconds 40 }
}
function Replace-Filename($Dialog, $Session, $Expected, [int]$ControlId, [string]$Path) {
  $filename = Find-NativeControl $Dialog $Session 'Edit' $ControlId; $before = Read-Document $Session $true; Compare-Expected $before.observation $Expected
  Assert-Guard; [void][DeskshellNotepadNative]::Message($filename, 0x00B1, [IntPtr]::Zero, [IntPtr](-1)); Assert-Guard
  $length = [DeskshellNotepadNative]::Message($filename, 0x000E, [IntPtr]::Zero, [IntPtr]::Zero); $selection = [DeskshellNotepadNative]::Message($filename, 0x00B0, [IntPtr]::Zero, [IntPtr]::Zero)
  if ($length -gt 8192 -or ($selection -band 65535) -ne 0 -or (($selection -shr 16) -band 65535) -ne $length) { Fail 'NOTEPAD_BINDING_CHANGED' 'FILENAME_SELECTION_NOT_PROVEN' }
  $before = Read-Document $Session $true; Compare-Expected $before.observation $Expected; Assert-Dialog $Dialog $Session
  Assert-Guard; [void][DeskshellNotepadNative]::TextMessage($filename, 0x00C2, [IntPtr]1, $Path); Assert-Guard
  if (-not (Eq ([DeskshellNotepadNative]::WindowText($filename)) $Path)) { Fail 'NOTEPAD_BINDING_CHANGED' 'FILENAME_NOT_VERIFIED' }; return $filename
}
function Click-Action($Dialog, $Session, $Expected, [IntPtr]$Filename, [string]$Path, [bool]$NewCopy) {
  Assert-Dialog $Dialog $Session; $button = Find-NativeControl $Dialog $Session 'Button' 1; $before = Read-Document $Session $true; Compare-Expected $before.observation $Expected
  if (-not (Eq ([DeskshellNotepadNative]::WindowText($Filename)) $Path)) { Fail 'NOTEPAD_BINDING_CHANGED' 'FILENAME_CHANGED' }; [void](Assert-FilePath $Path (-not $NewCopy))
  $dialogHandle = $Dialog.Current.NativeWindowHandle
  Assert-Guard; [void][DeskshellNotepadNative]::Message($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); Assert-Guard
  $window = Main-Window $Session
  while ($true) {
    Assert-Guard; $owned = Owned-Windows $window $Session
    if ($owned.Count -gt 1 -or ($owned.Count -eq 1 -and $owned[0].Current.NativeWindowHandle -ne $dialogHandle)) { Fail 'NOTEPAD_SAVE_NOT_VERIFIED' 'OVERWRITE_OR_UNEXPECTED_DIALOG_REFUSED' }
    if ($owned.Count -eq 0) { return }; Start-Sleep -Milliseconds 40
  }
}
function Assert-Encoding($Dialog, $Session) {
  Assert-Dialog $Dialog $Session; $dialogHandle = [IntPtr]$Dialog.Current.NativeWindowHandle
  $candidates = @([DeskshellNotepadNative]::Children($dialogHandle) | Where-Object {
    [DeskshellNotepadNative]::ClassOf($_) -ceq 'ComboBox' -and [DeskshellNotepadNative]::GetDlgCtrlID($_) -eq 0 -and
    [DeskshellNotepadNative]::IsWindowVisible($_) -and [DeskshellNotepadNative]::IsWindowEnabled($_) -and
    [DeskshellNotepadNative]::Pid($_) -eq $Session.pid -and [DeskshellNotepadNative]::IsChild($dialogHandle, $_)
  })
  if ($candidates.Count -gt 16) { Fail 'CAPABILITY_UNAVAILABLE' 'ENCODING_CANDIDATE_LIMIT' }
  $choices = @('ANSI','UTF-16 LE','UTF-16 BE','UTF-8','UTF-8 BOM','GB18030'); $matching = New-Object 'Collections.Generic.List[IntPtr]'
  foreach ($candidate in $candidates) {
    $count = [DeskshellNotepadNative]::Message($candidate, 0x0146, [IntPtr]::Zero, [IntPtr]::Zero)
    if ($count -gt [int]::MaxValue) { Fail 'NOTEPAD_ENCODING_READ_FAILED' 'ENCODING_COUNT_INVALID' }
    # Other id=0 combos may contain directory/history choices. Do not read their
    # text unless their bounded item count matches the exact encoding profile.
    if ($count -ne $choices.Count) { continue }; $matchesProfile = $true
    for ($i = 0; $i -lt $choices.Count; $i++) {
      if (-not (Eq ([DeskshellNotepadNative]::ComboText($candidate, $i)) $choices[$i])) { $matchesProfile = $false; break }
    }
    if ($matchesProfile) { $matching.Add($candidate) }
  }
  if ($matching.Count -ne 1) { Fail 'CAPABILITY_UNAVAILABLE' 'ENCODING_PROFILE_AMBIGUOUS' }
  Assert-Dialog $Dialog $Session
  if ([DeskshellNotepadNative]::Message($matching[0], 0x0147, [IntPtr]::Zero, [IntPtr]::Zero) -ne 3) { Fail 'CAPABILITY_UNAVAILABLE' 'ENCODING_CHANGE_NOT_VERIFIED' }
}
try {
  $builder = New-Object Text.StringBuilder; $inputBuffer = New-Object char[] 8192
  while (($read = [Console]::In.Read($inputBuffer, 0, $inputBuffer.Length)) -gt 0) { [void]$builder.Append($inputBuffer, 0, $read); if ($builder.Length -gt 4194304) { Fail 'NOTEPAD_REQUEST_LIMIT' } }
  $json = $builder.ToString(); if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 4194304) { Fail 'NOTEPAD_REQUEST_LIMIT' }; $script:request = $json | ConvertFrom-Json
  if ($request.version -ne 1 -or $request.appId -cne 'windows.notepad' -or $request.driverSessionId -notmatch '^notepad-[a-f0-9-]{36}$' -or $request.operation -notin @('probe','open','observe','edit','save-copy')) { Fail 'INVALID_NOTEPAD_REQUEST' }
  $notepadProfile = $request.profile
  if ($notepadProfile.schemaVersion -ne 2 -or $notepadProfile.packageVersion -cne '11.2607.14.0' -or $notepadProfile.locale -cne 'zh-CN') { Fail 'CAPABILITY_UNAVAILABLE' 'PROFILE_UNVERIFIED' }
  $packages = @(Get-AppxPackage -Name Microsoft.WindowsNotepad | Where-Object { $_.PublisherId -eq '8wekyb3d8bbwe' })
  if ($packages.Count -ne 1 -or [string]$packages[0].Version -cne [string]$notepadProfile.packageVersion) { Fail 'CAPABILITY_UNAVAILABLE' 'NOTEPAD_VERSION_PROFILE_MISMATCH' }
  if ($request.operation -eq 'probe') { $probeReasons = if ($notepadProfile.verified) { @() } else { @('CANDIDATE_PROFILE_REQUIRES_EXPLICIT_VALIDATION') }; @{ ok = $true; probe = @{ available = [bool]$notepadProfile.verified; reasons = @($probeReasons); installedVersion = [string]$packages[0].Version } } | ConvertTo-Json -Compress; exit 0 }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.IO.Pipes;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DeskshellNotepadNative {
  delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint size; public uint tick; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr Send(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendText(IntPtr hwnd, uint message, IntPtr wparam, string text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr ReceiveText(IntPtr hwnd, uint message, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  static InvalidOperationException Failure(string code) { return new InvalidOperationException(code+"|NATIVE_CHECK_FAILED"); }
  static string MessageFailure(uint message) { switch(message) { case 0x00B8:return "NOTEPAD_DIRTY_READ_FAILED"; case 0x00B1:return "NOTEPAD_SELECT_FAILED"; case 0x00B0:return "NOTEPAD_SELECTION_READ_FAILED"; case 0x00F5:return "NOTEPAD_BUTTON_MESSAGE_FAILED"; case 0x000E:return "NOTEPAD_TEXT_LENGTH_FAILED"; case 0x0146:case 0x0147:case 0x0149:return "NOTEPAD_ENCODING_READ_FAILED"; default:return "NOTEPAD_NATIVE_MESSAGE_FAILED"; } }
  public static uint Pid(IntPtr hwnd) { uint pid; if(GetWindowThreadProcessId(hwnd,out pid)==0) throw Failure("NOTEPAD_PID_UNAVAILABLE"); return pid; }
  public static uint InputTick() { var info=new LASTINPUTINFO(); info.size=(uint)Marshal.SizeOf(info); if(!GetLastInputInfo(ref info)) throw Failure("NOTEPAD_INPUT_CLOCK_UNAVAILABLE"); return info.tick; }
  public static string ClassOf(IntPtr hwnd) { var value=new StringBuilder(256); if(GetClassName(hwnd,value,value.Capacity)==0) throw Failure("NOTEPAD_WINDOW_CLASS_UNAVAILABLE"); return value.ToString(); }
  public static IntPtr[] TopWindows() {
    var values=new List<IntPtr>();
    bool completed=EnumWindows((hwnd,p)=>{
      if(!IsWindowVisible(hwnd) || GetWindow(hwnd,4)!=IntPtr.Zero) return true;
      var name=new StringBuilder(256); if(GetClassName(hwnd,name,name.Capacity)==0 || !String.Equals(name.ToString(),"Notepad",StringComparison.OrdinalIgnoreCase)) return true;
      values.Add(hwnd); return values.Count<=64;
    },IntPtr.Zero);
    if(values.Count>64) throw Failure("NOTEPAD_WINDOW_ENUM_LIMIT"); if(!completed) throw Failure("NOTEPAD_WINDOW_ENUM_FAILED"); return values.ToArray();
  }
  public static IntPtr[] Children(IntPtr parent) { var values=new List<IntPtr>(); EnumChildWindows(parent,(hwnd,p)=>{values.Add(hwnd); return values.Count<=512;},IntPtr.Zero); if(values.Count>512) throw Failure("NOTEPAD_DIALOG_CONTROL_LIMIT"); return values.ToArray(); }
  public static ulong Message(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam) { UIntPtr result; if(Send(hwnd,message,wparam,lparam,0x22,750,out result)==IntPtr.Zero) throw Failure(MessageFailure(message)); return result.ToUInt64(); }
  public static ulong TextMessage(IntPtr hwnd,uint message,IntPtr wparam,string text) { UIntPtr result; if(SendText(hwnd,message,wparam,text,0x22,750,out result)==IntPtr.Zero) throw Failure("NOTEPAD_REPLACE_MESSAGE_FAILED"); return result.ToUInt64(); }
  public static string WindowText(IntPtr hwnd) { ulong count=Message(hwnd,0x000E,IntPtr.Zero,IntPtr.Zero); if(count>8192) throw Failure("NOTEPAD_FILENAME_LIMIT"); var text=new StringBuilder((int)count+1); UIntPtr result; if(ReceiveText(hwnd,0x000D,(IntPtr)text.Capacity,text,0x22,750,out result)==IntPtr.Zero || result.ToUInt64()!=count) throw Failure("NOTEPAD_FILENAME_READ_FAILED"); return text.ToString(); }
  public static string ComboText(IntPtr hwnd,int index) { ulong count=Message(hwnd,0x0149,(IntPtr)index,IntPtr.Zero); if(count>160) throw Failure("NOTEPAD_ENCODING_LABEL_LIMIT"); var text=new StringBuilder((int)count+1); UIntPtr result; if(ReceiveText(hwnd,0x0148,(IntPtr)index,text,0x22,750,out result)==IntPtr.Zero || result.ToUInt64()!=count) throw Failure("NOTEPAD_ENCODING_READ_FAILED"); return text.ToString(); }
  public static string GuardCheck(string pipe,string request) {
    using(var client=new NamedPipeClientStream(".",pipe,PipeDirection.InOut,PipeOptions.Asynchronous)) {
      client.Connect(750); byte[] body=Encoding.UTF8.GetBytes(request+"\n"); var write=client.WriteAsync(body,0,body.Length); if(!write.Wait(750)) throw new InvalidOperationException("GUARD_UNAVAILABLE|CHECK_TIMEOUT");
      var bytes=new List<byte>(); var one=new byte[1]; while(bytes.Count<512) { var read=client.ReadAsync(one,0,1); if(!read.Wait(750) || read.Result!=1) throw new InvalidOperationException("GUARD_UNAVAILABLE|CHECK_TIMEOUT"); if(one[0]==10) return new UTF8Encoding(false,true).GetString(bytes.ToArray()); bytes.Add(one[0]); }
      throw new InvalidOperationException("GUARD_UNAVAILABLE|CHECK_LIMIT");
    }
  }
}
'@
  Assert-Guard
  if ($request.operation -eq 'open') {
    $source = Assert-FilePath ([string]$request.sourcePath) $true; $sourceText = Source-Text $source ([string]$request.expectedSourceHash); $sourceNewline = Newline-Of $sourceText
    $sameSession = [Diagnostics.Process]::GetCurrentProcess().SessionId; $baseline = @{}
    foreach ($hwnd in [DeskshellNotepadNative]::TopWindows()) { $baseline[$hwnd.ToInt64().ToString()] = $true }
    # Fixed executable, no user arguments. Shell activation keeps application handles out of private helper IPC.
    $info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = Join-Path ([Environment]::GetFolderPath('System')) 'notepad.exe'; $info.UseShellExecute = $true
    Assert-Guard; [void][Diagnostics.Process]::Start($info); Assert-Guard; $newWindow = $null; $newProcess = $null
    while ($null -eq $newWindow) {
      Assert-Guard; $found = @()
      foreach ($hwnd in [DeskshellNotepadNative]::TopWindows()) {
        if ($baseline.ContainsKey($hwnd.ToInt64().ToString()) -or -not [DeskshellNotepadNative]::IsWindowVisible($hwnd) -or [DeskshellNotepadNative]::GetWindow($hwnd,4) -ne [IntPtr]::Zero) { continue }
        $candidate = [Diagnostics.Process]::GetProcessById([DeskshellNotepadNative]::Pid($hwnd))
        if ($candidate.ProcessName -ieq 'Notepad' -and $candidate.SessionId -eq $sameSession) { $found += @{ hwnd = $hwnd; process = $candidate } }
      }
      if ($found.Count -gt 1) { Fail 'CAPABILITY_UNAVAILABLE' 'NEW_WINDOW_AMBIGUOUS' }; if ($found.Count -eq 1) { $newWindow = $found[0].hwnd; $newProcess = $found[0].process; break }; Start-Sleep -Milliseconds 50
    }
    $session = @{ pid = $newProcess.Id; startedTicks = $newProcess.StartTime.ToUniversalTime().Ticks.ToString(); hwnd = $newWindow.ToInt64().ToString(); documentRuntimeId = @(); tabRuntimeId = @(); documentPath = $source; pathEvidence = 'explicit-open'; sourcePath = $source; sourceHash = $request.expectedSourceHash; sourceNewline = $sourceNewline; documentNewline = $sourceNewline }
    $blank = Read-Document $session
    if ($blank.raw.Length -ne 0 -or $blank.observation.modified -or $blank.tabCount -ne 1) { Fail 'CAPABILITY_UNAVAILABLE' 'NEW_EMPTY_DOCUMENT_NOT_PROVEN' }
    $session.documentRuntimeId = $blank.documentId; $session.tabRuntimeId = $blank.tabId; $dialog = Menu-Dialog $session $blank.observation ([string]$notepadProfile.menu.openName)
    $filename = Replace-Filename $dialog $session $blank.observation 1148 $source; Click-Action $dialog $session $blank.observation $filename $source $false
    $session.documentRuntimeId = @(); $session.tabRuntimeId = @()
    while ($true) { $readback = Read-Document $session; if (Eq $readback.observation.text $sourceText) { break }; Assert-Guard; Start-Sleep -Milliseconds 40 }
    if ($readback.observation.modified -or (Same-Id $readback.tabId $blank.tabId)) { Fail 'NOTEPAD_OPEN_NOT_VERIFIED' 'NEW_DOCUMENT_NOT_PROVEN' }
    $session.documentRuntimeId = $readback.documentId; $session.tabRuntimeId = $readback.tabId; [void](Source-Text $source ([string]$request.expectedSourceHash)); Assert-Guard
    @{ ok = $true; observation = $readback.observation; session = $session } | ConvertTo-Json -Depth 20 -Compress; exit 0
  }
  $session = $request.session
  if ($null -eq $session -or $session.pathEvidence -notin @('explicit-open','save-copy-dialog')) { Fail 'NOTEPAD_BINDING_CHANGED' 'SESSION_REQUIRED' }
  $readback = Read-Document $session
  if ($request.operation -eq 'observe') { Assert-Guard; @{ ok = $true; observation = $readback.observation } | ConvertTo-Json -Depth 20 -Compress; exit 0 }
  Compare-Expected $readback.observation $request.expected
  if ($request.operation -eq 'edit') {
    $replacement = [string]$request.replacementText; $newline = Newline-Of $replacement
    if ($replacement.Contains([string][char]0) -or [Text.Encoding]::UTF8.GetByteCount($replacement) -gt $maxTextBytes -or ($session.sourceNewline -ne 'none' -and $newline -ne 'none' -and $session.sourceNewline -ne $newline)) { Fail 'INVALID_NOTEPAD_INPUT' }
    $rawReplacement = Raw-Text $replacement; $again = Read-Document $session; Compare-Expected $again.observation $request.expected
    Assert-Guard; [void][DeskshellNotepadNative]::Message($again.editor, 0x00B1, [IntPtr]::Zero, [IntPtr](-1)); Assert-Guard
    $selected = $again.textPattern.GetSelection(); $whole = $again.textPattern.DocumentRange
    if ($selected.Length -ne 1 -or $selected[0].CompareEndpoints([Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $whole, [Windows.Automation.Text.TextPatternRangeEndpoint]::Start) -ne 0 -or $selected[0].CompareEndpoints([Windows.Automation.Text.TextPatternRangeEndpoint]::End, $whole, [Windows.Automation.Text.TextPatternRangeEndpoint]::End) -ne 0) { Fail 'NOTEPAD_BINDING_CHANGED' 'FULL_SELECTION_NOT_PROVEN' }
    $beforeReplace = Read-Document $session; Compare-Expected $beforeReplace.observation $request.expected
    Assert-Guard; [void][DeskshellNotepadNative]::TextMessage($beforeReplace.editor, 0x00C2, [IntPtr]1, $rawReplacement); Assert-Guard; $session.documentNewline = $newline
    $after = Read-Document $session; if (-not (Eq $after.observation.text $replacement) -or -not $after.observation.modified) { Fail 'NOTEPAD_EDIT_NOT_VERIFIED' }
    @{ ok = $true; observation = $after.observation; session = $session } | ConvertTo-Json -Depth 20 -Compress; exit 0
  }
  if ($request.encoding -cne 'utf8') { Fail 'CAPABILITY_UNAVAILABLE' 'ENCODING_PROFILE_UNVERIFIED' }
  $copyPath = Assert-FilePath ([string]$request.copyPath) $false; if (Same-Path $copyPath $session.sourcePath) { Fail 'INVALID_NOTEPAD_PATH' }
  $dialog = Menu-Dialog $session $request.expected ([string]$notepadProfile.menu.saveCopyName); Assert-Encoding $dialog $session
  $filename = Replace-Filename $dialog $session $request.expected 1001 $copyPath; Assert-Encoding $dialog $session; Click-Action $dialog $session $request.expected $filename $copyPath $true
  [void](Assert-FilePath $copyPath $true); $expectedBytes = [Text.Encoding]::UTF8.GetBytes([string]$request.expected.text)
  if (-not (Eq (Hash-Bytes ([IO.File]::ReadAllBytes($copyPath))) (Hash-Bytes $expectedBytes))) { Fail 'NOTEPAD_SAVE_NOT_VERIFIED' 'EXACT_COPY_BYTES_NOT_VERIFIED' }
  $session.documentPath = $copyPath; $session.pathEvidence = 'save-copy-dialog'; $after = Read-Document $session
  if (-not (Eq $after.observation.text $request.expected.text) -or $after.observation.modified) { Fail 'NOTEPAD_SAVE_NOT_VERIFIED' }; Assert-Guard
  @{ ok = $true; observation = $after.observation; session = $session } | ConvertTo-Json -Depth 20 -Compress; exit 0
} catch {
  $code = 'NOTEPAD_OPERATION_FAILED'; $reason = 'NATIVE_OPERATION_REJECTED'
  if ($_.Exception.GetBaseException().Message -match '^([A-Z0-9_]{1,80})\|([A-Z0-9_]{1,80})$') { $code = $Matches[1]; $reason = $Matches[2] }
  @{ ok = $false; code = $code; reason = $reason } | ConvertTo-Json -Compress; exit 1
}
