<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# 安装

三条路，按"在恶劣网络下最不容易失败"排序。

## 1. 安装脚本（推荐）

```powershell
irm https://raw.githubusercontent.com/ciceroyang/deskshell/main/install.ps1 -OutFile install.ps1
.\install.ps1
```

它按顺序做这些事：

1. 检查 `node` ≥ 22.18 / ≥ 23.6，以及 `npm` 是否存在；
2. 向 `api.github.com` 要最新发行版信息；
3. **经 API 下载** `.tgz`，而不是走 `releases/download`——后者在 `github.com` 上，部分网络连不上，而 API 是通的；
4. `npm i -g` 装好后自动跑 `deskshell doctor`；
5. 打印前三条可以试的命令。

匿名下载可用；如果你设了 `GITHUB_TOKEN` 或 `DESKSHELL_GH_TOKEN`，脚本会用它来避免限流。

常用参数：`-Prefix C:\tools\ds` 装到指定目录而不是全局（干净环境验收就是这么跑的），`-SkipDoctor` 跳过自检。

## 2. GitHub Packages

```bash
npm config set @ciceroyang:registry https://npm.pkg.github.com
npm i -g @ciceroyang/deskshell
```

需要带 `read:packages` 的 GitHub token 写进 `~/.npmrc`。已经给 npm 配好 GitHub 的人走这条。

## 3. 从源码

```bash
git clone https://github.com/ciceroyang/deskshell && cd deskshell
node bin/deskshell.ts doctor
```

没有构建步骤：CLI 就是 TypeScript，靠 Node 的类型擦除直接跑。

## "装好了"长什么样

```
$ deskshell doctor
PASS node           v22.23.4
PASS platform       win32
PASS driver         12 个窗口，410ms
PASS skills         8 个 skill，0 个不合规
PASS workspace      可写
PASS runtime        内核与 bin 就位
PASS package        package.json 就位

7 passed, 0 warning, 0 failed
```

## 装不上的时候

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | 在 `node_modules` 里直接跑 `bin/deskshell.ts` | 用 `deskshell` 命令（启动器会把运行时镜像出 `node_modules`），别直接跑 `.ts` |
| 退出码 `-1073741819`、无任何输出 | Node 22.23.4 的 `fs.cpSync` 在 Windows 上访问违例（0.5.1 已修） | 升到 ≥ 0.5.1 |
| `connect ETIMEDOUT 20.205.243.166:443` | `github.com` 不通，却在走 `releases/download` 直链 | 用安装脚本（走 API） |
| `deskshell.ps1 因为在此系统上禁止运行脚本` | PowerShell 执行策略是 `Restricted` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，或直接调用 `deskshell.cmd` |
| 装完提示 `deskshell: 找不到命令` | npm 全局 bin 目录不在 `PATH` | 把 `%APPDATA%\npm`（或你的 npm prefix）加进 `PATH` |

这张表里的每一条都是 M01 在 Windows 11 上真实踩到的，不是猜的。
