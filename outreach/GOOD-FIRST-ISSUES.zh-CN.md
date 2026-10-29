# 好上手的任务（Good first issues）

十二个任务，**范围已经划好、前置条件已经清空、每一个都以一条能跑的验收命令结尾**。这里没有任何一条需要先跟维护者"对齐设计"——这正是这张板子的意义。

任务全部来自 [docs/roadmap.md](../docs/roadmap.md) 里记录的缺口，以及 [STATUS.md](../STATUS.md) 那张"没做到的"表。如果某个功能的朴素版本已经上线，任务会明说，并把范围往前推一步，避免你花一个周末重做已经存在的东西。板上没有编出来的活。

- 仓库：`https://github.com/ciceroyang/deskshell` · MIT · Node `>=22.18`
- **零第三方运行时依赖**是硬约束，不是偏好。要加依赖，先走 RFC（见 [GOVERNANCE.md](GOVERNANCE.md)）。
- 协议 v0 冻结在 `spec/protocol-v0.json`。改 action / assertion / undo 的语义必须走 RFC；本板上的任务几乎都能在 v0 内完成。
- 第一次提 PR 的路径（装环境应该 30 分钟内搞定）：[CONTRIBUTING.md](../CONTRIBUTING.md) → `node scripts/regress.ts` → 从下表挑一个 → 带认领说明开 draft PR。

## 怎么认领

1. 用 [.github/ISSUE_TEMPLATE/bounty.yml](../.github/ISSUE_TEMPLATE/bounty.yml) 开一个 `bounty` issue（或直接在该任务的 issue 下留言），写清你认领第几号。
2. 维护者在 **48 小时**内回复：指派 mentor、确认范围没被别人占、提供你要的 fixture。
3. 在自己的分支上做。只改任务列表里列出的文件，不要顺手重写没让你动的文档。
4. 开 PR 时把验收命令和**真实输出**贴进描述。CI 绿 + 贴出输出，就是完整的评审门槛。

规模口径：**S** = 半天，**M** = 1–3 天，**L** = 约一周——按"已经跑过一次 `node scripts/regress.ts`"的人估。

## 任务总表

| # | 任务 | 建议标签 | 规模 | 领域 |
| --- | --- | --- | --- | --- |
| 01 | Linux AT-SPI2 驱动：`windows()` 与 `tree()` | `good first issue` `driver` `help wanted` | **L** | 驱动 |
| 02 | 多显示器与 DPI 坐标映射 | `bounty` `driver` `help wanted` | **M** | 驱动 |
| 03 | 录制器：右键、中键、滚轮、拖拽 | `bounty` `driver` `recorder` | **M** | 驱动 / 录制 |
| 04 | 从录制推断 `window.rect` 断言 | `bounty` `recorder` | **M** | 录制 / 内核 |
| 05 | 每步 dry-run 差异（`run --diff`） | `bounty` `kernel` | **M** | 内核 |
| 06 | 撤销时间线视图（`deskshell timeline`） | `good first issue` `kernel` | **M** | 内核 / CLI |
| 07 | 记住能力授权（`--ask --remember`） | `good first issue` `kernel` | **S** | 内核 |
| 08 | 文档站全文搜索 | `good first issue` `docs` | **M** | 文档 |
| 09 | 随机故障注入压测 | `good first issue` `testing` | **S** | 工程 |
| 10 | 新 skill：`screenshot-dedupe` | `good first issue` `skill` | **S** | skill |
| 11 | 新 skill：`browser-download-sort` | `bounty` `skill` | **M** | skill |
| 12 | 新 skill：`pdf-merge`（零依赖） | `bounty` `skill` `hard` | **L** | skill |

---

## 01 — Linux AT-SPI2 驱动：`windows()` 与 `tree()`

**标题：** `driver(linux): 用 AT-SPI2 实现 UiDriver.windows() 与 tree()`

**标签建议：** `good first issue` `driver` `help wanted` `platform: linux`

**问题背景.** `packages/drivers/` 下只有 `windows/`、`macos/` 和 `mock/`，没有 `linux/`。`scripts/verify-driver.ts` 里专门写了这个分支：`win32` 用 `WindowsDriver`、`darwin` 用 `MacDriver`，其余平台打印"当前平台暂无驱动实现"并以 0 退出。所以 Linux 上文件类 skill 全能跑，碰屏幕的全不能跑。驱动接口是冻结的，这也是这个任务"填空"而不是"设计"的原因。

**要改的文件与接口.**

