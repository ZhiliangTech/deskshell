param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Seconds = 15,
  [int]$IntervalMs = 300
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

Add-Type @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class ClickWatcher
{
    public static readonly ConcurrentQueue<int[]> Clicks = new ConcurrentQueue<int[]>();
    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static HookProc _proc;
    private static IntPtr _hook = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    public static void Start()
    {
        var thread = new Thread(() =>
        {
            _proc = Callback;
            _hook = SetWindowsHookEx(14, _proc, IntPtr.Zero, 0);
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    private static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && wParam == (IntPtr)0x0201)
        {
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            Clicks.Enqueue(new int[] { data.pt.x, data.pt.y });
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$writer = New-Object System.IO.StreamWriter($Out, $false, (New-Object System.Text.UTF8Encoding($false)))
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$count = 0

function Get-Row($el, $kind, $x, $y) {
  if ($el -eq $null) { return $null }
  $c = $el.Current
  $win = $el
  $parent = $walker.GetParent($el)
  while ($parent -ne $null) {
    $pct = $parent.Current.ControlType.ProgrammaticName
    if ($pct -eq 'ControlType.Window') { $win = $parent; break }
    $parent = $walker.GetParent($parent)
  }
  $value = $null
  $vp = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    try { $value = $vp.Current.Value } catch { $value = $null }
  }
  return [ordered]@{
    ts           = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    type         = $kind
    window       = $win.Current.Name
    windowPid    = $win.Current.ProcessId
    controlType  = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
    name         = $c.Name
    automationId = $c.AutomationId
    value        = $value
    x            = $x
    y            = $y
  }
}

[ClickWatcher]::Start()

$TS = [System.Windows.Automation.TreeScope]
$known = @{}
$seeded = $false

while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
  # 顶层窗口出现 = 点击生效的强信号
  $complete = $true
  try {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $wname = $w.Current.Name
        if ([string]::IsNullOrWhiteSpace($wname)) { continue }
        $wkey = "$wname|$($w.Current.ProcessId)"
        if ($known.ContainsKey($wkey)) { continue }
        if ($seeded) {
          $row = Get-Row $w 'window-open' -1 -1
          if ($row -ne $null) {
            $writer.WriteLine(($row | ConvertTo-Json -Compress))
            $count++
          }
        }
        $known[$wkey] = $true
      } catch {
        $complete = $false
      }
    }
    if (-not $seeded -and $complete) { $seeded = $true }
  } catch {
    $null = $_
  }

  try {
    $el = $AE::FocusedElement
    $row = Get-Row $el 'focus' -1 -1
    if ($row -ne $null) {
      $writer.WriteLine(($row | ConvertTo-Json -Compress))
      $count++
    }
  } catch {
    $null = $_
  }

  $click = $null
  while ([ClickWatcher]::Clicks.TryDequeue([ref]$click)) {
    try {
      $pt = New-Object System.Windows.Point([double]$click[0], [double]$click[1])
      $hit = $AE::FromPoint($pt)
      $row = Get-Row $hit 'click' $click[0] $click[1]
      if ($row -ne $null) {
        $writer.WriteLine(($row | ConvertTo-Json -Compress))
        $count++
      }
    } catch {
      $null = $_
    }
  }

  Start-Sleep -Milliseconds $IntervalMs
}

$writer.Close()
@{ ok = $true; data = @{ events = $count; file = $Out } } | ConvertTo-Json -Compress
