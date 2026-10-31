# CHANGELOG

This project follows semantic versioning. During `0.x`, breaking changes are listed here with migration notes.

## 0.18.6 — 2026-10-31

**`npm i -g @zhiliangtech/deskshell` 现在装到的就是最新版（0.18.6），公共 npm 通了。**

### 怎么通的

账号是 `auth-and-writes`，但认证器只绑了 passkey/security key，出不了 6 位码，
所以 `--otp` 这条路走不了。换 **Automation token** 发布：

```bash
NPM_TOKEN=npm_xxx node scripts/publish-npm-public.ts --apply
# 或 node scripts/publish-npm-public.ts --apply --token-file .token
```

token 写进临时 npmrc（600），只用于这一次 publish，结束即删。

### 途中两个坑（都记下来，免得再踩）

1. **`execFileSync("npm.cmd")` 在 Windows 抛 EINVAL** —— 表现为"未登录"和"发布失败(空)"，
   和白屏报错差不多没用。已改走 `shell: true`。
2. **`E409 Cannot publish over previously staged version`** 不是"要去网页批准"。
   npm 上传后有一段处理时间，这期间重发同版本会 409，`npm stage list` 还显示"没有暂存版本"——
   我只看了 409 的字面意思就下了"需要网页批准"的结论，那是错的。等一分钟再看，0.18.5 自己就上架了。

### 实测（2026-10-31）

```
registry: versions = 0.0.0-stage, 0.10.0, 0.18.5, 0.18.6 ; dist-tags.latest = 0.18.6
npm i -g @zhiliangtech/deskshell@latest   → 0.18.6
deskshell mcp install --print             → 指向已安装且存在的 packages/mcp/server.ts
```


## 0.18.5 — 2026-10-31

### 修了发布脚本里的一个 Windows 坑（这才是「未登录 + 发布失败(空)」的真因）

`execFileSync("npm.cmd", …)` 在 Windows 上会直接抛 `EINVAL`（Node 20 起，`.cmd` 必须有 shell 才能执行）。
症状极具误导性：

- `npm whoami` 那一步失败 → 脚本报 **「未登录」**，哪怕你刚 `npm login` 成功；
- `npm publish` 那一步失败 → 错误对象里没有 stdout/stderr → 打出 **「发布失败：」** 后面一片空白。

现在：Windows 上走 `shell: true`，并且失败时至少把错误码或异常信息打出来。跑一次就能看到真实原因。

### 顺带

- `--otp` 改成 `--otp=<code>`（npm 文档的形式），没有 OTP 时也先试一次，被 2FA 挡住才提示补码。
- 登录状态、公共 npm 上的现有版本、以及"卡在哪一步"都在同一次输出里。

**当前真实状态**：`npm whoami` → `zhiliangtech` ✓；`npm publish` → `EOTP`（账号开了 auth-and-writes，发布必须带实时 6 位码）。
公开 registry 上仍是 `0.10.0`，本地的 `0.18.5` 已发到 GitHub Packages + Release。


## 0.18.4 — 2026-10-31

为公共 npm 发布做体检时，抓到两个"装上就是坏的"问题（不是文档问题，是包的问题）：

1. **`apps/mcp/` 没被打进包里。** `deskshell mcp install` 会 `import ../apps/mcp/install.ts`，
   而 `files` 白名单里没有它 —— 上一版发出去的话，装完跑这个命令直接模块找不到。已加进 `files`。
2. **MCP `serverInfo.version` 写死成 `0.13.0`**，从 0.13 到 0.18 一路没变，客户端看到的版本是假的。
   现在从 `package.json` 读，读不到才回 `unknown`。

验证方式不是"读代码觉得对"，而是**把打包产物真的装一遍**：

```
npm pack → npm i -g --prefix .demo/gtest <tgz>
mcp install --print        → 指向已安装的 server.ts（存在）
MCP initialize + tools/list → serverInfo.version=0.18.4，4 个工具
```

公共 npm 这一步仍停在"需要维护者凭据"：本机没有 `~/.npmrc`、没有 token，`npm publish --dry-run`
到 registry.npmjs.org 已经通过（62 个文件、87.4 kB、shasum 正常），只差登录 + OTP。


## 0.18.3 — 2026-10-31

`docs/install.md` 第 5 节从"猜"改成"实测"：公共 registry 上 `@zhiliangtech/deskshell` 的 `latest` 是 **0.10.0**（2026-10-29），
新版本在 GitHub Packages 与 release 资产里。往前有两条路，都写清了：

- 本机：`node scripts/publish-npm-public.ts` 先体检，`--apply --otp <6 位>` 真发；
- CI：配一次 `NPM_TOKEN` secret，`publish.yml` 的 `npm-public` 作业就会在每次 `v*` tag 自动发——没配这个 secret，那个作业整段跳过，这就是 latest 停在 0.10.0 的原因之一。

## 0.18.2 — 2026-10-31

修一个被 CI 抓到的真实问题：`mcp-install-test` 把 Windows 的目录布局写死了，
在 Linux/macOS 上（Claude 配置在 `Library/Application Support/Claude`）判定就错，
于是 `regress` 在 CI 上 52/53，publish workflow 连带失败。

