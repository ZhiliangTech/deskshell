<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Install

Three ways in, in order of "least likely to fail on a hostile network".

## 1. Installer (recommended)

```powershell
irm https://raw.githubusercontent.com/ciceroyang/deskshell/main/install.ps1 -OutFile install.ps1
.\install.ps1
```

What it does, in order:

1. checks `node` ≥ 22.18 / ≥ 23.6 and that `npm` exists;
2. asks `api.github.com` for the latest release;
3. downloads the `.tgz` asset **through the API**, not through `releases/download` — the latter lives on `github.com`, which is unreachable from some networks while the API is fine;
4. `npm i -g` the file, then runs `deskshell doctor`;
5. prints the first three commands to try.

Anonymous downloads work; if you have `GITHUB_TOKEN` or `DESKSHELL_GH_TOKEN` set, the installer uses it to avoid rate limits.

Useful flags: `-Prefix C:\tools\ds` installs into a directory instead of globally (this is how the clean-room acceptance test runs), `-SkipDoctor` skips the self-check.

## 2. GitHub Packages

```bash
npm config set @ciceroyang:registry https://npm.pkg.github.com
npm i -g @ciceroyang/deskshell
```

Needs a GitHub token with `read:packages` in `~/.npmrc`. This is the channel to use if you already have npm configured for GitHub.

## 3. From source

```bash
git clone https://github.com/ciceroyang/deskshell && cd deskshell
node bin/deskshell.ts doctor
```

No build step: the CLI is TypeScript run directly by Node's type stripping.

## What "it works" looks like

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

## When it fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | running `bin/deskshell.ts` from inside `node_modules` | use the `deskshell` shim, not the `.ts` file; the shim mirrors the runtime out of `node_modules` |
| exit code `-1073741819`, no output | Node 22.23.4 `fs.cpSync` access violation while mirroring (fixed in 0.5.1) | upgrade to ≥ 0.5.1 |
| `connect ETIMEDOUT 20.205.243.166:443` | `github.com` blocked, trying to download from `releases/download` | use the installer (API path) |
| `deskshell.ps1 因为在此系统上禁止运行脚本` | PowerShell execution policy is `Restricted` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or call `deskshell.cmd` |
| `deskshell: command not found` after install | npm global bin directory not on `PATH` | add `%APPDATA%\npm` (or your npm prefix) to `PATH` |

Every one of these was hit during the M01 acceptance run on Windows 11 — the table is a record, not speculation.
