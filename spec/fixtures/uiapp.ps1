# 一个可控的 UIA 测试窗口：不碰用户任何数据，专门给驱动/录制器做真机验证。
param([string]$Text = "seed")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "deskshell-uiapp"
$form.Width = 420
$form.Height = 220
$form.StartPosition = "CenterScreen"

$input = New-Object System.Windows.Forms.TextBox
$input.Name = "Input"
$input.AccessibleName = "Input"
$input.Left = 20
$input.Top = 20
$input.Width = 360
$input.Text = $Text
$form.Controls.Add($input)

$button = New-Object System.Windows.Forms.Button
$button.Name = "Echo"
$button.AccessibleName = "Echo"
$button.Text = "Echo"
$button.Left = 20
$button.Top = 60
$button.Width = 120
$button.Add_Click({
    $out.Text = $input.Text
    $out.AccessibleName = "Out"
  })
$form.Controls.Add($button)

$out = New-Object System.Windows.Forms.Label
$out.Name = "Out"
$out.AccessibleName = "Out"
$out.Text = ""
$out.Left = 20
$out.Top = 100
$out.Width = 360
$out.Height = 40
$form.Controls.Add($out)

"READY pid=$PID text=$($form.Text)" | Write-Output
[System.Windows.Forms.Application]::Run($form)
