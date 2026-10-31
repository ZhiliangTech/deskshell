<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Install

Three ways in, in order of "least likely to fail on a hostile network".

## 1. Installer (recommended)

```powershell
irm https://raw.githubusercontent.com/ZhiliangTech/deskshell/main/install.ps1 -OutFile install.ps1
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
npm config set @zhiliangtech:registry https://npm.pkg.github.com
npm i -g @zhiliangtech/deskshell
```

Needs a GitHub token with `read:packages` in `~/.npmrc`. This is the channel to use if you already have npm configured for GitHub.

## 3. From source

```bash
git clone https://github.com/ZhiliangTech/deskshell && cd deskshell
node bin/deskshell.ts doctor
```

No build step: the CLI is TypeScript run directly by Node's type stripping.

## 4. From Git, no registry at all

Public npm has `@zhiliangtech/deskshell` but it is pinned at **0.10.0** (measured: `latest=0.10.0`); newer versions need the maintainer's 2FA approval. If `registry.npmjs.org` is slow, npm can install straight from the repo:

```bash
npm i -g github:ZhiliangTech/deskshell
npx github:ZhiliangTech/deskshell doctor      # one-shot, nothing installed globally
```

This uses `github.com` + Git, not the npm registry. Same for a release asset:

```bash
npm i -g https://github.com/ZhiliangTech/deskshell/releases/download/v0.9.0/zhiliangtech-deskshell-0.9.0.tgz
```

## 5. Maintainers: publishing when www.npmjs.com is unreachable

The npm **website** can be blocked while the **registry API** is fine. That is the normal case on some networks — check it instead of guessing:

```bash
node scripts/npm-token.ts --dry-run     # prints registry ping status
```

If the ping is 200, you can log in and get a token **without opening the website** (legacy registry auth):

```bash
NPM_USER=you NPM_PASS=*** NPM_EMAIL=you@example.com [NPM_OTP=123456] node scripts/npm-token.ts
```

It writes `//registry.npmjs.org/:_authToken` into `~/.npmrc` (mode 600) and prints only the first 8 characters. Then:

```bash
node scripts/publish-npm.ts              # scoped: @<your-npm-user>/deskshell
node scripts/publish-npm-unscoped.ts     # unscoped: deskshell (repo untouched, temp copy)
```

Both scripts bootstrap an npm CLI from the registry, so no local npm install is needed.

**Current state (2026-10-30):** the name `deskshell` on the public registry holds only a `0.0.0-stage` placeholder. npm 12 stages a brand-new package and requires a **2FA proof-of-presence approval** before the real version becomes visible, so a publish needs the one-time password at publish time:

```bash
NPM_OTP=<6 digits> NPM_NAME=deskshell node scripts/publish-npm-unscoped.ts
```

Until that approval lands, the supported channels are §1 (installer), §2 (GitHub Packages — 0.9.0, 0.10.0, 0.11.0 are live) and §4 (Git). `.github/workflows/publish.yml` publishes to GitHub Packages on every `v*` tag, skips versions that already exist, and only touches public npm when the `NPM_TOKEN` secret is set.

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
