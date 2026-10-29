# deskshell 桌面壳 MVP
# Ctrl+Alt+Space 唤起 → 一句话 → 预览（能力申请单 + 步骤 + 汇总）→ 执行 / 取消
# 取消不碰文件、不写日志；执行走 kernel，可用 deskshell undo 撤销。
param(
  [string]$Root = (Get-Location).Path,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $here "cli.ts"
$node = if ($env:DESKSHELL_NODE) { $env:DESKSHELL_NODE } else { "node" }

# ---- Win32：全局热键 + WM_HOTKEY 处理 ----
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class HotKeyHost : NativeWindow {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  public const int WM_HOTKEY = 0x0312;
  public event EventHandler Pressed;

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) {
      var h = Pressed;
      if (h != null) h(this, EventArgs.Empty);
    }
    base.WndProc(ref m);
  }
}
'@
if (-not ("HotKeyHost" -as [type])) { Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Windows.Forms }

$MOD_ALT = 0x0001
$MOD_CONTROL = 0x0002
$VK_SPACE = 0x20
$HOTKEY_ID = 0xD5

function Invoke-Cli {
  param([string[]]$CliArgs)
  $out = & $node $cli @CliArgs 2>&1
  $text = ($out | Out-String).Trim()
  $line = ($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
  if (-not $line) { return [pscustomobject]@{ ok = $false; error = $text } }
  return $line | ConvertFrom-Json
}

# ---- 界面 ----
$form = New-Object System.Windows.Forms.Form
$form.Text = "deskshell"
$form.Width = 720
$form.Height = 520
$form.FormBorderStyle = "None"
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.KeyPreview = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 28)

$query = New-Object System.Windows.Forms.TextBox
$query.Font = New-Object System.Drawing.Font("Segoe UI", 16)
$query.SetBounds(20, 20, 680, 34)
$query.BackColor = [System.Drawing.Color]::FromArgb(38, 38, 44)
$query.ForeColor = [System.Drawing.Color]::White
$query.BorderStyle = "FixedSingle"
$form.Controls.Add($query)

$resultList = New-Object System.Windows.Forms.ListBox
$resultList.SetBounds(20, 62, 680, 90)
$resultList.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 38)
$resultList.ForeColor = [System.Drawing.Color]::White
$resultList.BorderStyle = "None"
$form.Controls.Add($resultList)

$preview = New-Object System.Windows.Forms.TextBox
$preview.SetBounds(20, 160, 680, 260)
$preview.Multiline = $true
$preview.ReadOnly = $true
$preview.ScrollBars = "Vertical"
$preview.Font = New-Object System.Drawing.Font("Consolas", 10)
$preview.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 22)
$preview.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 210)
$preview.BorderStyle = "None"
$form.Controls.Add($preview)

$runButton = New-Object System.Windows.Forms.Button
$runButton.Text = "执行 (Enter)"
$runButton.SetBounds(20, 432, 200, 44)
$runButton.Enabled = $false
$form.Controls.Add($runButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "取消 (Esc)"
$cancelButton.SetBounds(240, 432, 200, 44)
$form.Controls.Add($cancelButton)

$status = New-Object System.Windows.Forms.Label
$status.SetBounds(460, 442, 240, 28)
$status.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 160)
$status.Text = "Ctrl+Alt+Space 唤起"
$form.Controls.Add($status)

$script:selected = $null
$script:intentArgs = "{}"

function Update-Preview {
  $text = $query.Text.Trim()
  $resultList.Items.Clear()
  $script:selected = $null
  $runButton.Enabled = $false
  if ($text.Length -eq 0) {
    $preview.Text = "输入一句话，例如：`r`n  清理下载文件夹`r`n  整理照片`r`n  按日期归档截图"
    $status.Text = "Ctrl+Alt+Space 唤起"
    return
  }
  # 先问意图层：一句话 → 技能 + 参数
  $plan = Invoke-Cli @("plan", $text)
  $intent = $plan.intent
  if (-not $intent) {
    $all = (Invoke-Cli @("skills")).skills.name -join "、"
    $preview.Text = "没有匹配的技能。`r`n`r`n当前可用：$all"
    $status.Text = "没匹配到 · 什么都没做"
    return
  }
  $script:intentArgs = ($intent.args | ConvertTo-Json -Compress)
  if (-not $script:intentArgs) { $script:intentArgs = "{}" }

  if (@($intent.missing).Count -gt 0) {
    $preview.Text = "还差一点信息：`r`n  " + ($intent.missing -join "、") + "`r`n`r`n" + $intent.question
    $status.Text = "等你补充参数"
    [void]$resultList.Items.Add($intent.skill)
    $resultList.SelectedIndex = 0
    $runButton.Enabled = $false
    $script:selected = $intent.skill
    return
  }

  $status.Text = "置信度 $($intent.confidence) · $($intent.reason)"
  [void]$resultList.Items.Add($intent.skill)
  $resultList.SelectedIndex = 0
  Show-Candidate
  return

  foreach ($cand in $m.matches) { [void]$resultList.Items.Add($cand.name) }
  $resultList.SelectedIndex = 0
  Show-Candidate
}