- 新建 `packages/drivers/linux/driver.ts`，导出 `class LinuxDriver implements UiDriver`。
- 接口在 `packages/core/src/types.ts` 的 `UiDriver`：`windows()`、`tree(ref, depth)`、`invoke(ref, sel)`、`click(ref, sel)`、`type(ref, sel, text)`、`keys(ref, combo)`、`focus(ref)`、`bounds(ref)`。
- `scripts/verify-driver.ts`：补 `linux` 分支。
- `docs/drivers.md`：补 Linux 一行，按 macOS 那节的格式写"已验证 / 未验证 / 已知限制"。
- 参考实现：`packages/drivers/mock/driver.ts`（短、好读）和 `packages/drivers/macos/driver.ts`。

**第一个 PR 只做只读。** 只实现 `windows()` 和 `tree()`，输入类方法写成 `throw new Error("not implemented: <name>")`，让验证脚本把它们标成 `SKIP`——今天 `click()` / `invoke()` 就是这么处理的。只读驱动通过两项就是可合并的 PR；半残的输入驱动不是。

**验收标准.**

```bash
# 在带桌面会话（GNOME/KDE）且启用 AT-SPI2 的 Linux 上
node scripts/verify-driver.ts
# 期望：platform=linux
#       PASS windows()  <n> 个窗口，例如：<某个窗口标题>
#       PASS tree()     <窗口> → <n> 个节点
#       最后一行 "N passed, 0 failed"，未实现的方法全部列为 SKIP
```

```bash
node bin/deskshell.ts doctor     # 环境自检仍然 0 failed
node scripts/regress.ts          # 最后一行形如 "NN/NN passed"，失败数为 0
```

另外要求：`docs/drivers.md` 的 Linux 节要写清八个接口方法里哪些是硬件验证过的、哪些实现了但没验证、已知限制是什么（没有无障碍总线、Wayland 会话没开无障碍桥等）。

**规模估计：** L，约一周。三分之二的时间花在摸 AT-SPI2 总线和控件树形状上，不是在打字。

**我们提供什么.** 写过另外两个驱动的 mentor，在 issue 里答总线 / DBus 问题；首次推送后 48 小时内的评审；名字进 `CONTRIBUTORS.md` 的 *Driver* 一节，以及第一个支持 Linux 的版本发布说明。

**风险与注意.** 必须有真实桌面会话——无头容器里没有无障碍总线，"我 CI 上能过"在这里做不到，我们也不会要求你造假。先跑 `busctl --user list | grep -i atspi`；如果没有 `org.a11y.Bus`，先把桥加载起来（`NO_AT_BRIDGE=0`、`GTK_MODULES=gail:atk-bridge`）再判断驱动写错没有。**不要**在驱动里做权限判断，权限归 `packages/core/src/policy.ts`。

---

## 02 — 多显示器与 DPI 坐标映射

**标题：** `driver: 跨多显示器与 DPI 缩放的坐标映射`

**标签建议：** `bounty` `driver` `help wanted`

**问题背景.** 全仓搜 `dpi`、`scaling`、`devicePixelRatio`、`monitor` 一个命中都没有：所有驱动都假设"一块屏、一个缩放比"。`window.rect` 断言比较的是平台 API 返回空间里的矩形，`click(ref, sel)` 把目标解析成同一空间里的点。在混 DPI 的桌上（150% 笔记本屏接 100% 外接屏）这个假设就不成立了，点击会偏几十像素。**先复现再改**——具体错法取决于宿主进程是否 DPI-aware，把这一点定性出来本身就是交付物的一部分。

**要改的文件与接口.**

- `packages/drivers/windows/driver.ps1` / `driver.ts`：上报显示器布局，并把 DPI 感知说清楚。
- `packages/core/src/types.ts`：加一个**纯增量**能力（例如 `screens(): Promise<Screen[]>`）。增量可以，但不要改 `Rect` 或 `bounds()` 的语义。
- `scripts/verify-driver.ts`：新增 `screens()` 检查，逐块打印显示器边界与缩放比。
- 新测试脚本，沿用现有写法：`scripts/dpi-map-test.ts`。

**验收标准.**

```bash
node scripts/verify-driver.ts
# 期望新增一行 PASS screens()，逐块列出显示器边界与缩放；原有 windows()/tree()/focus() 不变
```

```bash
node scripts/dpi-map-test.ts
# 退出码 0，每个合成场景一行，例如
#   case 1 display 0 @150%  point (100,100)   -> screen (100,100)   PASS
#   case 2 display 1 @100%  point (2600,300)  -> screen (2600,300)  PASS
# 最后一行 "<n>/<n> cases passed"
```

测试里必须至少有一个"朴素算法会算错"的场景，否则以后回归了也发现不了。`node scripts/regress.ts` 保持全绿，`node scripts/snapshot-test.ts` 仍然输出 `3/3 snapshots match`——坐标修复不能让预览快照发生变化。

