param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DsWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-Rect($r) {
  if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y) -or [double]::IsInfinity($r.Width) -or [double]::IsInfinity($r.Height)) {
    return @{ x = 0; y = 0; w = 0; h = 0 }
  }
  return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}

function Get-TopWindows {
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $AE::RootElement.FindAll($TS::Children, $cond) | ForEach-Object {
    $c = $_.Current
    $r = Get-Rect $c.BoundingRectangle
    [pscustomobject]@{
      name      = $c.Name
      className = $c.ClassName
      pid       = $c.ProcessId
      x = $r.x; y = $r.y; w = $r.w; h = $r.h
    }
  }
}

function Select-WindowElement($titleRegex, $pidValue) {
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  foreach ($e in $AE::RootElement.FindAll($TS::Children, $cond)) {
    if ($pidValue -and $e.Current.ProcessId -ne [int]$pidValue) { continue }
    if ($titleRegex -and ($e.Current.Name -notmatch $titleRegex)) { continue }
    return $e
  }
  return $null
}

function Convert-Node($el, $depth, $maxDepth, $counter) {
  if ($counter.Value -ge 1200) { return $null }
  $counter.Value++
  $c = $el.Current
  $r = Get-Rect $c.BoundingRectangle
  $value = $null
  $vp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    try { $value = $vp.Current.Value } catch { $value = $null }
  }
  $node = [ordered]@{
    name         = $c.Name
    automationId = $c.AutomationId
    controlType  = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
    className    = $c.ClassName
    enabled      = $c.IsEnabled
    value        = $value
    x = $r.x; y = $r.y; w = $r.w; h = $r.h
    children     = @()
  }
  if ($depth -lt $maxDepth) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
      $converted = Convert-Node $child ($depth + 1) $maxDepth $counter
      if ($converted -ne $null) { $node.children += $converted }
      $child = $walker.GetNextSibling($child)
    }
  }
  return $node
}

function Find-Element($win, $sel) {
  foreach ($e in $win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($sel.automationId -and $e.Current.AutomationId -ne $sel.automationId) { continue }
    if ($sel.name -and $e.Current.Name -ne $sel.name) { continue }
    if ($sel.controlType) {
      $ct = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
      if ($ct -ne $sel.controlType) { continue }
    }
    return $e
  }
  return $null
}

function Focus-Window($el) {
  $h = [IntPtr]$el.Current.NativeWindowHandle
  if ($h -ne [IntPtr]::Zero) { [void][DsWin32]::SetForegroundWindow($h) }
  Start-Sleep -Milliseconds 120
}

function Save-Clipboard { try { return (Get-Clipboard -Raw -ErrorAction Stop) } catch { return $null } }
function Restore-Clipboard($text) { if ($text -ne $null) { try { Set-Clipboard -Value $text } catch {} } }

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "empty request" }
  $req = $raw | ConvertFrom-Json
  $action = $req.action

  switch ($action) {
    'windows' {
      $data = @(Get-TopWindows)
    }
    'tree' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found: $($req.titleRegex) / pid=$($req.pid)" }
      $counter = [ref]0
      $maxDepth = if ($req.depth) { [int]$req.depth } else { 6 }
      $data = Convert-Node $win 0 $maxDepth $counter
      $data.windowPid = $win.Current.ProcessId
    }
    'invoke' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      Focus-Window $win
      $el = Find-Element $win $req.selector
      if ($el -eq $null) { throw "element not found" }
      $p = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select() }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand() }
      else { throw "element has no invoke/select pattern" }
      Start-Sleep -Milliseconds 150
      $data = @{ invoked = $true; name = $el.Current.Name }
    }
    'click' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      Focus-Window $win
      $el = Find-Element $win $req.selector
      if ($el -eq $null) { throw "element not found" }
      $r = $el.Current.BoundingRectangle
      $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
      [void][DsWin32]::SetCursorPos($cx, $cy)
      [DsWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      [DsWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 150
      $data = @{ clicked = $true; x = $cx; y = $cy; name = $el.Current.Name }
    }
    'focus' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      Focus-Window $win
      $data = @{ focused = $true; pid = $win.Current.ProcessId }
    }
    'bounds' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      $h = [IntPtr]$win.Current.NativeWindowHandle
      $r = New-Object DsWin32+RECT
      [void][DsWin32]::GetWindowRect($h, [ref]$r)
      $data = @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
    }
    'move' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      $h = [IntPtr]$win.Current.NativeWindowHandle
      if ($h -eq [IntPtr]::Zero) { throw "window has no native handle" }
      [void][DsWin32]::MoveWindow($h, [int]$req.x, [int]$req.y, [int]$req.w, [int]$req.h, $true)
      Start-Sleep -Milliseconds 120
      $data = @{ moved = $true; x = [int]$req.x; y = [int]$req.y; w = [int]$req.w; h = [int]$req.h }
    }
    'type' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      Focus-Window $win
      $el = Find-Element $win $req.selector
      if ($el -eq $null) { throw "element not found" }
      $p = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
        $p.SetValue([string]$req.text)
        $data = @{ typed = $true; via = 'ValuePattern' }
      } else {
        $saved = Save-Clipboard
        Set-Clipboard -Value ([string]$req.text)
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        [System.Windows.Forms.SendKeys]::SendWait('^v')
        Start-Sleep -Milliseconds 200
        Restore-Clipboard $saved
        $data = @{ typed = $true; via = 'Clipboard' }
      }
    }
    'keys' {
      $win = Select-WindowElement $req.titleRegex $req.pid
      if ($win -eq $null) { throw "window not found" }
      Focus-Window $win
      [System.Windows.Forms.SendKeys]::SendWait([string]$req.combo)
      Start-Sleep -Milliseconds 200
      $data = @{ sent = $req.combo }
    }
    'launch' {
      if ($req.args -and $req.args.Count -gt 0) {
        $proc = Start-Process -FilePath $req.file -ArgumentList $req.args -PassThru
      } else {
        $proc = Start-Process -FilePath $req.file -PassThru
      }
      $wait = 1200
      if ($req.PSObject.Properties.Name -contains 'waitMs') { $wait = [int]$req.waitMs }
      Start-Sleep -Milliseconds $wait
      $data = @{ pid = $proc.Id; file = $req.file }
    }
    default { throw "unknown action: $action" }
  }

  @{ ok = $true; data = $data } | ConvertTo-Json -Depth 24 -Compress
}
catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
  exit 1
}