- 测试改成用 `path.dirname(plan("claude", home).file)` 造目录，跟实现同一套推导，不再硬编码。
- 本地是 Windows，所以这个问题只有在 CI 上才暴露——0.18.1 的 tag 是红的，记在这里，不掩盖。

    regress 53/53（本地 Windows）
    ci/publish 在 0.18.2 上重跑

## 0.18.1 — 2026-10-31

`mcp install` 之前会往一个不存在的客户端目录里写配置——写成功了，但用户打开客户端什么也看不到。现在先判断客户端在不在：

    没找到 claude 的安装目录（<home>）。
    先把客户端装上，或者确认路径没错；就是要写的话加 --force。

退出码 2，不写任何文件。测试补了 2 条（装了 / 没装）。

## 0.18.0 — 2026-10-31

三件"需要外部输入"的事，全部做成**你自己花几分钟就能验证**的形态。

### 新增：MCP 一条命令接入

    deskshell mcp install --client claude     # 合并进 %APPDATA%\Claude\claude_desktop_config.json
    deskshell mcp install --client cursor     # ~/.cursor/mcp.json
    deskshell mcp install --client claude --print   # 只看不改

合并而不是覆盖：别人已有的 MCP server 一个不动，写前备份，重复跑幂等，坏 JSON 报错不覆盖。`scripts/mcp-install-test.ts`（15 条）把这些都钉住了。

### 新增：R0 搬到别的机器上复算

    R0_SSH_HOST=your-box R0_SSH_USER=root node scripts/r0-remote.ts

打包 → 上传 → 远端跑文件面与 UI 面两套基准。e2b / daytona / trycua 的盒子都能用，只要 ssh 能进；没设环境变量就干净跳过并说明缺什么。

### 新增：把别人的工具放进同一把尺子

- `scripts/r0-adapter-template.ts`：适配器骨架，只填 `apply` / `undo` / `journalLines` / `snapshot` 四个空。
- `docs/r0-compare`（中英）：说清三种常见作弊（自己 rm -rf 重建、拿动作条数冒充审计、只跑成功场景）为什么会被基准当场揭穿，以及 e2b / daytona / trycua / 自己的 Docker 各自缺什么。

### 纠正：公共 npm 的真实状态

实测 registry：`@zhiliangtech/deskshell` **已经有 0.10.0，`latest=0.10.0`**（2026-10-29 发布），`0.0.0-stage` 是更早的占位。之前文档里"公共 npm 不可用"是错的，已改。发新版本需要 `npm login` + OTP：

    node scripts/publish-npm-public.ts                  # 一次说清卡在哪
    node scripts/publish-npm-public.ts --apply --otp 123456

OTP 只在进程内使用，不落盘。

### Evidence

    regress 53/53（新增 mcp.install 15 条、r0.remote 跳过路径）
    文档站 36 页（新增 r0-compare 中英各一页）

## 0.17.0 — 2026-10-31

README 第一屏终于有"当场跑出来的画面"，而不是一张过期的截图。

### Added

- **`scripts/make-terminal-svg.ts`**（`npm run render:terminal`）：把 30 秒 demo 的**真实输出**渲染成 SVG 终端截图。时间戳在渲染前抹掉，所以图是确定的、可复现的；改代码重跑一次，图就跟着变。
- **README 第一屏**（中英）放上这张图，并补一张 R0 对比表：文件面 100/100/100（15 次注入）· UI 面 100%（5 次注入，含"拒绝执行"这一类）。
- `scripts/terminal-svg-test.ts`（7 条）：渲染能跑、图里有失败/回滚/逐字节一致、是合法 SVG、时间戳已抹掉。

### Changed

- demo 的失败行改成说人话（`后置断言没通过（故意的）`），不再把整段断言 JSON 连绝对路径糊在终端里；撤销行的绝对路径也换成相对形式——截图因此从 89 字符降到可读范围。

### Evidence

    regress 51/51（新增 terminal.svg 7 条）
    docs/assets/thirty-seconds.svg（25 行真实输出，5.6 KB）

## 0.16.1 — 2026-10-31

把不可逆闸门从"只有报错"补成"能确认"。

### Added

- **`--ask` 在交互终端里会问一次不可逆步骤**：`有 N 步不可逆（撤不回来），确认执行？[y/N]`。拒绝则整单不执行。
- 闸门拒绝的退出码从 1 改成 **2**（"等你确认"不是"程序出错"，和 `--ask` 取消保持一致），JSON 模式下 `error: "needs-confirmation"`。
- `scripts/cli-irreversible-test.ts`（9 条）：非交互必须显式 `--allow-irreversible`、被拒时文件一个字节不动、确认后照常执行、`preview` 永不需要确认。
- 文档 `undo-and-trust` 补「当一步撤不回来」（中英）。

### Evidence

    regress 50/50（新增 cli.irreversible 9 条）
    CLI 实跑：拒绝 → exit 2 且 b.txt 未删、a.txt 未写；确认 → 两步都生效