**规模估计：** M，1–3 天，含复现记录。

**我们提供什么.** 维护者在 macOS 真机上的复现笔记（AX 桥已经能按坐标点击），一次把重点放在抽象是否正确的评审（而不是格式），以及发布说明里的署名。

**风险与注意.** 两个坑。第一，"乘个缩放比"在窗口横跨两块屏时立刻失效——要按显示器算，不是按系统算。第二，`Rect` 属于协议 v0：如果你发现自己想改它的单位，停手，去开 RFC（[rfcs/README.md](../rfcs/README.md)），因为那会让所有已存断言失效。

---

## 03 — 录制器：右键、中键、滚轮、拖拽

**标题：** `recorder: 捕获右键、中键、滚轮与拖拽`

**标签建议：** `bounty` `driver` `recorder`

**问题背景.** 事件钩子那一轮已经落地了：`packages/drivers/windows/recorder.ps1` 注册 `Automation.AddAutomationFocusChangedEventHandler` 和 `RootElement` 上的 `AddStructureChangedEventHandler`，配 `-Poll` 300ms 回退，`scripts/recorder-mode-test.ts` 证明两种模式都能启动并落盘。缺的是**哪些指针事件能进来**：底层鼠标钩子（`SetWindowsHookEx(14, …)`，即 `WH_MOUSE_LL`）只过滤一条消息——`wParam == 0x0201`，左键按下。右键、中键、滚轮、拖拽全部被静默丢弃，`docs/recording.md` 的 *Known limits* 里也承认了。

**要改的文件与接口.**

- `packages/drivers/windows/recorder.ps1`：处理 `0x0204`（右键按下）、`0x0207`（中键按下）、`0x020A`（滚轮，`mouseData` 高字是有符号增量）；拖拽则把 `0x0201` 与 `0x0202` 配对，加上超过阈值的位移。
- 录制 JSONL 是内部格式，**不属于**协议 v0：click 行加 `button: "left" | "right" | "middle"`，另加带 `delta` 的 `wheel` 行类型。
- `scripts/draft-skill.ts`：左键照旧生成 `ui.click`；其它类型在草稿里显式写一行 `// TODO: <kind> at <window> — 协议 v0 没有对应 Action`，而不是把事件丢掉。静默丢数据才是这里的 bug。
- `docs/recording.md`：更新"三种事件"那段和模式表格。

**验收标准.**

```bash
node scripts/recorder-mode-test.ts
# 现在是 "8/8 passed"；你的版本要保持全绿，并为新增类型补用例
```

```bash
node apps/recorder/main.ts --seconds 15 --out .demo/recordings/rec.jsonl
# 录制期间依次做：左键点击一次、右键一次、滚轮滚动一次，然后：
node -e "const r=require('fs').readFileSync('.demo/recordings/rec.jsonl','utf8').trim().split(/\n/).map(JSON.parse); console.log([...new Set(r.map(x=>x.type+(x.button?':'+x.button:'')))]  .join(' '))"
# 期望输出含：click:left click:right wheel
```

```bash
node scripts/draft-skill.ts --recording .demo/recordings/rec.jsonl --name rec-check --only "."
# 草稿里每个非左键事件都有一行 TODO 注释，并且
node bin/deskshell.ts run rec-check --mode preview
# 仍然能渲染出计划
node scripts/regress.ts   # 全绿
```

**规模估计：** M，1–3 天。钩子管道本身很小，时间花在拖拽阈值和去重上。

**我们提供什么.** 一次录制会话和维护者产出的 JSONL 供对照；专注查事件丢失、以及轮询回退是否仍然等价的评审；录制器贡献者署名。

**风险与注意.** `WH_MOUSE_LL` 回调跑在钩子线程上，必须快——不要在回调里直接调 UI Automation，照左键那条路径的做法入队、在排空线程里解析。拖拽判定需要距离阈值，否则每次手抖点击都会变成拖拽。**别碰协议 v0**：如果右键确实需要新的 `Action` 类型，那是另一个 RFC，这个任务明确停在录制层。

---

## 04 — 从录制推断 `window.rect` 断言

**标题：** `draft: 点击导致窗口移动/缩放时推断 window.rect 断言`

**标签建议：** `bounty` `recorder` `kernel-adjacent`

**问题背景.** `scripts/draft-skill.ts` 已经能推断三类断言：3 秒内出现新窗口 → `window.exists`，2.5 秒内焦点移动 → `ui.exists`，输入的文字 → `ui.value`。几何变化是第四个"点击成功了"的信号——今天 `tile-windows` 是手写这个断言的——而没有任何代码推断它。真正的拦路虎是录制样本里根本没有几何信息：`interface Sample` 只有 `ts / type / window / controlType / name / automationId / value / x / y`。

