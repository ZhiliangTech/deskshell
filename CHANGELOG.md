# CHANGELOG

This project follows semantic versioning. During `0.x`, breaking changes are listed here with migration notes.

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