## 0.16.0 — 2026-10-31

不可逆动作不再被假装成"可撤销"：该拦的拦在动手之前。

### Added

- **动作标记 `irreversible`**：`ui.invoke` 这类撤不回来的步骤可以自己声明。内核会
  ① 在 `preview.summary.irreversible` 里计数；② **在动手之前整单拒绝**，除非显式确认
  （CLI `--allow-irreversible` / MCP `allowIrreversible: true`）。
- 协议补 `actionOptional` 清单（`risk / pre / post / undo / irreversible`），spec 与常量同步，冻结测试 24/24 仍绿。
- `scripts/irreversible-test.ts`（7 条）：拒绝时点名是哪一步、拒绝发生在动手之前（文件没被写、日志没产生）、确认后照常执行。

### Changed — R0-UI 从 80% 到 100%，但定义变了

现在它量的是"**该撤的撤了、该拦的拦住了**"：

```
R0-UI 状态归零   100.0%（5 次注入）
R0-UI 回滚       100.0%
正常路径撤销后一致：3/3
```

`invoke-button` 归零的方式不是"撤回"，而是"内核拒绝执行，状态一个字节都没动"。把这两种归零混成一个数会骗人，所以文档里写清了判据。

### Evidence

    regress 49/49（新增 irreversible 7 条）
    R0 文件面 100/100/100 · R0 UI 面 100%（含"拒绝执行"这一类）
    协议冻结 24/24

## 0.15.0 — 2026-10-31

R0-UI 从 40% 提到 80%：`ui.type` 现在真的能撤销了。

### Added

- **协议新增撤销种类 `ui.value`**：`{window, selector, value}` —— 把**读到的前值**写回去，`null` 表示"控件本来没有值"。`spec/protocol-v0.json`、`protocol.ts`、`types.ts`、`executor.ts` 同步，协议冻结测试 24/24 仍绿。
- **驱动原语 `setValue`（可选）**：Windows 驱动实现（ValuePattern；不支持时退回"聚焦 + 全选 + 粘贴/删除"）。已在真实 WinForms 窗口上验证写入、读回、清空。
- 基准 `type-into-field` 改用 `ui.value` 撤销：**R0-UI 状态归零 40% → 80%**，正常路径撤销一致 1/3 → 2/3。

### Documented — 剩下那 20% 不是漏做

- `ui.invoke` 撤不回来：按钮按下去就是按下去了。对它正确的做法是动手前确认（preview + 人点头），不是 undo。把 `invoke` 重新定义成"需确认"之前，UI 侧的安全上限就不是 100%。
- `null` ≠ `""`：往初始为 `""` 的控件写回 `null` 会停在 `null`。基准第一版就这么把自己判低了 20 分——**写回你读到的值**。

### Evidence

    regress 48/48
    R0 文件面：100/100/100（15 次注入）· 正常路径 4/4
    R0 UI 面：80% 状态归零 · 回滚 100% · 正常路径 2/3

## 0.14.0 — 2026-10-31

R0 扩到 UI 面。结论不好看，但它是真的。

### Added

- **`scripts/recovery-bench-ui.ts`（`npm run r0:ui`）** —— 用 mock 窗口跑同一套注入矩阵，量的是**状态**（窗口几何 + 控件值 + 可用性），不是字节。

```
R0-UI 状态归零   40.0%（5 次注入）
R0-UI 回滚       100.0%
正常路径撤销后一致：1/3
```

- 文档 `recovery` 页新增「UI 那一面」一节（中英），把 40% 和缺口一起写出来；README 的 R0 段也直接写这个数字。

### The gap this exposes

`window.move` 有撤销种类，`ui.type` 与 `ui.invoke` **没有**——skill 只能写 `noop`，等于"打进去的字、按下的按钮撤不回来"。所以现在诚实的说法是：**文件动作可撤销；UI 动作还不行。**

修法已经有名字：加 `ui.value` 撤销种类 + 驱动层 `setValue` 原语，并且必须给真实 Windows 驱动实现（不能只给 mock）。这条不做完，不会把 40% 改成 100%。

### Evidence

    regress 48/48（r0.ui 把当前数字钉成基线，改动会让它变化）
    R0 文件面：100/100/100（15 次注入）· 正常路径 4/4
    R0 UI 面：40% 状态归零 · 回滚 100% · 正常路径 1/3

## 0.13.2 — 2026-10-31

把"能跑"变成"一句话能跑"：三条命令、三条链接、一份不说谎的对外口径。

### Added

- **npm 短别名**：`npm run demo` / `npm run r0` / `npm run mcp`（外加 `npm run r0:negative`）——不用记路径。
- **文档首页三条命令**（中英），每条都注明"声称一旦不成立就让构建变红"的对应测试。

### Changed

- **`outreach/STATE.md` 更新到 0.13.1 事实**：regress 43/43 → 47/47，latest 0.11.0 → 0.13.1，文档站 15 页 → 17 页；新增「三根支柱」一节（三条命令 + 现在的事实）；「不能说的话」补两条——R0 没跑过别的方案、MCP 没真实客户端证据。