**要改的文件与接口.**

- `packages/drivers/windows/recorder.ps1`：`click` 与 `window-open` 行加 `rect: [x, y, w, h]`（两个处理器里 `BoundingRectangle` 本来就在手上）。
- `scripts/draft-skill.ts`：`interface Sample` 加 `rect`；点击后 3 秒内同一窗口几何变化超过容差时，生成 `{ kind: "window.rect", window, rect, tolerance }`。
- `packages/core/src/types.ts` 里已经有 `{ kind: "window.rect"; window; rect; tolerance? }`，不需要动协议。
- `docs/recording.md`：推断规则列表补一条。

**验收标准.**

```bash
node apps/recorder/main.ts --seconds 12 --out .demo/recordings/rect.jsonl
# 录制时拖一下窗口标题栏，然后：
node scripts/draft-skill.ts --recording .demo/recordings/rect.jsonl --name rect-check --only "."
# 期望草稿里出现 window.rect 后置断言，且汇总行把它计入推断条数
node bin/deskshell.ts run rect-check --mode preview
# 期望计划正常渲染，window.rect 那一步可见
```

```bash
node scripts/snapshot-test.ts   # 3/3 snapshots match —— 已有草稿不能被改动
node scripts/regress.ts         # 全绿
```

反向用例也必须被测到：录制里一次**没有**移动窗口的点击，不能生成 `window.rect` 断言。

**规模估计：** M，1–3 天，大头在容差调参和反向用例。

**我们提供什么.** 一段含窗口拖拽的录制数据供开发；一次专门盯容差规则的评审（这一段我们一定会吵）；录制器贡献者署名。

**风险与注意.** 最大化、最小化、动画中的窗口会产出垃圾矩形——直接跳过这些行，不要断言。容差要小到能抓住真回归、大到不抖；从 1–2 px 起步，并在 PR 里论证这个数字。这个任务在混 DPI 下依赖 **02**；撞墙就先把单屏场景落地并说明。

---

## 05 — 每步 dry-run 差异（`run --diff`）

**标题：** `kernel: 预览模式下逐动作的 dry-run 差异输出`

**标签建议：** `bounty` `kernel`

**问题背景.** 预览是默认模式，已经会打印计划、风险等级、每步是否可撤销和汇总。它没说**内容会变成什么**。对一个要重写 300 个文件的 skill，"312 步，低风险"不足以让人按下同意。全仓搜 `dryRun` / `dry-run`，除了发布脚本没有任何命中——这个功能不存在。

**要改的文件与接口.**

- 新建 `packages/core/src/diff.ts`：一个纯函数把 `Action` 变成一行人类可读的差异（`fs.write` → `+18 -0` 加有界摘录，`fs.move` → `a -> b`，`fs.delete` → `-<n> bytes`，`fs.restore` → `restore <n> bytes`）。
- `bin/deskshell.ts`：`run` 加 `--diff`，只在预览模式打印，并进入 `--json` 的每步 `diff` 字段。
- 新测试：`scripts/dry-run-diff-test.ts`，形状参照 `scripts/preview-summary-test.ts`。

**验收标准.**

```bash
node scripts/make-fixture.ts
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --diff
# 期望每步一行差异，例如   fs.move  notes.txt -> 文档/notes.txt
# 并保留原有汇总；不加 --diff 时输出与今天逐字节一致
```

```bash
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --diff --json
# 期望 steps[i].diff 为字符串，且 "ok": true
node scripts/dry-run-diff-test.ts   # "<n>/<n> passed"
node scripts/snapshot-test.ts       # 3/3 snapshots match —— 默认预览不变
node scripts/regress.ts             # 全绿
```

**规模估计：** M，1–3 天，主要在想"显示多少才算差异、超过就变成 dump"。

**我们提供什么.** fixture 生成器 `scripts/make-fixture.ts`；专注输出确定性的评审（这段输出会被贴进 issue 和截图里）；发布说明署名。

**风险与注意.** 不要为了做差异去整文件读取——按字节上限截断并在输出里说明。跨平台确定性：不许出现绝对路径、时间戳、随 locale 变化的格式。不要改默认预览输出，`scripts/snapshot-test.ts` 就是为抓这个而存在的。

---

## 06 — 撤销时间线视图（`deskshell timeline`）

**标题：** `cli: deskshell timeline —— 按时间排序、标注每步可撤销性的视图`

**标签建议：** `good first issue` `kernel`

