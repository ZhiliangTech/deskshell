param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Seconds = 15,
  # 回退轮询间隔；事件模式下只用于兜底检查
  [int]$IntervalMs = 300,
  # 强制使用轮询模式（事件注册失败时会自动回退）
  [switch]$Poll
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


Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @"
using System;
using System.Collections.Concurrent;
using System.Windows.Automation;

public static class UiaWatcher
{
    public static readonly ConcurrentQueue<object> Focus = new ConcurrentQueue<object>();
    public static readonly ConcurrentQueue<object> Opened = new ConcurrentQueue<object>();
    public static string Error = null;

    private static AutomationFocusChangedEventHandler _focus;
    private static StructureChangedEventHandler _structure;

    public static bool Start()
    {
        try
        {
            _focus = new AutomationFocusChangedEventHandler(OnFocus);
            Automation.AddAutomationFocusChangedEventHandler(_focus);

            _structure = new StructureChangedEventHandler(OnStructure);
            Automation.AddStructureChangedEventHandler(
                AutomationElement.RootElement,
                TreeScope.Children,
                _structure);
            return true;
        }
        catch (Exception ex)
        {
            Error = ex.Message;
            return false;
        }
    }

    public static void Stop()
    {
        try { if (_focus != null) Automation.RemoveAutomationFocusChangedEventHandler(_focus); } catch { }
        try { if (_structure != null) Automation.RemoveStructureChangedEventHandler(AutomationElement.RootElement, _structure); } catch { }
    }

    private static void OnFocus(object sender, AutomationFocusChangedEventArgs e)
    {
        var el = sender as AutomationElement;
        if (el != null) Focus.Enqueue(el);
    }

    private static void OnStructure(object sender, StructureChangedEventArgs e)
    {
        var el = sender as AutomationElement;
        if (el == null) return;
        try
        {
            // 只关心"顶层窗口出现"这一种结构变化，Subtree 事件太吵
            if (el.Current.ControlType != ControlType.Window) return;
        }
        catch { return; }
        Opened.Enqueue(el);
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

# 事件模式：焦点与窗口出现由 UIA 回调直接投递；DoEvents 负责把回调派发到本线程。
# 注册失败（例如无消息泵/权限不足）就退回轮询，不中断录制。
$useEvents = -not $Poll
if ($useEvents) {
  Add-Type -AssemblyName System.Windows.Forms
  if (-not [UiaWatcher]::Start()) {
    $useEvents = $false
    [Console]::Error.WriteLine("事件注册失败，回退轮询：" + [UiaWatcher]::Error)
  }
}

$lastPoll = [DateTime]::MinValue

while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
  if ($useEvents) {
    [System.Windows.Forms.Application]::DoEvents()

    $el = $null
    while ([UiaWatcher]::Focus.TryDequeue([ref]$el)) {
      try {
        $row = Get-Row ([System.Windows.Automation.AutomationElement]$el) 'focus' -1 -1
        if ($row -ne $null) { $writer.WriteLine(($row | ConvertTo-Json -Compress)); $count++ }
      } catch { $null = $_ }
      $el = $null
    }

    $win = $null
    while ([UiaWatcher]::Opened.TryDequeue([ref]$win)) {
      try {
        $w = [System.Windows.Automation.AutomationElement]$win
        $wname = $w.Current.Name
        if (-not [string]::IsNullOrWhiteSpace($wname)) {
          # 结构变化会对同一个窗口触发多次，按"标题|pid"去重
          $wkey = "$wname|$($w.Current.ProcessId)"
          if (-not $known.ContainsKey($wkey)) {
            $known[$wkey] = $true
            $row = Get-Row $w 'window-open' -1 -1
            if ($row -ne $null) { $writer.WriteLine(($row | ConvertTo-Json -Compress)); $count++ }
          }
        }
      } catch { $null = $_ }
      $win = $null
    }
  } else {
    # 轮询回退：每 IntervalMs 采一次焦点 + 扫一遍顶层窗口
    if (([DateTime]::Now - $lastPoll).TotalMilliseconds -ge $IntervalMs) {
      $lastPoll = [DateTime]::Now
      try {
        $row = Get-Row ($AE::FocusedElement) 'focus' -1 -1
        if ($row -ne $null) { $writer.WriteLine(($row | ConvertTo-Json -Compress)); $count++ }
      } catch { $null = $_ }
      try {
        foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
          $wname = $w.Current.Name
          if ([string]::IsNullOrWhiteSpace($wname)) { continue }
          $wkey = "$wname|$($w.Current.ProcessId)"
          if ($known.ContainsKey($wkey)) { continue }
          $known[$wkey] = $true
          if ($seeded) {
            $row = Get-Row $w 'window-open' -1 -1
            if ($row -ne $null) { $writer.WriteLine(($row | ConvertTo-Json -Compress)); $count++ }
          }
        }
        if (-not $seeded) { $seeded = $true }
      } catch { $null = $_ }
    }
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

  # 事件模式下短睡以便及时派发回调；轮询模式按 IntervalMs 采样
  if ($useEvents) { Start-Sleep -Milliseconds 20 } else { Start-Sleep -Milliseconds $IntervalMs }
}

if ($useEvents) { [UiaWatcher]::Stop() }
$writer.Close()
@{ ok = $true; data = @{ events = $count; file = $Out; mode = $(if ($useEvents) { 'events' } else { 'poll' }) } } | ConvertTo-Json -Compress