### Evidence

    regress 47/47
    npm run demo / npm run r0 / npm run mcp 实跑通过
    文档站 34 页

## 0.13.1 — 2026-10-30

把「别人能跑」补成两件可执行的事。

### Added

- **R0 适配器接口**：`scripts/recovery-bench.ts --adapter <file>`。任何工具实现 `apply / undo / journalLines` 三个方法就能用同一套夹具量。模板与说明写进 `docs/recovery.md`。
- **反向验证**：`scripts/r0-adapter-naive.ts` 是一个「只写不回滚、没有日志」的对照实现，同一套夹具跑出来 R0-残渣 0%、可追溯 0%、退出码非零；`scripts/r0-negative-test.ts` 断言这件事（5/5）。**一个永远过的基准是广告，不是测量。**
- **MCP 客户端接入**：`docs/mcp.md` 补 Claude Desktop（`%APPDATA%\Claude\claude_desktop_config.json`）与 Cursor（`.cursor/mcp.json` / `~/.cursor/mcp.json`）的确切路径，以及 30 秒四步验证法。

### Evidence

    regress 47/47
    R0 正向 100/100/100（15 次注入）· 反向 0/0/0（证明会判人失败）
    文档站 34 页

## 0.13.0 — 2026-10-30

三根支柱补齐：能看懂的瞬间、能复现的证明、能接进来的接口。

### Added

- **30 秒 demo**（`apps/cli-demo/thirty-seconds.ts`）：四步成功、第五步失败、全部退回、目录逐字节一致、5 条日志（含失败那步）。三条不变量由 `scripts/thirty-seconds-test.ts` 钉住。README 第一屏直接贴真实输出（中英）。
- **MCP adapter**（`packages/mcp/server.ts`）：手写 stdio JSON-RPC，零依赖，四个 tool —— `deskshell_skills` / `deskshell_preview` / `deskshell_apply` / `deskshell_undo`。`scripts/mcp-test.ts` 起真进程按客户端协议对话 14 条。
- R0 基准新增 `move-into-new-dir` 场景，文档 `recovery` / `mcp` 两页（中英）。

### Fixed — demo 抓到两个真 bug

- **顺手建的目录撤销后留空壳**：`fs.move` / `fs.write` 会 `mkdir -p` 父目录，但撤销只把文件搬回去，目录留在原地。现在执行时记录 `createdDirs`，撤销按由深到浅删空目录（非空就留着）。R0 残渣因此从 93.3% → 100%。
- **失败自撤被静默跳过**：`execResult` 声明在 `try` 内部，`catch` 里引用它抛 `ReferenceError`，而那个 `catch` 又把错误吞掉 —— 结果是"回滚看起来跑了，失败那步的副作用却没撤"。声明提到 `try` 外后修复。

### Evidence

    regress 46/46
    demo 5/5 · MCP 14/14 · R0 15 次注入 100/100/100 · 正常路径 4/4 逐字节还原
    文档站 34 页（17 EN + 17 中文）

## 0.12.0 — 2026-10-30

方向校准：不再往"更聪明的助手"上加功能，开始树"可复现的证明"。

### Added

- **`scripts/recovery-bench.ts` —— R0 指标**：失败后副作用归零率。三个合成场景 × 逐步失败注入，量三件事：残渣是否为零（逐字节）、失败前已执行的步骤是否全部撤销、日志里每步是否带 `taskId`/`actionId`/时间戳/状态。
- 文档新增 `recovery` 页（中英），把指标定义、当前数字、以及它抓到的问题一起写出来。

### Fixed — 指标上线第一天就抓到的洞

- **失败的那一单事后无法指认**：某步失败时，内核对日志文件写了 `failed` 记录，但 `RunReport.journal` 只收集成功条目，且报告里没有 `taskId`。现在 `RunReport` 带 `taskId`，失败条目也进账；R0-可追溯从 76.9% → 100%。

### Evidence

    R0-残渣     100.0%（13 次失败注入）
    R0-回滚     100.0%
    R0-可追溯   100.0%
    正常路径撤销后逐字节还原：3/3
    regress 44/44 · 文档站 32 页

## 0.11.0 — 2026-10-30

M09：把「外人 15 分钟写出第一个 skill」变成一条被测过的路径。

### Fixed — 两个只有"真装一遍"才会撞到的坑

- **`deskshell new` 往仓库里写**：以前它固定写 `./packages/skills/<name>`，装好包的用户根本没有仓库，结果文件散落在自己的目录里。现在默认写 `~/.deskshell/skills/<name>`（`DESKSHELL_SKILLS_DIR` 可覆盖），给本仓库贡献时才用 `--in-repo`。生成后直接打印下一步命令。
- **`deskshell undo --last` 报「需要一个正整数」**：新人最自然的写法反而不成立。现在 `--last` 不带值 = 撤销最近 1 个任务，`--last 3` 行为不变；错误提示也改成用法说明。

### Added