function Show-Candidate {
  if ($resultList.SelectedIndex -lt 0) { return }
  $name = $resultList.SelectedItem.ToString()
  $p = Invoke-Cli @("preview", $name, "--root", $Root, "--args", $script:intentArgs)
  if (-not $p.ok) { $preview.Text = "预览失败：$($p.error)"; return }
  $lines = @()
  $lines += "技能：$($p.skill)"
  $lines += "参数：" + $script:intentArgs
  $lines += ""
  $lines += "需要的能力："
  foreach ($cap in $p.capabilities) { $lines += ("  - " + $cap.id + "　" + $cap.reason) }
  $lines += ""
  $lines += "步骤：$($p.steps.Count) 步"
  foreach ($s in $p.steps) { $lines += ("  " + $s.actionId + "  [" + $s.status + "]") }
  $lines += ""
  $lines += "汇总：" + ($p.summary | ConvertTo-Json -Compress)
  $preview.Text = $lines -join "`r`n"
  $script:selected = $name
  $runButton.Enabled = $true
  $status.Text = "预览中 · 未做任何改动"
}

$query.Add_TextChanged({ Update-Preview })
$resultList.Add_SelectedIndexChanged({ Show-Candidate })

$runButton.Add_Click({
  if (-not $script:selected) { return }
  $r = Invoke-Cli @("apply", $script:selected, "--root", $Root, "--args", $script:intentArgs)
  if ($r.ok) {
    $status.Text = "已执行 $($r.steps) 步"
    [void][System.Windows.Forms.MessageBox]::Show("已执行 $($r.steps) 步。`r`n`r`n撤销：deskshell undo --last --root `"$Root`"", "deskshell")
  } else {
    $status.Text = "执行失败"
    [void][System.Windows.Forms.MessageBox]::Show("执行失败：$($r.error)", "deskshell")
  }
  $form.Hide()
})

$cancelButton.Add_Click({
  # 明确走一次 cancel：让"取消"是一个被记录的意图，而不是"关窗了事"
  [void](Invoke-Cli @("cancel"))
  $status.Text = "已取消 · 没有任何改动"
  $preview.Text = ""
  $query.Text = ""
  $form.Hide()
})

$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq "Escape") { $cancelButton.PerformClick() }
  elseif ($e.KeyCode -eq "Return" -and $runButton.Enabled) { $runButton.PerformClick() }
})

$host_ = New-Object HotKeyHost
$host_.add_Pressed({
  $form.Show()
  $form.Activate()
  $query.Focus()
  $query.SelectAll()
  $status.Text = "Ctrl+Alt+Space 唤起"
})

$form.Add_Shown({
  $host_.AssignHandle($form.Handle)
  $ok = [HotKeyHost]::RegisterHotKey($form.Handle, $HOTKEY_ID, ($MOD_CONTROL -bor $MOD_ALT), $VK_SPACE)
  if ($ok) { $status.Text = "热键就绪 · Ctrl+Alt+Space" } else { $status.Text = "热键注册失败（可能被占用）" }
  $query.Focus()
  Update-Preview

  if ($SelfTest) {
    $logFile = if ($env:DESKSHELL_SELFTEST_OUT) { $env:DESKSHELL_SELFTEST_OUT } else { Join-Path $here "selftest.log" }
    $lines = @()
    $lines += ("SELFTEST hotkey=" + $ok)
    $skills = Invoke-Cli @("skills")
    $lines += ("SELFTEST skills=" + $skills.skills.Count)
    $m = Invoke-Cli @("match", "清理下载")
    $lines += ("SELFTEST match=" + $m.matches[0].name)
    $pl = Invoke-Cli @("plan", "把 30 天前的日志归档")
    $lines += ("SELFTEST plan=" + $pl.intent.skill)
    $lines += ("SELFTEST planDays=" + $pl.intent.args.maxAgeDays)
    $p = Invoke-Cli @("preview", $m.matches[0].name, "--root", $Root)
    $lines += ("SELFTEST previewSteps=" + $p.steps.Count)
    $lines += ("SELFTEST capabilities=" + @($p.capabilities).Count)
    $c = Invoke-Cli @("cancel")
    $lines += ("SELFTEST cancel=" + $c.cancelled)
    $lines += ("SELFTEST root=" + $Root)
    $lines | Set-Content -Path $logFile -Encoding UTF8
    $lines | ForEach-Object { Write-Output $_ }
    [void][HotKeyHost]::UnregisterHotKey($form.Handle, $HOTKEY_ID)
    $form.Close()
  }
})

$form.Add_FormClosing({
  try { [void][HotKeyHost]::UnregisterHotKey($form.Handle, $HOTKEY_ID) } catch { }
})

[void][System.Windows.Forms.Application]::Run($form)