**问题背景.** 撤销的面比大家以为的宽：`deskshell undo --task <id>`、`--last <N>`、`--since <30m|2h|1d>`，还有 `deskshell show <taskId>` 看单个任务的步骤、`deskshell history` 看每个任务的步数。缺的正是 roadmap 要的那件事：一个**时间**视角回答"这机器过去一小时干了什么，其中哪些还能撤回"。今天得先 `history` 拿 id、再 `show`，而且没有任何地方告诉你某一步是 `undo: null`、根本撤不回来。

**要改的文件与接口.**

- `bin/deskshell.ts`：新增 `timeline` 命令，支持 `--since`、`--limit`、`--json`。
- `packages/core/src/journal.ts`：视图需要的读取辅助（已经有 `load()`）。
- 新测试：`scripts/timeline-test.ts`。

**验收标准.**

```bash
node bin/deskshell.ts timeline --root .demo/downloads
# 最新任务在前：taskId、skill、开始时间、步数，并标出不可撤销步数，例如
#   20 步（18 可撤销 / 2 不可撤销）
```

```bash
node bin/deskshell.ts timeline --root .demo/downloads --json
# 期望 { tasks: [ { taskId, skill, start, steps, undoable, notUndoable } ] }
node scripts/timeline-test.ts   # "<n>/<n> passed"，含一个带 undo:null 步骤的任务
node scripts/regress.ts         # 全绿 —— history/show/undo 行为不变
```

**规模估计：** M，1–3 天。读取很轻；输出设计是活。

**我们提供什么.** 一份含"可撤销 / 不可撤销"混合任务的时间线 fixture；一次拿 `history` 的表头对齐做对照、避免两边走形的评审；发布说明署名。

**风险与注意.** 这是**只读**命令，不许撤销任何东西。不要改 journal schema——已存在的 `.deskshell/journal.jsonl` 必须继续能读，轮转和区间测试已经在守这条线。列宽和排序是用户可见的 API，沿用 `history` 的对齐约定。

---

## 07 — 记住能力授权（`--ask --remember`）

**标题：** `cli: 持久化能力授权，--ask 不再每次重问`

**标签建议：** `good first issue` `kernel`

**问题背景.** `--ask` 已经能用，并且被 `scripts/ask-test.ts` 钉死了行为：全同意就执行、任一拒绝退出码 2 且不留副作用、没有输入等同拒绝、TTY 下逐项问、管道下按行读 `y`/`n`。它不记事：每次运行都要重新审一遍，于是实践中大家直接传 `--grant` 跳过审问——这恰好废掉了整个设计。`packages/core/src/policy.ts` 只接收 `granted: CapabilityId[]`，自己不存任何东西。

**要改的文件与接口.**

- `bin/deskshell.ts`：`--ask --remember`（持久化）、`--ask --forget`（清除）。
- 新增：任务根下的授权存储 `<root>/.deskshell/grants.json`，记录 skill 名、能力 id、scope、授予时间。**按 root 作用域，绝不全局。**
- `packages/core/src/policy.ts`：审问前可选读取已存授权。
- 新测试：`scripts/ask-remember-test.ts`。

**验收标准.**

```bash
printf 'y\ny\n' | node bin/deskshell.ts run downloads-cleanup --root .demo/ask2 --ask --remember --mode preview
# 退出码 0，且 .demo/ask2/.deskshell/grants.json 存在并包含两项能力
node bin/deskshell.ts run downloads-cleanup --root .demo/ask2 --ask --mode preview < /dev/null
# 退出码 0、不再提问，并打印一行说明正在复用已存授权
node bin/deskshell.ts run downloads-cleanup --root .demo/ask2 --ask --forget
# grants.json 消失；下一次 --ask 重新提问
```

```bash
node scripts/ask-remember-test.ts   # "<n>/<n> passed"
node scripts/ask-test.ts            # 仍然 8/8 passed —— 普通 --ask 语义不变
node scripts/regress.ts             # 全绿
```

**规模估计：** S，半天。

**我们提供什么.** 把 `scripts/ask-test.ts` 作为必须保住的契约；一次优先盯拒绝路径的评审；发布说明署名。

**风险与注意.** 悄悄放宽的授权就是安全漏洞。所以：复用已存授权必须打印出来、`--forget` 必须真删、已存授权绝不能套用到别的 skill 或更宽的 scope。`grants.json` 损坏时按"没有"处理并重新提问，绝不按"全都允许"处理。只动 CLI 与 policy，不动协议 v0。

---

## 08 — 文档站全文搜索

**标题：** `docs: 文档站正文全文搜索，替换现成的侧栏标题过滤`

**标签建议：** `good first issue` `docs`

**问题背景.** 生成出来的站点已经有搜索框 `#nav-search`，这是个不错的渐进增强，但它只过滤 `.nav-item` 的链接文字，也就是页面标题。读者记得"tolerance"这个词、但不记得哪一页，就什么也搜不到。`scripts/build-docs.ts` 生成整个双语站点且不带任何第三方资源，这个约束不变。