- **`scripts/onboarding-test.ts`** —— 干净环境实测：`npm pack` → 装进临时 prefix（离线）→ 在空目录里只照文档跑 `new → 改一处 → list → preview → apply → undo --last`，并验证「预览不写日志」「撤销后文件消失」「跑不存在的 skill 退出码非零且提示 list」。17 条断言。
- 文档新增「15 分钟写出第一个 skill」清单（中英），含预期输出与三个常见坑的对照表。

### Evidence

    regress 43/43
    onboarding 17/17（真装 tarball，真跑 CLI）
    文档站 30 页

## 0.10.0 — 2026-10-30

M08：一句话不只是挑个技能，而是带着参数进 plan。

### Added

- **`apps/shell/intent.ts`** —— 意图层：`skill.json` 里的 `intents`（triggers + args 槽位）→ 从中文句子抽参数。支持扩展名（`jpg`、`图片`→一组后缀）、天数（`30 天`、`一周`）、路径（引号、`下载文件夹`、`从 src 到 backup`）、前缀（`前缀 trip`）。返回 `confidence` / `missing` / `question`，缺槽位就问，不猜。
- **`ModelBackend` 接口** —— 默认 `RuleBackend`（离线、确定性、可解释）；`FixtureBackend` 是同一契约下的固定问答实现，测试用它证明接缝可换。以后接模型只换实现，不换契约。
- 5 个 skill 补 `intents`：`dedupe-folders`、`screenshot-organize`、`log-archive`、`rename-batch`、`sync-mirror`。
- `apps/shell/cli.ts` 新增 `plan` 命令，`preview`/`apply` 支持 `--args`；`core.ts` 的 `preview`/`apply` 接受参数并原样传给 `skill.plan`。
- 桌面壳面板改走意图层：先 plan（显示置信度与命中原因），缺参数时把追问显示出来并禁用执行。

### Evidence

    regress 42/42
    intent 23/23（含"参数真的改变 plan"：30 天 vs 90 天步数不同，2 天日志未被动，撤销逐字节回原状）
    shell ui 11/11（新增 plan=log-archive、planDays=30 两条）
    文档站 30 页

## 0.9.0 — 2026-10-30

M07：桌面壳 MVP —— Ctrl+Alt+Space 一句话，先看账单，再决定动不动手。

### Added

- **`apps/shell/core.ts`** —— 壳的核心逻辑（与 UI 无关）：技能扫描、一句话匹配（名字/描述关键词打分，中文按两字片段弱命中）、`preview`（只读）、`apply`、`cancel`（显式什么都不做）。
- **`apps/shell/cli.ts`** —— JSON 胶水：`skills / match / preview / apply / cancel`，一行一个 JSON。
- **`apps/shell/ui.ps1`** —— WinForms 面板：`RegisterHotKey(Ctrl+Alt+Space)`，输入一句话 → 候选列表 → 能力申请单 + 步骤 + 汇总 → 执行 / 取消。没有匹配时直接说没有，并列出可用技能。
- **`scripts/shell-test.ts`** —— 14 条：命中 / 名字直输 / 歧义多候选 / 不相关不瞎猜 / 预览出能力单 / 取消零变化 / 预览不写日志 / 执行有变化 / 撤销回原状。
- **`scripts/shell-ui-selftest.ts`** —— 9 条真机自检：起窗、注册热键、匹配、预览、取消，然后断言夹具目录没多也没少、没有 `.deskshell` 日志。非 Windows 明确 skip。
- 文档新增 `docs/shell.md` 与中文镜像。

### Changed

- 回归从 39 项扩到 **41 项**（新增 shell.core、shell.ui）。

### Evidence

    regress 41/41
    shell core 14/14
    shell ui 9/9（真机：hotkey=True、10 个技能、preview 4 步、2 项能力、cancel=True）
    文档站 30 页（15 EN + 15 中文）

## 0.8.0 — 2026-10-30

M06：Linux 从"计划中"变成"CI 实测能用"。

### Added

- **`packages/drivers/linux/driver.ts`** —— X11 窗口级驱动：`wmctrl` 列窗口 + `xdotool` 做几何/激活/输入/按键/移动。依赖缺失时**拒绝构造并打印要执行的命令**；控件级操作（`invoke` / 按 selector 的 `click`）明确报"不支持"，不假装成功（X11 没有可访问性树，那要 AT-SPI2）。
- **`scripts/linux-driver-smoke.ts`** —— 在 Xvfb + openbox 里起窗口，验证枚举/读树/移动/还原/输入/按键，以及"控件级操作必须报不支持"。
- **CI 新增 `linux-ui` 作业** —— apt 装 `xvfb xterm xdotool wmctrl openbox`，`xvfb-run` 跑冒烟；`contract-test` 在 ubuntu 上真跑。

### Fixed

- **并发任务 id 碰撞**：`taskId` 原本是 `task-<毫秒>`，并行执行时两个任务可能同毫秒启动拿到同一个 id，日志里分不开、并行撤销会串。现在加了随机后缀。这个 bug 是 CI 的 node 24 作业第一次跑出来才暴露的。

