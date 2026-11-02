# Read-only diagnostic for one explicitly designated synthetic Notepad window.
# This script never launches an application, changes focus, invokes a control, or sends input.
# Example: powershell.exe -NoProfile -NonInteractive -STA -File scripts/notepad-uia-probe.ps1 -WindowHandle 397636 -SourcePath C:\fixture\source.txt -Marker deskshell-notepad-00000000-0000-0000-0000-000000000000
# For an already-open owned dialog, also pass -SaveDialog -DocumentRuntimeId '42.123.456'
# from the successful focused-document probe. Use a caller-side process timeout (for example 20 seconds).
param(
  [Parameter(Mandatory = $true)][string]$WindowHandle,
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$Marker,
  [string]$DocumentRuntimeId,
  [switch]$SaveDialog
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$probeDeadline = [DateTime]::UtcNow.AddSeconds(15)
$probeMaximumTextBytes = 262144
$probeMaximumNodes = 512

function Reject([string]$Code) { throw [InvalidOperationException]::new('PROBE|' + $Code) }
function Check-Deadline { if ([DateTime]::UtcNow -ge $probeDeadline) { Reject 'DEADLINE_EXCEEDED' } }
function Equal-Text([string]$Left, [string]$Right) { return [string]::Equals($Left, $Right, [StringComparison]::Ordinal) }
function Hash-Text([string]$Text) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Id($Element) { return (($Element.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') }
function Try-Pattern($Element, $PatternId) {
  $patternValue = $null
  if ($Element.TryGetCurrentPattern($PatternId, [ref]$patternValue)) { return $patternValue }
  return $null
}
function Same-Path([string]$Value, [string]$Expected) {
  try {
    if (-not [IO.Path]::IsPathRooted($Value)) { return $false }
    return [string]::Equals([IO.Path]::GetFullPath($Value), $Expected, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}
function Property-Summary($Value) {
  if ($Value -isnot [string]) { return @{ available = $false } }
  if ($Value.Length -gt 8192) { return @{ available = $true; exceedsLimit = $true } }
  $same = Same-Path $Value $script:probeSource
  # Arbitrary HelpText/ItemStatus can contain document contents or unrelated paths.
  # Expose an actual property value only when it is the caller's already-known source path.
  return @{ available = $true; length = $Value.Length; sha256 = (Hash-Text $Value); equalsSourcePath = $same; value = $(if ($same) { $script:probeSource } else { $null }) }
}
function Metadata($Element) {
  Check-Deadline
  $current = $Element.Current
  $supported = @($Element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
  $result = @{
    runtimeId = (Id $Element); controlType = $current.ControlType.ProgrammaticName
    className = [string]$current.ClassName; automationId = [string]$current.AutomationId
    nativeWindowHandle = [string]$current.NativeWindowHandle; processId = $current.ProcessId
    enabled = $current.IsEnabled; offscreen = $current.IsOffscreen; keyboardFocus = $current.HasKeyboardFocus
    patterns = $supported
    helpText = (Property-Summary ($Element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::HelpTextProperty, $true)))
    itemStatus = (Property-Summary ($Element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::ItemStatusProperty, $true)))
  }
  if ($result.className.Length -gt 256 -or $result.automationId.Length -gt 256) { Reject 'METADATA_LIMIT' }
  $valuePattern = Try-Pattern $Element ([Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $valuePattern) {
    # Value strings can include filename edit contents. Do not print them.
    $value = [string]$valuePattern.Current.Value
    if ($value.Length -gt $probeMaximumTextBytes) { Reject 'VALUE_LIMIT' }
    $result.valuePattern = @{ readOnly = $valuePattern.Current.IsReadOnly; length = $value.Length; sha256 = (Hash-Text $value); equalsSourcePath = (Same-Path $value $script:probeSource); equalsSourceFilename = (Equal-Text $value ([IO.Path]::GetFileName($script:probeSource))) }
  }
  $selection = Try-Pattern $Element ([Windows.Automation.SelectionItemPattern]::Pattern)
  if ($null -ne $selection) { $result.isSelected = $selection.Current.IsSelected }
  return $result
}
function Window-Nodes($Root) {
  # Stay within the supplied HWND. Offscreen branches, including inactive document
  # buffers, are pruned. This never enumerates other Notepad windows or their tabs.
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object 'Collections.Generic.Queue[object]'
  $result = New-Object 'Collections.Generic.List[object]'
  $queue.Enqueue(@{ element = $Root; parent = $null; depth = 0 })
  while ($queue.Count -gt 0) {
    Check-Deadline
    $entry = $queue.Dequeue(); $element = $entry.element
    if ($entry.depth -gt 24 -or $result.Count -ge $probeMaximumNodes) { Reject 'TREE_LIMIT' }
    if ($entry.depth -gt 0 -and $element.Current.IsOffscreen) { continue }
    $result.Add($entry)
    $nodeId = Id $element
    # A document node is a leaf for this structural scan: never traverse sibling
    # document contents. Pinned probes require the editor element reported earlier.
    if ($entry.depth -gt 0 -and ($element.Current.ControlType -in @([Windows.Automation.ControlType]::Document, [Windows.Automation.ControlType]::Edit) -or
        ($element.Current.ControlType -eq [Windows.Automation.ControlType]::Custom -and $null -ne (Try-Pattern $element ([Windows.Automation.TextPattern]::Pattern))))) { continue }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
      Check-Deadline
      $queue.Enqueue(@{ element = $child; parent = $nodeId; depth = $entry.depth + 1 })
      if ($queue.Count -gt $probeMaximumNodes) { Reject 'TREE_LIMIT' }
      $child = $walker.GetNextSibling($child)
    }
  }
  return ,$result.ToArray()
}
function Read-MarkedDocument($Element) {
  $current = $Element.Current
  if ($current.IsOffscreen -or $current.ControlType -notin @([Windows.Automation.ControlType]::Document, [Windows.Automation.ControlType]::Edit, [Windows.Automation.ControlType]::Custom)) { return $null }
  $pattern = Try-Pattern $Element ([Windows.Automation.TextPattern]::Pattern)
  if ($null -eq $pattern) { return $null }
  $range = $pattern.DocumentRange
  if ($range.GetChildren().Length -ne 0) { return $null }
  $text = $range.GetText($probeMaximumTextBytes + 1)
  if ($text.Length -gt $probeMaximumTextBytes -or [Text.Encoding]::UTF8.GetByteCount($text) -gt $probeMaximumTextBytes) { return $null }
  if (-not [Text.RegularExpressions.Regex]::IsMatch($text, $script:probeMarkerExpression)) { return $null }
  return @{ element = $Element; text = $text; enclosingRuntimeId = (Id ($range.GetEnclosingElement())) }
}

try {
  if ($WindowHandle -match '^0x[0-9a-fA-F]+$') { $handleNumber = [Convert]::ToInt64($WindowHandle.Substring(2), 16) }
  elseif ($WindowHandle -match '^[1-9][0-9]*$') { $handleNumber = [long]::Parse($WindowHandle) }
  else { Reject 'INVALID_WINDOW_HANDLE' }
  if ($handleNumber -le 0 -or $Marker -notmatch '^[A-Za-z0-9][A-Za-z0-9_.:-]{15,159}$') { Reject 'INVALID_PROBE_ARGUMENT' }
  if ($SaveDialog -and -not $DocumentRuntimeId) { Reject 'PINNED_DOCUMENT_REQUIRED_FOR_DIALOG' }
  if ($DocumentRuntimeId -and $DocumentRuntimeId -notmatch '^-?\d+(?:\.-?\d+)+$') { Reject 'INVALID_DOCUMENT_RUNTIME_ID' }
  if (-not [IO.Path]::IsPathRooted($SourcePath) -or $SourcePath -match '^\\\\' -or [IO.Path]::GetExtension($SourcePath) -ine '.txt') { Reject 'INVALID_SOURCE_PATH' }
  $script:probeSource = [IO.Path]::GetFullPath($SourcePath)
  $sourceItem = Get-Item -LiteralPath $script:probeSource -Force
  if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $sourceItem.Length -gt $probeMaximumTextBytes) { Reject 'INVALID_SOURCE_FILE' }
  $sourceBytes = [IO.File]::ReadAllBytes($script:probeSource)
  if ($sourceBytes.Length -gt $probeMaximumTextBytes) { Reject 'SOURCE_LIMIT' }
  if ($sourceBytes.Length -ge 2 -and $sourceBytes[0] -eq 255 -and $sourceBytes[1] -eq 254) { $decoder = New-Object Text.UnicodeEncoding($false, $true, $true); $sourceText = $decoder.GetString($sourceBytes, 2, $sourceBytes.Length - 2) }
  else {
    $decoder = New-Object Text.UTF8Encoding($false, $true); $offset = 0
    if ($sourceBytes.Length -ge 3 -and $sourceBytes[0] -eq 239 -and $sourceBytes[1] -eq 187 -and $sourceBytes[2] -eq 191) { $offset = 3 }
    $sourceText = $decoder.GetString($sourceBytes, $offset, $sourceBytes.Length - $offset)
  }
  # Raw RichEdit TextPattern can expose CR even when the source uses CRLF. This is
  # marker recognition only; equalsExpected/hash below retain the exact raw text.
  $script:probeMarkerExpression = '(?:\A|\r\n|\r|\n)' + [Text.RegularExpressions.Regex]::Escape($Marker) + '(?:\r\n|\r|\n|\z)'
  if (-not [Text.RegularExpressions.Regex]::IsMatch($sourceText, $script:probeMarkerExpression)) { Reject 'SOURCE_MARKER_NOT_FOUND' }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskshellNotepadReadOnlyProbe {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
  $handle = [IntPtr]$handleNumber
  if (-not [DeskshellNotepadReadOnlyProbe]::IsWindow($handle) -or [DeskshellNotepadReadOnlyProbe]::GetAncestor($handle, 2) -ne $handle -or [DeskshellNotepadReadOnlyProbe]::GetWindow($handle, 4) -ne [IntPtr]::Zero) { Reject 'MAIN_WINDOW_NOT_PROVEN' }
  $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
  $process = [Diagnostics.Process]::GetProcessById($window.Current.ProcessId)
  if ($process.ProcessName -ine 'Notepad' -or $process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { Reject 'NOTEPAD_PROCESS_NOT_PROVEN' }
  $windowId = Id $window
  $document = $null
  if ($DocumentRuntimeId) {
    # Only the explicitly pinned element's text is read, never sibling tab buffers.
    $nodes = Window-Nodes $window
    $pinned = @($nodes | Where-Object { (Id $_.element) -ceq $DocumentRuntimeId })
    if ($pinned.Count -ne 1) { Reject 'PINNED_DOCUMENT_NOT_FOUND' }
    $document = Read-MarkedDocument $pinned[0].element
  } else {
    # The first probe reads only the focused editor or its editor ancestors.
    # Background or unrelated windows cannot become fallback text candidates.
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $ancestors = New-Object 'Collections.Generic.List[object]'
    $cursor = [Windows.Automation.AutomationElement]::FocusedElement; $inside = $false
    for ($depth = 0; $null -ne $cursor -and $depth -lt 32; $depth++) {
      Check-Deadline
      if ((Id $cursor) -ceq $windowId) { $inside = $true; break }
      $ancestors.Add($cursor); $cursor = $walker.GetParent($cursor)
    }
    if (-not $inside) { Reject 'FOCUSED_DOCUMENT_NOT_IN_TARGET_WINDOW' }
    foreach ($candidate in $ancestors) { $document = Read-MarkedDocument $candidate; if ($null -ne $document) { break } }
  }
  if ($null -eq $document) { Reject 'EDITOR_MARKER_NOT_PROVEN' }
  # No UIA metadata is emitted before the synthetic document marker is proven.
  $documentId = Id $document.element
  $nodes = Window-Nodes $window
  $tabs = @($nodes | Where-Object { $_.element.Current.ControlType -eq [Windows.Automation.ControlType]::TabItem })
  $selectedTabs = @($tabs | Where-Object { $pattern = Try-Pattern $_.element ([Windows.Automation.SelectionItemPattern]::Pattern); $null -ne $pattern -and $pattern.Current.IsSelected })
  $selectionSummary = @{ visibleTabCount = $tabs.Count; selectedTabCount = $selectedTabs.Count; selected = @($selectedTabs | ForEach-Object { Metadata $_.element }) }
  $output = @{
    ok = $true; readOnly = $true; scope = 'exact-synthetic-window'; markerVerified = $true
    window = (Metadata $window); process = @{ pid = $process.Id; startedTicks = $process.StartTime.ToUniversalTime().Ticks.ToString() }
    document = (Metadata $document.element); enclosingRuntimeId = $document.enclosingRuntimeId
    buffer = @{ length = $document.text.Length; utf8Bytes = [Text.Encoding]::UTF8.GetByteCount($document.text); sha256 = (Hash-Text $document.text); equalsExpected = (Equal-Text $document.text $sourceText)
      crlfCount = [Text.RegularExpressions.Regex]::Matches($document.text, '\r\n').Count
      loneCRCount = [Text.RegularExpressions.Regex]::Matches($document.text.Replace("`r`n", ''), '\r').Count
      loneLFCount = [Text.RegularExpressions.Regex]::Matches($document.text.Replace("`r`n", ''), '\n').Count }
    tabs = $selectionSummary; dialog = $null
  }
  if ($SaveDialog) {
    $owned = New-Object 'Collections.Generic.List[object]'
    # Top-level window handles only: no traversal of any other application's document tree.
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window)
    $top = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
    foreach ($candidate in $top) {
      if ($candidate.Current.ProcessId -ne $process.Id -or $candidate.Current.NativeWindowHandle -eq 0) { continue }
      $owner = [DeskshellNotepadReadOnlyProbe]::GetWindow([IntPtr]$candidate.Current.NativeWindowHandle, 4)
      for ($depth = 0; $owner -ne [IntPtr]::Zero -and $depth -lt 12; $depth++) {
        if ($owner -eq $handle) { $owned.Add($candidate); break }
        $owner = [DeskshellNotepadReadOnlyProbe]::GetWindow($owner, 4)
      }
    }
    if ($owned.Count -ne 1) { Reject 'UNIQUE_OWNED_DIALOG_NOT_PROVEN' }
    $dialog = $owned[0]; $dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
    $windowPattern = Try-Pattern $dialog ([Windows.Automation.WindowPattern]::Pattern)
    $isModal = $null; if ($null -ne $windowPattern) { $isModal = $windowPattern.Current.IsModal }
    $ownerDisabled = -not [DeskshellNotepadReadOnlyProbe]::IsWindowEnabled($handle)
    $foregroundDialog = [DeskshellNotepadReadOnlyProbe]::GetForegroundWindow() -eq $dialogHandle
    if ($isModal -ne $true -and -not ($ownerDisabled -and $foregroundDialog)) { Reject 'OWNED_MODAL_NOT_PROVEN' }
    $dialogNodes = Window-Nodes $dialog
    $output.dialog = @{ metadata = (Metadata $dialog); modalEvidence = @{ windowPatternIsModal = $isModal; ownerDisabled = $ownerDisabled; foregroundDialog = $foregroundDialog }; controls = @($dialogNodes | ForEach-Object { @{ parentRuntimeId = $_.parent; depth = $_.depth; metadata = (Metadata $_.element) } }) }
  }
  # Re-read the same marked document at the end; a switched/changed buffer invalidates the sample.
  $final = Read-MarkedDocument $document.element
  if ($null -eq $final -or (Id $final.element) -cne $documentId -or -not (Equal-Text $final.text $document.text)) { Reject 'DOCUMENT_CHANGED_DURING_PROBE' }
  Check-Deadline
  $output | ConvertTo-Json -Depth 20 -Compress
  exit 0
} catch {
  $code = 'PROBE_UNAVAILABLE'
  if ($_.Exception.Message -match '^PROBE\|([A-Z0-9_]{1,80})$') { $code = $Matches[1] }
  @{ ok = $false; readOnly = $true; code = $code } | ConvertTo-Json -Compress
  exit 1
}