**要改的文件与接口.**

- `scripts/build-docs.ts`：构建期产出搜索索引（例如 `site/en/search-index.json` 与 `site/zh-CN/search-index.json`），内容来自页面 HTML——标题、锚点 id、每个小节有界的正文摘录。
- 同一文件里注入的脚本：查索引，命中渲染成"页面 + 小节"链接，空查询时保留今天的标题过滤行为。
- `docs/index.md`：加一行，告诉读者搜索覆盖正文。

**验收标准.**

```bash
node scripts/build-docs.ts
# 保留原有 "built <n> pages" 一行，另外：
ls site/en/search-index.json site/zh-CN/search-index.json   # 两个都要存在
```

```bash
node -e "const i=require('./site/en/search-index.json'); const q='tolerance'; console.log(i.filter(e=>JSON.stringify(e).toLowerCase().includes(q)).map(e=>e.page+'#'+e.anchor).join('\n'))"
# 至少一个命中，且它不是页面标题（侧栏过滤永远找不到它）
node scripts/regress.ts   # 全绿，含 docs.build 检查
```

人工检查写进 PR 描述：打开 `site/en/index.html`，输入一个只在正文里出现的词，拿到命中，点进去，落在正确锚点。关掉 JS 时页面与今天一致（过滤框隐藏、布局不塌）。

**规模估计：** M，1–3 天。建索引不难；把载荷压小、交互做诚实才是难点。

**我们提供什么.** 对生成 HTML 的无障碍与无 JS 路径做评审；名字进 `CONTRIBUTORS.md` 的 *Docs* 一节。

**风险与注意.** 不许引第三方搜索库、不许 CDN、不许构建期服务——站点必须能 `file://` 离线打开。索引前要剥掉标签和导航外壳，否则每页都命中每个查询。摘录长度要有上限。

---

## 09 — 随机故障注入压测

**标题：** `scripts: flake-soak —— 在 --fail-at 之上做随机故障注入`

**标签建议：** `good first issue` `testing`

**问题背景.** `apps/cli-demo/fail-story.ts` 接受 `--fail-at <step>`，证明"在你挑的那一步失败 → 全量回滚且写进审计日志"。那是**确定性**失败。真正制造 flake 的是你没挑的失败：第一步、最后一步、连续两次、回滚过程中再失败。全仓目前没有任何随机注入。

**要改的文件与接口.**

- 新建 `scripts/flake-soak.ts`：跑 N 轮，每轮在随机步注入失败（按计划长度取界），然后断言不变量：副作用消失、日志里恰好一条失败步、报告带出回滚步数、第二次撤销是空操作。`scripts/undo-test.ts` 证明过一次幂等，你要把它一般化。
- 复用 `apps/cli-demo/fail-story.ts` 的 fixture 与辅助写法，把它的注入机制参数化，而不是另写一套。

**验收标准.**

```bash
node scripts/flake-soak.ts --runs 20
# 每轮一行：run 7/20  fail-at step 13/20  rolled back 12  journal ok  PASS
# 最后一行："20/20 runs rollback-consistent"
# 退出码 0；任何不一致打印出问题的 journal 路径并非零退出
```

```bash
node scripts/flake-soak.ts --runs 5 --seed 42   # 同种子同步数，可复现
node scripts/regress.ts                          # 全绿
```

**规模估计：** S，半天；之后你用它找 bug 花多久另算。

**我们提供什么.** 你发布的任何一次压测里失败轮的 journal；坚持种子可复现的评审；发布说明署名。

**风险与注意.** 它会把内核反复跑在文件系统上——全部放在 `.demo/` 下，轮间清理，否则会留下孤儿目录。只会在第 3 步失败的压测不叫压测：断言随机步确实铺满计划。如果它挖出真的内核 bug，那是**成功**：另开一个 `bug` issue 并链接，不要在这个 PR 里顺手改内核。

---

## 10 — 新 skill：`screenshot-dedupe`

**标题：** `skill: screenshot-dedupe —— 收拢近似重复截图，保留最早的一张`

**标签建议：** `good first issue` `skill`

**问题背景.** 两个现有 skill 看着近，但都不干这件事。`dedupe-folders` 对文件**内容**哈希，只能抓字节完全相同的副本。`screenshot-organize` 按日期分到 `YYYY/MM/` 并加时间前缀。真实情况是连拍：同一个弹窗截六张，只差一个光标闪烁。这个场景没人管，而它是最理想的首个 skill——纯文件系统，三个平台都能跑，Linux 没驱动也行。