### Evidence

    CI run 32 · linux-ui success + regress(node 22/24) success
    smoke 10/10（含几何容差判定：WM 装饰与 xterm 字符格会让几何不等于请求值）
    contract 在 ubuntu 上 13/13（非跳过）
    本地 regress 39/39

## 0.7.0 — 2026-10-30

M05：公开 skill 从 7 个补到 10 个，每一个都有端到端测试与逐字节撤销证明。

### Added — 3 个真实场景 skill

- **`dedupe-folders`** —— 按内容哈希（前 8 MiB + 大小）找重复，保留最早的一份，其余移入 `.trash/`。撤销全部还原。
- **`screenshot-organize`** —— 截图按 `YYYY/MM/` 归档并加时间前缀；只碰文件名含 `screenshot` / `截图` / `snipaste` 的图片。
- **`sync-mirror`** —— 把 `src/` 镜像到 `mirror/`：缺失或变更的文本文件写过去，多余文件移入 `.trash`，二进制按设计跳过。

### Fixed

- **目录层级撤销不干净**：`screenshot-organize` / `sync-mirror` 原先只对叶子目录生成 `mkdir`，撤销后中间层（如 `2026/`）残留，做不到逐字节还原。改为逐级建目录、只为不存在的层级生成动作。
- `undo-coverage` 的用例扩展到 10 个（8 个真跑 + 2 个 GUI 带理由跳过）。

### Evidence

    regress 39/39
    undo coverage 8/8 passed, 2 skipped（逐字节一致）
    new skills 12/12（行为 + 撤销一致性）
    协议冻结 24/24 · v0 兼容 7/7 · ask 8/8 · m04 9/9

## 0.6.0 — 2026-10-30

M03：能力授予变得可见，撤销从"步数对得上"升级为"逐字节对得上"。

### Added

- **`deskshell run <skill> --ask`** —— 执行前逐项确认能力，显示 id 与人话理由。交互终端逐条问；管道输入每行一个 `y`/`n`（CI 就这么测）。任一拒绝 → 整单取消、退出码 2、**零副作用**（不写日志、不动文件）。空输入等同拒绝。
- **`scripts/undo-coverage-test.ts`** —— 对每个公开 skill：拍快照（路径 + 每文件 sha256）→ apply → undo → 再比快照，要求逐字节一致。当前 5 个文件类 skill 全过，2 个 GUI 类**带理由**跳过（不静默略过）。
- **`scripts/ask-test.ts`** —— 8 条契约：同意可跑、拒绝即停、无输入即拒、拒绝时无副作用、`--ask` 优先于 `--grant`。

### Changed

- 回归从 35 项扩到 **37 项**（新增 capability.ask、undo.coverage）。
- `docs/undo-and-trust`（中英）补"撤销覆盖率"与"逐项确认能力"两节，直接贴实测输出。

## 0.5.1 — 2026-10-29

M01 验收（"陌生人在 Windows 上 10 分钟跑通"）挖出来的两个真问题，都已修掉。

### Fixed

- **已安装的包在 Node 22.23.4 上直接崩溃（exit -1073741819）。** 启动器 `bin/deskshell.mjs` 用 `fs.cpSync` 把运行时镜像到用户缓存，在 Windows + Node 22 上会在拷贝 `bin/` 时触发访问违例，没有任何报错信息。换成手写递归拷贝（`readdir` + `copyFileSync`）后正常。0.5.0 的 tarball 与 GitHub Packages 版本都受影响，0.5.1 是替换版。
- **安装路径依赖 github.com。** README 之前给的 `npm i -g <releases/download/...>` 在部分网络下连不上。新增 `install.ps1`：版本信息与安装包都走 `api.github.com`（可达），匿名也能下，无需 token。

### Added

- `install.ps1` — 检查 Node/npm 版本 → 经 API 取最新 release 资产 → `npm i -g` → 自动跑 `doctor`；支持 `-Prefix` 装到指定目录（干净环境验收用）。
- `docs/install.md`（中英）—— 三条安装路径、常见失败与判断方法。

## 0.5.0 — 2026-10-29

Operating a system you can leave running: batch undo, a journal that survives growth, previews that state the cost, and a recorder driven by events instead of polling.

### Added

- **`deskshell undo --last N` / `--since 30m|2h|1d`** — batch undo, newest first. One line per task, one exit code; a failed undo stops that task only.
- **Journal rotation** — past 5 MiB the journal becomes `journal-<timestamp>.jsonl` and a fresh one starts. `load()` reads rotated files plus the current one in time order; undo rewrites only the file holding the affected entries, so statuses stay right without duplicating rows. Override with `DESKSHELL_JOURNAL_MAX_BYTES`.
- **Preview summary** — before touching anything, `run` prints what the plan costs:

  ```
  汇总：新建 3 · 移动 10 ｜ 可撤销 13/13 ｜ 风险 low 13 / medium 0 / high 0
  ```

  Non-undoable steps are counted and warned about separately. Available as `summary` in `--json`.
