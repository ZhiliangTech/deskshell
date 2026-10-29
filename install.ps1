# deskshell installer for Windows
#
#   irm https://raw.githubusercontent.com/ciceroyang/deskshell/main/install.ps1 | iex
#   .\install.ps1                # 或本地直接运行
#   .\install.ps1 -Prefix C:\tmp\ds   # 装到指定目录（干净环境验收用）
#
# 为什么要这么写：github.com 在部分网络不可达，但 api.github.com 可达。
# 所以安装包从 GitHub API 的 release asset 接口取，而不是 releases/download 直链。

param(
  [string]$Prefix = "",
  [string]$Version = "latest",
  [switch]$SkipDoctor
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repo = "ciceroyang/deskshell"

function Fail($msg) {
  Write-Host ""
  Write-Host "安装失败：$msg" -ForegroundColor Red
  exit 1
}

Write-Host "deskshell installer" -ForegroundColor Cyan
Write-Host ""

# 1) Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail @"
找不到 node。请先安装 Node.js >= 22.18：
  winget install OpenJS.NodeJS.LTS
  或从 https://npmmirror.com/mirrors/node/ 下载 zip 解压后把目录加进 PATH
装好后重新运行本脚本。
"@
}
$nodeVersion = (& node -v).TrimStart("v")
$parts = $nodeVersion.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
$ok = ($major -eq 22 -and $minor -ge 18) -or ($major -ge 24) -or ($major -eq 23 -and $minor -ge 6)
if (-not $ok) {
  Fail "Node 版本太旧：v$nodeVersion（需要 >= 22.18 或 >= 23.6）"
}
Write-Host "node v$nodeVersion ... ok" -ForegroundColor Green

# 2) npm
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Fail "找不到 npm。请安装官方 Node.js 发行版（便携版 node.exe 不带 npm）。"
}

# 3) 解析 release 资产
$apiBase = "https://api.github.com/repos/$repo"
$headers = @{ "User-Agent" = "deskshell-installer"; "Accept" = "application/vnd.github+json" }
$token = $env:DESKSHELL_GH_TOKEN
if (-not $token) { $token = $env:GITHUB_TOKEN }
if ($token) { $headers["Authorization"] = "token $token" }

$tagUrl = if ($Version -eq "latest") { "$apiBase/releases/latest" } else { "$apiBase/releases/tags/$Version" }
Write-Host "查询发行版：$tagUrl"
try {
  $release = Invoke-RestMethod -Uri $tagUrl -Headers $headers
} catch {
  Fail "拿不到发行版信息（$($_.Exception.Message)）。网络能访问 api.github.com 吗？"
}

$asset = $release.assets | Where-Object { $_.name -like "*.tgz" } | Select-Object -First 1
if (-not $asset) { Fail "这个发行版没有 .tgz 资产：$($release.tag_name)" }

Write-Host "发行版 $($release.tag_name)，资产 $($asset.name)（$([math]::Round($asset.size/1024)) KB）"

# 4) 经 API 下载（github.com 直链在部分网络不可用）
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
$dlHeaders = @{ "User-Agent" = "deskshell-installer"; "Accept" = "application/octet-stream" }
if ($token) { $dlHeaders["Authorization"] = "token $token" }
Write-Host "下载中（走 api.github.com，不走 github.com 直链）..."
try {
  Invoke-WebRequest -Uri $asset.url -Headers $dlHeaders -OutFile $tmp -UseBasicParsing
} catch {
  Fail "下载失败（$($_.Exception.Message)）"
}
$size = (Get-Item $tmp).Length
if ($size -ne $asset.size) { Fail "下载不完整：$size / $($asset.size) 字节" }
Write-Host "已下载 $([math]::Round($size/1024)) KB" -ForegroundColor Green

# 5) 安装
$npmArgs = @("i", "-g", $tmp, "--no-audit", "--no-fund")
if ($Prefix) { $npmArgs += @("--prefix", $Prefix) }
Write-Host "npm $($npmArgs -join ' ')"
& npm @npmArgs
if ($LASTEXITCODE -ne 0) { Fail "npm 安装失败" }

$binDir = if ($Prefix) { Join-Path $Prefix "" } else { Split-Path (Get-Command node).Source -Parent }
$shim = if ($Prefix) { Join-Path $Prefix "deskshell.cmd" } else { Join-Path $binDir "deskshell.cmd" }
if (-not (Test-Path $shim)) {
  # npm --prefix 时 shim 在 <prefix> 下；全局时在 node 目录
  $shim = (Get-ChildItem -Path $binDir -Filter "deskshell.cmd" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
Write-Host "已安装：$shim" -ForegroundColor Green

# 6) 自检
if (-not $SkipDoctor) {
  Write-Host ""
  Write-Host "运行 deskshell doctor ..."
  & $shim doctor
  if ($LASTEXITCODE -ne 0) {
    Write-Host "doctor 没有全绿，请把上面输出发给维护者。" -ForegroundColor Yellow
    exit 1
  }
}

Write-Host ""
Write-Host "装好了。下一步：" -ForegroundColor Cyan
Write-Host "  deskshell list"
Write-Host "  deskshell run downloads-cleanup --root .\demo        # 只预览"
Write-Host "  deskshell run downloads-cleanup --root .\demo --mode apply"
Write-Host "  deskshell history"
Write-Host ""
Write-Host "用户 skill 目录：$(Join-Path $env:USERPROFILE '.deskshell\skills')"