**要改的文件与接口.**

- `node scripts/new-skill.ts --name screenshot-dedupe` 生成 `packages/skills/screenshot-dedupe/{index.ts,skill.json}`，之后只改 `plan()`。
- manifest：`fs.read` 与 `fs.write`，scope 为 `"{{root}}"`，每个都写一句人话 `reason`。内核会拒绝未被声明能力覆盖的动作，scope 开太大同样会被拒。
- 零依赖：从 PNG 的 `IHDR` 头、JPEG 的 `SOF` 标记里读尺寸（几十行），不引图像库。
- fixture：`scripts/make-screenshot-fixture.ts`（新建），生成已知尺寸与 mtime 的 PNG。
- 按 `photo-sort` / `new-skills` 的写法登记进 `scripts/regress.ts`。

**验收标准.**

```bash
node scripts/make-screenshot-fixture.ts .demo/screenshots
node apps/cli-demo/run.ts --skill packages/skills/screenshot-dedupe/index.ts --mode preview --root .demo/screenshots
# 计划步数等于重复候选数，每一步都可撤销
node apps/cli-demo/run.ts --skill packages/skills/screenshot-dedupe/index.ts --mode apply --root .demo/screenshots
node apps/cli-demo/run.ts --skill packages/skills/screenshot-dedupe/index.ts --mode undo
# 文件数精确回到起始值
node scripts/regress.ts   # 全绿，含你新加的检查
```

`CONTRIBUTING.md` 的三条硬规则照旧：每个动作有 `post` 断言、每个动作有 `undo`、`plan()` 里不直接调系统 API；重复项移进 `.trash`，永不删除。

**规模估计：** S，半天。

**我们提供什么.** fixture 生成器草稿；一次盯"保留最早"规则和 `.trash` 安全性的评审；名字进 `CONTRIBUTORS.md` 的 *Skill* 一节。

**风险与注意.** "近似重复"是策略判断，不是算法：同尺寸 + 小时间窗既站得住又能解释，但这条规则必须写进 skill 的 `description`，让用户在 apply 之前就看见。v1 不删、不覆盖、不跨目录去重。

---

## 11 — 新 skill：`browser-download-sort`

**标题：** `skill: browser-download-sort —— 按类型与文件名规律整理浏览器下载目录`

**标签建议：** `bounty` `skill`

**问题背景.** `browser-tabs` 通过控件树读浏览器**窗口**（只在 Windows 与 macOS）。`downloads-cleanup` 只按扩展名分类。没人用文件名本身携带的信息去整理下载目录——`report (3).pdf`、`setup-x64.exe`、`invoice_2026-03.pdf`——而这些信息就在那儿。纯文件系统，今天三个平台都能跑。

**要改的文件与接口.**

- `packages/skills/browser-download-sort/{index.ts,skill.json}`，用 `node scripts/new-skill.ts --name browser-download-sort` 生成。
- 只用确定性规则——不调模型、不联网：去掉浏览器重名后缀（`(1)`、` (2)`）、去掉尺寸后缀、用一份写明的分类表（安装包 / 文档 / 压缩包 / 图片 / 音视频），目标目录内保留原文件名。
- fixture：`scripts/make-download-fixture.ts`（新建），文件名表覆盖你实现的每条规则。
- `docs/recipes.md`：按现有页面格式加一条 recipe。
- 登记进 `scripts/regress.ts`。

**验收标准.**

```bash
node scripts/make-download-fixture.ts .demo/dl-sort
node apps/cli-demo/run.ts --skill packages/skills/browser-download-sort/index.ts --mode preview --root .demo/dl-sort
# 计划逐条写明移动，例如   fs.move  setup-x64.exe -> 安装包/setup-x64.exe
node apps/cli-demo/run.ts --skill packages/skills/browser-download-sort/index.ts --mode apply --root .demo/dl-sort
node apps/cli-demo/run.ts --skill packages/skills/browser-download-sort/index.ts --mode undo
# 文件数与每个原始路径都还原；第二次撤销为空操作
node scripts/regress.ts   # 全绿，含你新加的检查
```

分类表要同时出现在 skill 的 `description` 和 PR 里：用户是在批准一份移动清单，有权知道规则。

**规模估计：** M，1–3 天。规则容易，冲突难。

**我们提供什么.** 一份真实的下载目录列表（只有文件名、无内容）供测试；一次专攻冲突处理的评审；*Skill* 一节署名。

**风险与注意.** 两个文件会落到同一目标名时，必须让这一步响亮地失败，而不是静默覆盖——`rename-batch` 已经立过这个先例，照做。不要读浏览器历史数据库，不要碰 `{{root}}` 之外的东西。

---