- **Recorder is event-driven** — focus comes from `AddAutomationFocusChangedEventHandler`, window opens from `AddStructureChangedEventHandler`, clicks from the existing `WH_MOUSE_LL` hook, all pumped through `Application.DoEvents()`. A 15-second session produced 8 meaningful events where polling emitted ~50 duplicate focus rows. `-Poll` forces the old behaviour, and event-registration failure falls back automatically.
- **Draft skills get a real window scope** — the generator now writes the recorded window names (e.g. `Notepad`) instead of the `recorded` placeholder, so a draft actually passes the policy layer and can be previewed.

### Fixed

- Recorder `.ps1` files are written as UTF-8 **with BOM**; PowerShell 5.1 reads BOM-less scripts as ANSI, which silently corrupted non-ASCII comments and produced parser errors.
- Duplicate window-open rows: structure events fire several times per window, now de-duplicated by title + pid.

### Evidence

- `scripts/regress.ts` → 33 checks
- undo range 6/6 · journal rotation 7/7 · preview summary 9/9 · recorder modes 8/8
- Real session: 15 s recording → 8 events (5 focus / 3 window-open) → 2 clicks → draft with 2 steps → `--mode preview` accepted

## 0.4.0 — 2026-10-29

Hardening the guarantees, plus the operational surface a real user needs.

### Security

- **UI window scope is enforced.** A skill declaring `ui.input` with scope `Notepad` can no longer drive `Calculator`; `checkAction` now matches the action's window against the declared scope (regex, case-insensitive). Contract test `ui.scope` covers both the denial and the allowed case.
- **Undo refuses to overwrite a file that changed.** `fs.write` steps record the sha256 of what was written; undo compares it and refuses when the file was edited afterwards. Contract-level test `undo-guard` also asserts the journal does not lie: a refused undo is not marked `rolled-back`.
- **Property-based path tests.** `scripts/policy-fuzz.ts` generates 2000 adversarial paths plus 10 known vectors (`C:\Windows`, UNC, `/etc/passwd`, `..`, mixed separators) and asserts every escape is rejected, while 500 legitimate paths still pass.

### Added

- **`deskshell run a b c --parallel`** — concurrent skills, shared journal, one failure does not stop the others. `scripts/parallel-test.ts` proves both the happy path and failure isolation.
- **`deskshell history`** — task list with skill, step count, duration and state.
- **`deskshell show [taskId]`** — full timeline of one task, including each step's undo kind.
- **Journal entries carry `skill` and `hash`**, so history is readable and undo can detect external edits.
- **`deskshell add` installs into `~/.deskshell/skills`** (override with `$DESKSHELL_SKILLS_DIR`), outside the package, so upgrades no longer reset user skills. Same name in the user directory wins over the built-in one.
- **Docs**: new `internals` page (kernel flow, policy table, failure semantics, journal schema, parallel model), macOS bridge command list on the drivers page, and a 5000-file benchmark section. 13 pages per language.

### Fixed

- `undoLastTask` marked **every** entry of the task as `rolled-back` even when an undo failed; it now marks only the steps that actually rolled back. Same bug class as the 0.3.0 self-undo fix: the journal must never report a rollback that did not happen.

### Changed

- Fixture skills declare real window scopes (`Notepad|记事本`, `Edge|Chrome|…`) instead of placeholders, because placeholders are now rejected — which is the point.

### Evidence

- `scripts/regress.ts` → 29 checks green
- contract 13/13 · snapshots 3/3 · parallel 7/7 · policy fuzz 5/5 · undo guard 3/3
- benchmark: 1000 files 0.7–0.9 ms/step; 5000 files 0.8 ms/step, journal 424 B/step

## 0.3.0 — 2026-10-29

Hardening and reach: symlink escapes are blocked, three new skills ship with tests, and the kernel gets a performance baseline.

### Security

- **Symlink / junction escape is now rejected.** Path checks run twice: lexically (`..` rejected) and by real path. A junction or symlink inside the task root that points outside is refused before execution. `isInsideReal()` resolves the nearest existing ancestor, so the target does not need to exist to be checked.
- New contract test `symlink.escape` creates a junction to an outside directory, attempts a write, and asserts both refusal and that nothing leaked outside.

### Fixed

- **A failing action no longer destroys neighbouring data.** The kernel used to run the failing action's own undo unconditionally. When the failure happened at the pre-assertion stage, that undo (`move(to → from)`) would move a pre-existing destination file out of the way — data loss. Now self-undo only runs when the action actually entered its execution phase, and only when its effect is verifiably present (`selfUndoSafe`). Covered by `rename-batch` collision test.

### Added — three skills

- **`photo-sort`** — archives images into `YYYY-MM` folders by mtime (no EXIF dependency). 12-file fixture: 3 month folders, undo restores all 12 and removes the folders. Snapshot included.
- **`log-archive`** — moves `.log` files older than 30 days into `archive/YYYY-MM/`; nothing is deleted. Supports `now` / `maxAgeDays` for deterministic runs.
- **`rename-batch`** — zero-padded sequential renames with a `path.absent` pre-assertion, so a name collision fails the batch and rolls it back instead of overwriting.

