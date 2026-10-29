<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# 安装

三条路，按"在恶劣网络下最不容易失败"排序。

## 1. 安装脚本（推荐）

```powershell
irm https://raw.githubusercontent.com/ZhiliangTech/deskshell/main/install.ps1 -OutFile install.ps1
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
npm config set @zhiliangtech:registry https://npm.pkg.github.com
npm i -g @zhiliangtech/deskshell
```

需要带 `read:packages` 的 GitHub token 写进 `~/.npmrc`。已经给 npm 配好 GitHub 的人走这条。

## 3. 从源码

```bash
git clone https://github.com/ZhiliangTech/deskshell && cd deskshell
node bin/deskshell.ts doctor
```

没有构建步骤：CLI 就是 TypeScript，靠 Node 的类型擦除直接跑。

## 4. 直接从 Git 装（完全不经过 registry）

`registry.npmjs.org` 慢、或者包还没发布时，npm 可以直接从仓库装：

```bash
npm i -g github:ZhiliangTech/deskshell
npx github:ZhiliangTech/deskshell doctor      # 一次性跑，不装全局
```

走的是 `github.com` + Git，不是 npm registry。发行版附件同理：

```bash
npm i -g https://github.com/ZhiliangTech/deskshell/releases/download/v0.9.0/zhiliangtech-deskshell-0.9.0.tgz
```

## 5. 维护者：www.npmjs.com 打不开时怎么发布

npm 的**网站**被墙时，**registry API** 往往是通的。别猜，先测：

```bash
node scripts/npm-token.ts --dry-run     # 打印 registry ping 状态
```

ping 是 200，就可以**不开网页**拿到 token（legacy 登录接口）：

```bash
NPM_USER=你的用户名 NPM_PASS=*** NPM_EMAIL=you@example.com [NPM_OTP=123456] node scripts/npm-token.ts
```

它把 `//registry.npmjs.org/:_authToken` 写进 `~/.npmrc`（权限 600），只打印 token 前 8 位。然后：

```bash
node scripts/publish-npm.ts              # 带 scope：@<你的 npm 用户名>/deskshell
node scripts/publish-npm-unscoped.ts     # 无 scope：deskshell（临时副本发布，仓库不动）
```

两个脚本都会自己从 registry 拉一份 npm CLI，本机不需要装 npm。截至 2026-10-30，无 scope 的 `deskshell` 名字是空的，这才是 `npm i -g deskshell` 能成立的前提。

如果 registry 也不通，走上面的 Git 通道、GitHub Packages（§2）或安装脚本（§1）。`.github/workflows/publish.yml` 会在每个 `v*` tag 上发 GitHub Packages，只有仓库里配了 `NPM_TOKEN` secret 时才发公共 npm。

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