## 12 — 新 skill：`pdf-merge`（零依赖）

**标题：** `skill: pdf-merge —— 不加依赖地合并 PDF`

**标签建议：** `bounty` `skill` `hard`

**问题背景.** `packages/skills/` 下没有任何 skill 碰 PDF，老实说原因是合并 PDF 确实是硬活：对象图、交叉引用表、trailer 字典、页面树、压缩流。零依赖的约束排除了 `pdf-lib` 这类库，所以这个任务要么是一个边界划得很清楚的实现，要么就不做。它出现在板上，是因为有界版本确实可做。

**要改的文件与接口.**

- `packages/skills/pdf-merge/{index.ts,skill.json}`，能力为 `"{{root}}"` 上的 `fs.read` + `fs.write`。
- 一个极简 PDF 读写器，放在 skill 旁边（如果确实可复用，就放 `packages/core/src/`——在 PR 里说明选了哪个、为什么）：解析 `startxref` → xref 表 → trailer → `/Root` → `/Pages` → `/Kids`，把页面对象拷进新文档，重写 xref 与 trailer。
- **有界的第一个版本：** 只支持同页面尺寸；不支持加密；不支持对象流（`/ObjStm`）。遇到这些输入就带明确信息拒绝，而不是产出一个坏文件。
- fixture：`scripts/make-pdf-fixture.ts`（新建），生成小的未压缩 PDF，输出可检查。

**验收标准.**

```bash
node scripts/make-pdf-fixture.ts .demo/pdfs
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode preview --root .demo/pdfs
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode apply --root .demo/pdfs
node scripts/pdf-merge-test.ts
# "<n>/<n> passed"，其中必须包含：
#   合并后页数 == 输入页数之和
#   输出在两家独立阅读器里打开无修复警告（在 PR 里写明是哪两家）
#   /ObjStm 输入被拒绝并给出信息，而不是被悄悄弄坏
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode undo
# 合并产物消失，每个输入字节完全一致（比对哈希）
node scripts/regress.ts   # 全绿，含你新加的检查
```

**规模估计：** L，约一周。板上最难的一个，是留给"就想要这个"的人的，不是留给第一个下午的。

**我们提供什么.** 分阶段 mentor 评审（先解析器设计，再写写出器）、一套 fixture、以及在"何时该拒绝输入而不是冒险写出坏文件"上的明确指导。*Skill* 作者署名，发布说明里写明。

**风险与注意.** 一个损坏的输出 PDF 比没有这个功能更糟：先写临时路径，再解析一遍自己的输出核对页数，最后原子移动到位。不要"就为了解析"加依赖——如果你认为依赖不可避免，那是一个关于零依赖约束的 RFC，不是 PR（[rfcs/README.md](../rfcs/README.md)、[GOVERNANCE.md](GOVERNANCE.md)）。永远不要声称支持加密或对象流 PDF；拒绝才是正确行为。

---

## 已经做完的，别重做

roadmap 旧稿里的三件事**已经上线**，但过时的请求还在陆续进来。想在这几个方向发力，请上面那些后续任务。

| 已经做完 | 自己可跑的证明 |
| --- | --- |
| `deskshell run a b --parallel` —— 一次调用跑多个 skill，一个失败不影响其它 | `node scripts/parallel-test.ts` → `7/7 passed` |
| 终端内交互式能力授权（`--ask`，逐项、TTY 或管道输入） | `node scripts/ask-test.ts` → `8/8 passed` —— 剩下的缺口是任务 **07** |
| 录制器改用 UIA 事件钩子（`FocusChanged` + `StructureChanged`），带 `-Poll` 回退，不再纯 300ms 轮询 | `node scripts/recorder-mode-test.ts` → `8/8 passed`；两种模式都写在 `docs/recording.md` —— 剩下的缺口是任务 **03**、**04** |

还有几条已经成立、动手前需要知道的：每个动作必须有 `post` 断言、必须有 `undo`；`undo: null` 的动作会被内核拒绝；内核零模型依赖，这条不在讨论范围内。

## 维护者不会接受什么

一次说清，省得有人做三天才发现——同一份清单也出现在 [CONTRIBUTOR-LADDER.md](CONTRIBUTOR-LADDER.md) 与 [GOVERNANCE.md](GOVERNANCE.md)：

- 只在作者机器上跑通一次、没有断言或没有 undo 的 demo 脚本。
- 把协议语义（action 类型、assertion 类型、undo 契约）的改动夹带进功能 PR。那是 RFC。
- 不走 RFC 就新增第三方运行时依赖。
- 在驱动里自己判断权限——权限归 `packages/core/src/policy.ts`。
- 为了让某个 skill 顺手而放宽能力 scope 的"绕过"。