### Added — tooling and docs

- **`scripts/bench.ts`** — 1000-file benchmark. Measured: plan 44 ms (1002 steps), apply 737 ms (0.7 ms/step), undo 727 ms, journal 387 KB (396 B/step), heap +7 MB.
- **Docs**: `recipes` page (five runnable scenarios with real output) and `faq` page, in English with Chinese mirrors. Docs site is now 12 pages per language.
- `scripts/photo-sort-test.ts`, `scripts/new-skills-test.ts` (8 assertions), `scripts/make-photo-fixture.ts` wired into the regression suite — now **24 checks**.

## 0.2.0 — 2026-10-29

The "make it a real project" release: bilingual docs, brand, packaging, and macOS click parity.

### Added

- **Docs site is now bilingual**, English first: `docs/*.md` (10 pages, including a generated Skills catalog) and `docs/zh-CN/*.md`. Every page carries a language switch; `site/index.html` redirects to `/en/`.
- **Generated Skills page** — built from `packages/skills/*/skill.json` (name, version, description, capabilities with reasons, platforms). Internal test fixtures are hidden but counted.
- **Sidebar search** on the docs site — 18 lines of vanilla JS, no dependencies.
- **macOS coordinate clicks** — `MacDriver.clickAt(x, y)` posts CGEvent mouse events; `click()` now falls back to clicking the element's centre when AXPress is refused. Verified on hardware: Calculator `7 × 8 = 56` via coordinate clicks, plus a fallback case where AXPress is rejected and the synthetic click still lands on centre.
- **Packaging** — scoped name `@zhiliangtech/deskshell`, `files` allowlist, `repository`/`homepage`/`bugs`, `bin/deskshell.mjs`, a launcher that works around Node's refusal to strip types under `node_modules`. `npm pack`: 47 files, 46 kB.
- **Community files** — `SECURITY.md` (scope statement: an agent deleting files after `fs.write` is granted is expected behaviour, not a vulnerability), `CODE_OF_CONDUCT.md`, `.editorconfig`, Dependabot config.
- **Distribution channels** — published to GitHub Packages (`@zhiliangtech/deskshell@0.2.0`, verified by a real `npm install` + `deskshell version`), and a release tarball for auth-free installs. npmjs.com is unreachable from some networks (website 403, registry API fine), so the public registry publish is pending a token.
- **CI matrix** — Node 22 and 24, `cancel-in-progress` concurrency, 10-minute timeout, read-only permissions.

### Changed

- `engines` is now truthful: `>=22.18.0 <23.0.0 || >=23.6.0` (type stripping is unflagged only from those versions).
- README (EN and zh-CN) gained an Install section and dropped the "no coordinate clicks on macOS" limitation.

### Fixed

- Docs described macOS coordinate clicks as unimplemented long after the bridge shipped `click --x --y`.

### Known limits

- No Linux driver (AT-SPI2) yet.
- Recorder polls at 300 ms and captures left clicks only.
- `deskshell add` installs into the runtime mirror when run from an installed package, not into the project directory.

## 0.1.0 — 2026-10-29

First usable version: protocol v0 + kernel + drivers + CLI + docs + regression suite.

### Protocol v0

- Capabilities (scope + plain-language reason); an ungranted capability rejects the whole task.
- Actions: `fs.mkdir` / `fs.move` / `fs.delete` / `fs.write` / `ui.invoke` / `ui.click` / `ui.type` / `window.move`.
- Assertions: `path.exists` / `path.absent` / `file.count` / `ui.value` / `window.rect` / `window.exists` / `ui.exists`.
- Undo: `fs.move` / `fs.rmdir` / `fs.restore` / `window.move` / `noop`.
- Journal: append-only JSONL with `ok` / `rolled-back` / `failed`.
- Invariants: no path escape, every action undoable, failure rolls back, zero model dependency, every action covered by a declared capability.

### Kernel

- `preview / apply / undo / undoAll / undoTask`.
- On failure: undo the failing action's own side effects first, then roll back completed steps in reverse.
- Failures are recorded in the journal (`status: "failed"` + `detail`).

### Drivers

- Windows: UIA control tree, ValuePattern, Invoke/Select, coordinate click, window geometry, `WH_MOUSE_LL` click capture.
- macOS: native Swift AX bridge (36 ms window enumeration), control tree, focus, Unicode typing, AXPress, window move; `osascript` fallback when the bridge is absent.
- Mock: in-memory driver behind 11 contract tests.

### Skills and tools

- `downloads-cleanup`, `browser-tabs`, `tile-windows`, plus a scaffold example.
- Recorder: focus + mouse clicks + window-open events → draft skills with inferred assertions.
- `deskshell` CLI: `list / run / story / journal / undo / add / verify / doctor / version`.
- Docs site, JSON Schema, preview snapshots, 22-check regression suite.

### Known limits

- macOS driver was unverified at release time.
- Linux driver not implemented.
- Recorder polls at 300 ms; left clicks only.
- Undo covers files and window geometry; external side effects are rejected (`undo: null`).
