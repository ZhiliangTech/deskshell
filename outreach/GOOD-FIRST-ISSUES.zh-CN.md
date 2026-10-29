# 好上手的任务（Good first issues）

十二个任务，**范围已经划好、前置条件已经清空、每一个都以一条能跑的验收命令结尾**。这里没有任何一条需要先跟维护者"对齐设计"——这正是这张板子的意义。

任务来自 [docs/roadmap.md](../docs/roadmap.md) 记录的缺口、[STATUS.md](../STATUS.md) 那张"没做到的"表，以及代码本身。如果某个功能的一部分已经上线，任务会**指名道姓说清哪部分做完了**（并给出可验证的文件），然后把范围往前推一步，避免你花一个周末重做已经存在的东西。板上没有编出来的活。

- 仓库：`https://github.com/ZhiliangTech/deskshell` · MIT · Node `>=22.18`
- **零第三方运行时依赖**是硬约束，不是偏好。要加依赖，先走 RFC（见 [GOVERNANCE.md](GOVERNANCE.md)）。
- 协议 v0 冻结在 `spec/protocol-v0.json`。改 action / assertion / undo 的语义必须走 RFC；本板上的任务都在 v0 之内。
- 第一次提 PR 的路径（装环境应该 30 分钟内搞定）：[CONTRIBUTING.md](../CONTRIBUTING.md) → `node scripts/regress.ts` → 挑一个 → 带认领说明开 draft PR。
- **`bounty` 是「可认领」，不是「有奖金」。** 这块板上没有任何现金：你拿到的是所有权、[CONTRIBUTORS.md](../CONTRIBUTORS.md) 里的署名、优先评审，以及两个 PR 合并后的 roadmap 投票权。写在最前面，免得有人冲着钱来认领。

## 怎么认领

1. 用 [.github/ISSUE_TEMPLATE/bounty.yml](../.github/ISSUE_TEMPLATE/bounty.yml) 开一个 `bounty` issue（或直接在该任务的 issue 下留言），写清你认领第几号。
2. 维护者在 **48 小时**内回复：指派 mentor、确认范围没被占、提供你要的 fixture。
3. 在自己的分支上做，只改任务列出的文件。
4. 开 PR 时把验收命令和**真实输出**贴进描述。CI 绿 + 贴出输出，就是完整的评审门槛。

规模口径：**S** = 半天，**M** = 1–3 天，**L** = 约一周——按"已经跑过一次 `node scripts/regress.ts`"的人估。

## 任务总表

| # | 任务 | 建议标签 | 规模 | 领域 |
| --- | --- | --- | --- | --- |
| 01 | Linux：在现有窗口级驱动之上补 AT-SPI2 控件树后端 | `good first issue` `driver` `help wanted` | **L** | 驱动 |
| 02 | 多显示器与 DPI 坐标映射 | `bounty` `driver` `help wanted` | **M** | 驱动 |
| 03 | 录制器：右键/中键/滚轮/拖拽录制 + `window.rect` 断言推断 | `bounty` `driver` `recorder` | **M** | 驱动 / 录制 |
| 04 | 每步 dry-run 差异（`run --diff`） | `bounty` `kernel` | **M** | 内核 |
| 05 | 跨任务撤销时间线（`deskshell timeline`） | `good first issue` `kernel` | **M** | 内核 / CLI |
| 06 | 记住能力授权（`--ask --remember`） | `good first issue` `kernel` | **S** | 内核 |
| 07 | 文档站正文全文搜索 | `good first issue` `docs` | **M** | 文档 |
| 08 | 工程护栏：内核级 `--fail-at`、随机故障 soak、三平台 CI | `good first issue` `testing` `ci` | **M**（只做 A 部分 = **S**） | 工程 |
| 09 | MCP adapter：把 preview / apply / undo 暴露成 MCP tool | `bounty` `ecosystem` `mcp` | **M** | 生态 |
| 10 | 新 skill：`screenshot-dedupe` | `good first issue` `skill` | **S** | skill |
| 11 | 新 skill：`browser-download-sort` | `bounty` `skill` | **M** | skill |
| 12 | 新 skill：`pdf-merge`（零依赖） | `bounty` `skill` `hard` | **L** | skill |

---

## 01 — Linux：AT-SPI2 控件树后端

**标题：** `driver(linux): 在窗口级驱动之上实现 AT-SPI2 控件树与 selector 定位`

**标签建议：** `good first issue` `driver` `help wanted` `platform: linux`

**问题背景.** 窗口层已经做完了，别重做。`packages/drivers/linux/driver.ts` 是能跑的 X11 驱动，基于 `xdotool` + `wmctrl`：枚举窗口并读几何（`xdotool getwindowgeometry --shell`）、`type()` / `keys()` 走 `xdotool type` / `xdotool key`、`moveWindow()` 走 `windowmove` + `windowsize`，还导出了 `detect()` / `missingHint()`——缺 `DISPLAY`、`xdotool`、`wmctrl` 时给出安装提示而不是抛栈。`scripts/verify-driver.ts` 的 `linux` 分支已经接上，`.github/workflows/ci.yml` 里也已经在 Xvfb 下跑 `scripts/linux-driver-smoke.ts`。

它做不了的是**控件**，而且它诚实地承认了：`tree(ref, depth)` 忽略 `_depth`，固定返回两个节点——窗口 + 一个合成的 `X11Content` 面板；`invoke()` / `click()` 直接调 `this.unsupported()`，报"控件级定位需要 AT-SPI2"。缺口就在这里：在已经能用的东西之上，补真正的控件树和 selector 解析。

**要改的文件与接口.**

- `packages/drivers/linux/driver.ts`：让 `tree(ref, depth)` 尊重 `depth`，应用暴露了无障碍树时返回真实控件节点；**没有暴露时保留两个节点的合成树作为回退**。很多 X11 应用根本没有无障碍桥，诚实降级胜过抛异常。
- selector 解析：`UiSelector` → AT-SPI2 节点（`name`、`controlType`，应用实现了 AccessibleId 接口时也用它），然后 `invoke()` 走 AT-SPI 的 `Action` 接口、`click()` 走组件 extents 中心。保持现有规则：匹配不到就抛错，绝不静默成功。
- `windows()`、`bounds()`、`moveWindow()`、`type()`、`keys()` 不要动（无障碍层需要聚焦时可以加一次 focus 调用）。
- `scripts/verify-driver.ts`：Linux 下报告控件树的真实节点数。
- `docs/drivers.md`：刷新 Linux 行——窗口级已验证、控件级"已验证 / 未验证"分开写、已知限制（没有无障碍桥的应用走回退）。
- 新测试脚本，沿用现有写法：`scripts/atspi-tree-test.ts`。

**验收标准.**

```bash
# X11 会话，装了 xdotool + wmctrl，且 AT-SPI2 在会话总线上活着
node scripts/verify-driver.ts
# 期望：platform=linux、PASS windows()、PASS tree() 且节点数是真实值、末行 "N passed, 0 failed"
# 缺 DISPLAY/xdotool/wmctrl 的机器上仍须打印 missingHint() 的安装提示并以 1 退出——这条路径今天就有，不要弄坏
```

```bash
node scripts/atspi-tree-test.ts
# "<n>/<n> passed"，须覆盖：某个暴露无障碍的应用 tree 深度 > 2（在 PR 里写明是哪个应用）、
# selector 命中真实控件、selector 匹配不到时抛错而不是静默成功、
# 以及没有无障碍桥的窗口走回退、返回两个合成节点
node scripts/regress.ts   # 全绿
```

**规模估计：** L，约一周。三分之一已经写好了，剩下的活是无障碍树和 D-Bus，不是窗口管道。

**我们提供什么.** 写过另外两个驱动的 mentor，在 issue 里答 AT-SPI2 / D-Bus 问题；首次推送后 48 小时内评审；名字进 `CONTRIBUTORS.md` 的 *Driver* 一节，以及第一个支持控件级 Linux 的版本发布说明。

**风险与注意.** AT-SPI2 是 D-Bus 服务：先跑 `busctl --user list | grep -i atspi`；没有 `org.a11y.Bus` 就把桥加载起来（`NO_AT_BRIDGE=0`、`GTK_MODULES=gail:atk-bridge`）再判断代码错没错。**不许加依赖**——用现有的 CLI 风格（`gdbus` / `busctl`）或手写客户端跟总线说话，不要引 npm 的 D-Bus 库。`xvfb-run` 可以做冒烟，但通常没有无障碍总线，证明不了控件树。不要在驱动里做权限判断，权限归 `packages/core/src/policy.ts`。

---

## 02 — 多显示器与 DPI 坐标映射

**标题：** `driver: 跨多显示器与 DPI 缩放的坐标映射`

**标签建议：** `bounty` `driver` `help wanted`

**问题背景.** 缺口在代码里也成立，不只是 roadmap 上的一句话：在 `packages/`、`apps/`、`bin/`、`scripts/` 里搜 `dpi`、`scaling`、`devicePixelRatio`、`monitor` 零命中，只有 `docs/roadmap.md` 和它的中文镜像提到这件事。也就是说所有驱动都假设"一块屏、一个缩放比"。`window.rect` 断言比较的是平台 API 返回空间里的矩形，`click(ref, sel)` 把目标解析成同一空间里的点。在混 DPI 的桌上（150% 笔记本屏接 100% 外接屏）这些假设就崩了，点击会偏几十像素。**先复现再改**——具体错法取决于宿主进程是否 DPI-aware，把这一点定性出来本身就是交付物的一部分。

**要改的文件与接口.**

- `packages/drivers/windows/driver.ps1` / `driver.ts`：上报显示器布局，把 DPI 感知说清楚。
- `packages/core/src/types.ts`：加一个**可选**能力（例如 `screens?(): Promise<Screen[]>`）。`UiDriver` 本来就是 6 个必选 + 2 个可选（`bounds?`、`moveWindow?`）的混合形态，照这个写；不要改 `Rect` 的语义，也不要设成必选，否则 macOS 和 Linux 驱动直接编译不过。
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

必须至少有一个"朴素算法会算错"的场景，否则以后回归了也发现不了。`node scripts/regress.ts` 保持全绿，`node scripts/snapshot-test.ts` 仍然输出 `3/3 snapshots match`——坐标修复不能让预览快照漂移。

**规模估计：** M，1–3 天，含复现记录。

**我们提供什么.** 维护者在 macOS 真机上的复现笔记（AX 桥已经能按坐标点击）；一次把重点放在抽象是否正确的评审；发布说明署名。

**风险与注意.** 两个坑。第一，"乘个缩放比"在窗口横跨两块屏时立刻失效——按显示器算，不是按系统算。第二，`Rect` 属于协议 v0：想改它的单位就停手去开 RFC（[rfcs/README.md](../rfcs/README.md)），因为那会让所有已存断言失效。

---

## 03 — 录制器：输入覆盖 + 几何断言推断

**标题：** `recorder: 捕获右键/中键/滚轮/拖拽，并从录制推断 window.rect 断言`

**标签建议：** `bounty` `driver` `recorder`

**问题背景.** 事件钩子那一轮已经做完并且是默认行为：`packages/drivers/windows/recorder.ps1` 第 `$useEvents = -not $Poll` 行选择 UIA `FocusChanged` / `StructureChanged` 回调 + `Application.DoEvents()` 排空，`-Poll`（300ms 采样）只是回退；`scripts/recorder-mode-test.ts` 证明两种模式都能启动并落盘。**这一段不要重做。**

真正剩两个缺口，而且都在同两个文件里：

- **输入覆盖。** `ClickWatcher`（`SetWindowsHookEx(14, …)`，即 `WH_MOUSE_LL`）只过滤一条消息：`wParam == 0x0201`，左键按下。右键、中键、滚轮、拖拽全部被静默丢弃，`docs/recording.md` 的 *Known limits* 里也承认了。
- **几何。** `scripts/draft-skill.ts` 的 `interface Sample` 只有 `ts / type / window / controlType / name / automationId / value / x / y`，完全没有矩形，所以 `window.rect`——第四个"点击成功了"的信号、今天 `tile-windows` 手写的那个断言——永远推断不出来。脚本目前只推断三类：3 秒内出现新窗口 → `window.exists`、2.5 秒内焦点移动 → `ui.exists`、输入文字 → `ui.value`。

**要改的文件与接口.**

- `packages/drivers/windows/recorder.ps1`：处理 `0x0204`（右键）、`0x0207`（中键）、`0x020A`（滚轮，`mouseData` 高字是有符号增量），拖拽把 `0x0201` 与 `0x0202` 配对并加位移阈值；`click` 与 `window-open` 行加 `rect: [x, y, w, h]`（`BoundingRectangle` 本来就在手上）。
- 录制 JSONL 是内部格式、**不属于**协议 v0：click 行加 `button: "left" | "right" | "middle"`，新增带 `delta` 的 `wheel` 行和带 `from` / `to` 的 `drag` 行。
- `scripts/draft-skill.ts`：左键照旧生成 `ui.click`；其它类型在草稿里显式写一行 `// TODO: <kind> at <window> — 协议 v0 没有对应 Action`，而不是把事件丢掉（静默丢数据才是 bug）；点击后 3 秒内同一窗口几何变化超容差时生成 `{ kind: "window.rect", window, rect, tolerance }`——这个 kind `packages/core/src/types.ts` 里已有，不需要改协议。
- `docs/recording.md`：更新"三种事件"那段、模式表和推断规则列表。
- `scripts/recorder-mode-test.ts`：给新事件类型补用例。

**验收标准.**

```bash
node scripts/recorder-mode-test.ts
# 现在是 "8/8 passed"；你的版本保持全绿并覆盖新类型
```

```bash
node apps/recorder/main.ts --seconds 15 --out .demo/recordings/rec.jsonl
# 录制时依次：左键一次、右键一次、滚轮一次、拖标题栏一次，然后：
node -e "const r=require('fs').readFileSync('.demo/recordings/rec.jsonl','utf8').trim().split(/\n/).map(JSON.parse); console.log([...new Set(r.map(x=>x.type+(x.button?':'+x.button:'')))].join(' '))"
# 期望输出含：click:left click:right wheel drag
```

```bash
node scripts/draft-skill.ts --recording .demo/recordings/rec.jsonl --name rec-check --only "."
# 草稿里每个非左键事件都有一行 TODO 注释，且拖拽那一步带 window.rect 断言，汇总行把它计入推断
node bin/deskshell.ts run rec-check --mode preview   # 能渲染出计划
node scripts/snapshot-test.ts                        # 3/3 snapshots match —— 已有草稿不变
node scripts/regress.ts                              # 全绿
```

反向用例必须被测到：一次**没有**移动窗口的点击，不生成 `window.rect` 断言。

**规模估计：** M，1–3 天；钩子管道很小，时间花在拖拽阈值和容差调参上。也可以拆成两个 PR：先采集，再推断。

**我们提供什么.** 一次录制会话和维护者产出的 JSONL 供对照；专注查事件丢失、容差论证、轮询回退是否仍然等价的评审；录制器贡献者署名。

**风险与注意.** `WH_MOUSE_LL` 回调在钩子线程上跑，必须快——照左键那条路径入队、在排空线程解析，不要在回调里直接调 UI Automation。拖拽要距离阈值，否则手抖点击都变拖拽。最大化 / 最小化 / 动画中的窗口会产出垃圾矩形，跳过这些行。**别碰协议 v0**：如果右键确实需要新的 `Action` 类型，那是另一个 RFC。

---

## 04 — 每步 dry-run 差异（`run --diff`）

**标题：** `kernel: 预览模式下逐动作的 dry-run 差异输出`

**标签建议：** `bounty` `kernel`

**问题背景.** 预览是默认模式，已经会打印计划、风险等级、每步是否可撤销和汇总。它没说**内容会变成什么**。对一个要重写 300 个文件的 skill，"312 步，低风险"不足以让人按下同意。全仓搜 `dryRun` / `dry-run`，除了发布脚本零命中——这个功能不存在。

**要改的文件与接口.**

- 新建 `packages/core/src/diff.ts`：纯函数把 `Action` 变成一行人类可读差异（`fs.write` → `+18 -0` 加有界摘录，`fs.move` → `a -> b`，`fs.delete` → `-<n> bytes`，`fs.restore` → `restore <n> bytes`）。
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

**我们提供什么.** fixture 生成器 `scripts/make-fixture.ts`；专注输出确定性的评审（这段输出会被贴进 issue 和截图）；发布说明署名。

**风险与注意.** 不要为了做差异去整文件读取——按字节上限截断并在输出里说明。跨平台确定性：不许绝对路径、时间戳、随 locale 变化的格式。不要改默认预览输出，`scripts/snapshot-test.ts` 就是为抓这个而存在的。

---

## 05 — 跨任务撤销时间线（`deskshell timeline`）

**标题：** `cli: deskshell timeline —— 跨任务的时间视图，标注每步可撤销性`

**标签建议：** `good first issue` `kernel`

**问题背景.** 先把已存在的三样东西读一遍，这个任务不是它们任何一个的改名。

- `deskshell history [--root DIR] [--json]`：**每个任务一行**——taskId、skill、步数、耗时、状态、开始时间。它从不显示步骤，最后还会提示你去跑 `show`。
- `deskshell show [taskId] [--root DIR]`：**单个任务**的步骤——`✓ 01. 12:34:56 fs.move …`，日志条目带 undo 时再打一行 `undo: <kind>`。对 `undo: null` 的步骤它什么都不打，于是"没打"在"不需要撤销"和"撤不了"之间是歧义的。
- `deskshell undo --task <id> | --last <N> | --since <30m|2h|1d>`：已经是回滚的正规入口。

没有任何东西提供 roadmap 要的那件事：一个**跨全部任务、按时间排序**的视图，回答"这机器过去一小时干了什么、其中哪些还能撤回"——并且标出不可撤销的步、已撤销的步，把 apply 与 undo 事件交错显示。

**要改的文件与接口.**

- `bin/deskshell.ts`：新增 `timeline` 命令，支持 `--since`、`--limit`、`--json`、`--root`。
- `packages/core/src/journal.ts`：视图需要的读取辅助（已经有 `load()`）。
- 新测试：`scripts/timeline-test.ts`。

**验收标准.**

```bash
node bin/deskshell.ts timeline --root .demo/downloads
# 跨任务按时间排序的一条流；每步标 ok / failed / 已撤销，undo 为 null 的步明确标 "不可撤销"；
# 末尾回答真正的问题：现在还能撤销的区间是哪些
```

```bash
node bin/deskshell.ts timeline --root .demo/downloads --json
# 期望 { tasks: [ { taskId, skill, start, steps, undoable, notUndoable, undone } ] }
node scripts/timeline-test.ts   # "<n>/<n> passed"，含一个带 undo:null 步骤的任务
node scripts/regress.ts         # 全绿 —— cli.history / cli.show / undo 行为不变
```

PR 描述里把真实的 `history` 和 `show` 输出跟 `timeline` 并排放，让评审看到它**增加了信息**，而不是换了个排版。

**规模估计：** M，1–3 天。读日志很轻；设计一个"不是更漂亮的 `show`"的输出才是活。

**我们提供什么.** 一份含"可撤销 / 不可撤销 / 部分已撤销"混合任务的时间线 fixture；一次拿 `history` 表头对齐做对照、避免两边走形的评审；发布说明署名。

**风险与注意.** 只读命令，不许撤销任何东西。不要改 journal schema——已存在的 `.deskshell/journal.jsonl` 必须继续能读，轮转和区间测试在守这条线。这个 PR 里不要改 `history` / `show` 的输出；觉得它们该合并，另开讨论。列宽与排序是用户可见 API，沿用 `history` 的对齐约定。

---

## 06 — 记住能力授权（`--ask --remember`）

**标题：** `cli: 持久化能力授权，--ask 不再每次重问`

**标签建议：** `good first issue` `kernel`

**问题背景.** 交互式授权已经有了：`bin/deskshell.ts` 里有 `--ask` 和 `askCapabilities()`，TTY 下用 `node:readline/promises` 逐项提问，管道下从 stdin 按行读 `y`/`n`；行为被 `scripts/ask-test.ts` 钉死——全同意继续、任一拒绝退出码 2 且无副作用、没有输入等同拒绝。

它**不记事**。在 `bin/`、`packages/`、`scripts/` 里搜 `remember` 或 `grants.json` 零命中：没有任何授权存储，所以每次运行都要重新审一遍，实践中大家干脆传 `--grant` 跳过审问——这恰好废掉了整个设计。`packages/core/src/policy.ts` 只接收 `granted: CapabilityId[]`，自己不存任何东西。

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

**风险与注意.** 悄悄放宽的授权就是安全漏洞。复用必须打印、`--forget` 必须真删、已存授权绝不能套用到别的 skill 或更宽的 scope。`grants.json` 损坏时按"没有"处理并重新提问，绝不按"全都允许"。只动 CLI 与 policy，不动协议 v0。

---

## 07 — 文档站正文全文搜索

**标题：** `docs: 正文全文搜索，支持键盘上下选择`

**标签建议：** `good first issue` `docs`

**问题背景.** 站点已经有一个搜索框——`scripts/build-docs.ts` 里的 `#nav-search`——这是个不错的渐进增强，但它只过滤 `.nav-item` 的链接文字，也就是侧栏的**页面标题**。它不是全文搜索，也不该被当成全文搜索宣传。读者记得"tolerance"这个词但记不住哪一页，就什么也搜不到。站点双语生成、不带任何第三方资源，这个约束不变。

**要改的文件与接口.**

- `scripts/build-docs.ts`：构建期产出搜索索引（`site/en/search-index.json`、`site/zh-CN/search-index.json`），来源是页面 HTML——标题、锚点 id、每个小节有界的正文摘录。
- 同一文件里注入的脚本：查索引，命中渲染成"页面 + 小节"链接，支持 ↑/↓ 移动、Enter 打开，空查询时保留今天的标题过滤行为。
- `docs/index.md`：加一行告诉读者搜索覆盖正文。

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

人工检查写进 PR：打开 `site/en/index.html`，输入一个只在正文里出现的词，拿到命中，按 ↓ 和 Enter，落在正确锚点。关掉 JS 时与今天一致（过滤框隐藏、布局不塌）。

**规模估计：** M，1–3 天。建索引不难；把载荷压小、交互做诚实才是难点。

**我们提供什么.** 对生成 HTML 的无障碍与无 JS 路径做评审；名字进 `CONTRIBUTORS.md` 的 *Docs* 一节。

**风险与注意.** 不许引第三方搜索库、不许 CDN、不许构建期服务——站点必须能 `file://` 离线打开。索引前剥掉标签和导航外壳，否则每页都命中每个查询。摘录长度要有上限。

---

## 08 — 工程护栏：内核级 `--fail-at`、随机故障 soak、三平台 CI

**标题：** `kernel+ci: 任意 skill 可用的 --fail-at、随机故障 soak、Windows/macOS CI 矩阵`

**标签建议：** `good first issue` `testing` `ci`

**问题背景.** 两个诚实的缺口，都是关于"证据"。

- **故障注入只活在一个 demo 里，不在内核里。** `apps/cli-demo/fail-story.ts` 从 `process.argv` 读 `--fail-at <step>`（第 6–7 行），把计划包一层在第 N 步失败。`node bin/deskshell.ts run` 上没有对应能力，全仓也没有任何随机注入，可 `docs/roadmap.md` 明明列着"在 `--fail-at` 之上做随机故障注入"。
- **CI 只有一个平台。** `.github/workflows/ci.yml` 只有两个 job，都在 `ubuntu-latest` 上：`regress`（Node 22 + 24 矩阵，跑 `node scripts/regress.ts` 和 `node scripts/build-docs.ts`）和 `linux-ui`（装 `xvfb xterm xdotool wmctrl`，跑 `node scripts/contract-test.ts` 和 `xvfb-run -a --server-args="-screen 0 1280x800x24" node scripts/linux-driver-smoke.ts`）。Windows UIA 驱动和 macOS AX 桥——STATUS.md 声称"真机验证过"的那两样——在 CI 里从来没被跑过，那边回归了会静默发版。

A 部分（CI 矩阵）半天，可以单独合并；B 部分（故障注入）是另外半天。

**要改的文件与接口.**

- A：`.github/workflows/ci.yml`——加 `windows-latest` 和 `macos-latest` 两个 job，跑 `node scripts/regress.ts` 和 `node scripts/build-docs.ts`；macOS 上先构建桥（`packages/drivers/macos/build.sh`），让 AX 路径真的被跑到；每个 OS 都跑 `node scripts/snapshot-test.ts`，快照漂移就让 job 失败。
- B：内核级注入——`deskshell run` 上的 `--fail-at <step>`（或一个内核选项），让任意 skill 都能测，不只是 demo。
- B：新脚本 `scripts/flake-soak.ts`，跑 N 轮、每轮**随机**一步、带种子可复现，每轮后断言：副作用消失、日志里恰好一条失败步、报告出回滚步数、第二次撤销是空操作。
- `docs/roadmap.md` / `docs/zh-CN/roadmap.md`：同一个 PR 里把这条划掉。

**验收标准.**

```bash
# A 部分——推上去之后，PR 的检查里能看到三个操作系统
gh pr checks   # 或直接在网页看：regress (ubuntu) / regress (windows) / regress (macos) 全绿
node scripts/snapshot-test.ts   # 每个 OS 都是 3/3 snapshots match
```

```bash
# B 部分——注入能用在真实 skill 上，不只 demo
node bin/deskshell.ts run downloads-cleanup --root .demo/fail-at --mode apply --fail-at 7
# 期望：第 7 步失败、回滚 6 步、非零退出
node bin/deskshell.ts journal --root .demo/fail-at   # 恰好 1 步失败
```

```bash
node scripts/flake-soak.ts --runs 20
# 每轮一行：run 7/20  fail-at step 13/20  rolled back 12  journal ok  PASS
# 末行 "20/20 runs rollback-consistent"；任何不一致打印 journal 路径并非零退出
node scripts/flake-soak.ts --runs 5 --seed 42   # 同种子同步数，可复现
node scripts/regress.ts                          # 全绿
```

**规模估计：** 合计 M——A 半天、B 半天。两者是独立 PR：做一个、认领另一个。

**我们提供什么.** 你发布的任何一次 soak 的失败轮 journal；坚持种子可复现、且不接受用 `continue-on-error` 遮住失败的评审；发布说明署名。

**风险与注意.** macOS 上 Swift 桥可能因为与你无关的原因构建失败——真失败了就报告，并把驱动检查标 `SKIP` 附 issue 链接，**不要**靠吞掉错误让 CI 变绿。soak 会把内核反复跑在文件系统上：全部放 `.demo/` 下并轮间清理。如果 soak 挖出真的内核 bug，那是**成功**：另开 `bug` issue 链接过去，不要在这个 PR 里改内核。

---

## 09 — MCP adapter

**标题：** `mcp: 把 deskshell 的 preview / apply / undo 暴露成 MCP tool`

**标签建议：** `bounty` `ecosystem` `mcp`

**问题背景.** 全仓搜 `mcp` 只命中 `outreach/` 里的规划笔记——代码里没有任何 MCP 实现。而 MCP 客户端需要的东西，内核刚好已经有：一个计划（preview）、一次执行（apply）、一次回滚（undo），而且都返回结构化 JSON（`deskshell run --json` 返回 `{ ok, steps }`）。把这三个暴露成 tool，是让任意 MCP 客户端驱动 deskshell 的最便宜路径，**同时不给内核加模型依赖**，也不改任何协议语义。

**要改的文件与接口.**

- 新建 `apps/mcp/server.ts`（如果更顺，也可以在 `bin/` 加一个 `deskshell mcp` 入口），在 stdio 上讲 JSON-RPC：`initialize`、`tools/list`、`tools/call`。
- 三个 tool，都是内核现有入口的薄包装：`deskshell_preview`（`skill`、`root`）、`deskshell_apply`（`skill`、`root`、`grant` 必填——不许隐式授权）、`deskshell_undo`（`taskId` 或 `last`、`root`）。复用 `packages/core/src/kernel.ts` 的 `run()` / `undoTask()`，不要重写执行逻辑。
- **零依赖**：手写 JSON-RPC 分帧，不要引 `@modelcontextprotocol/sdk`。这条约束正是任务的难点，不经过 RFC 不能破。
- 新测试：`scripts/mcp-smoke.ts`，通过 stdin/stdout 驱动 server。
- `docs/index.md`（或新建 `docs/mcp.md`，哪样更清楚选哪样）：五行"接一个 MCP 客户端"说明，给出确切命令。

**验收标准.**

```bash
node scripts/mcp-smoke.ts
# "<n>/<n> passed"：initialize 握手、tools/list 恰好 3 个 tool、
# tools/call deskshell_preview 返回计划 JSON、能力未授予时返回结构化错误（不是崩溃）、
# 未知 tool 名返回 JSON-RPC 错误
```

```bash
# 手工，用任意 MCP 客户端（Claude Desktop，或你自己的脚本）：
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node apps/mcp/server.ts
# 期望一个格式正确的 initialize 结果，tools/list 同理
node scripts/regress.ts   # 全绿 —— 含新增的 smoke 检查
```

**规模估计：** M，1–3 天。需要的协议面很小；功夫在于别让 adapter 绕过权限层。

**我们提供什么.** 一次只问一个问题的评审——这个 adapter 有没有削弱能力模型；加上一份可复制的客户端配置样例，以及 `CONTRIBUTORS.md` 的 *Ecosystem* 一节署名。

**风险与注意.** MCP tool 就是给智能体的入口，所以权限层必须原地不动：不带显式 `grant` 的 `apply` 必须 fail closed，每次调用都要像普通运行一样进入审计日志。不要暴露 "shell" 或"任意动作"这类 tool——三个窄 tool，或者什么都不做。`server.ts` 不许 import 任何会拉进模型 SDK 的东西；内核零依赖，它的 adapter 也一样。

---

## 10 — 新 skill：`screenshot-dedupe`

**标题：** `skill: screenshot-dedupe —— 收拢近似重复截图，保留最早的一张`

**标签建议：** `good first issue` `skill`

**问题背景.** 两个现有 skill 看着近，但都不干这件事。`dedupe-folders` 对文件**内容**哈希，只能抓字节完全相同的副本。`screenshot-organize` 按日期分到 `YYYY/MM/` 并加时间前缀。真实情况是连拍：同一个弹窗截六张，只差一个光标闪烁。这个场景没人管，而它是最理想的首个 skill——纯文件系统，三个平台都能跑，Linux 没有控件级驱动也行。

**要改的文件与接口.**

- `node scripts/new-skill.ts --name screenshot-dedupe` 生成 `packages/skills/screenshot-dedupe/{index.ts,skill.json}`，之后只改 `plan()`。
- manifest：`fs.read` 与 `fs.write`，scope 为 `"{{root}}"`，每个写一句人话 `reason`。内核会拒绝未被声明能力覆盖的动作，scope 开太大同样会被拒。
- 零依赖：从 PNG 的 `IHDR` 头、JPEG 的 `SOF` 标记读尺寸（几十行），不引图像库。
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

**风险与注意.** "近似重复"是策略判断，不是算法：同尺寸 + 小时间窗既站得住又能解释，但这条规则必须写进 skill 的 `description`，让用户 apply 之前就看见。v1 不删、不覆盖、不跨目录去重。

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

**风险与注意.** 两个文件会落到同一目标名时，必须让这一步响亮地失败，而不是静默覆盖——`rename-batch` 已经立过先例，照做。不要读浏览器历史数据库，不要碰 `{{root}}` 之外的东西。

---

## 12 — 新 skill：`pdf-merge`（零依赖）

**标题：** `skill: pdf-merge —— 不加依赖地合并 PDF`

**标签建议：** `bounty` `skill` `hard`

**问题背景.** `packages/skills/` 下没有任何 skill 碰 PDF，老实说原因是合并 PDF 确实是硬活：对象图、交叉引用表、trailer 字典、页面树、压缩流。零依赖约束排除了 `pdf-lib` 这类库，所以这个任务要么是一个边界划得很清楚的实现，要么就不做。它出现在板上，是因为有界版本确实可做。

**要改的文件与接口.**

- `packages/skills/pdf-merge/{index.ts,skill.json}`，能力为 `"{{root}}"` 上的 `fs.read` + `fs.write`。
- 一个极简 PDF 读写器，放在 skill 旁边（如果确实可复用就放 `packages/core/src/`——在 PR 里说明选了哪个、为什么）：解析 `startxref` → xref 表 → trailer → `/Root` → `/Pages` → `/Kids`，把页面对象拷进新文档，重写 xref 与 trailer。
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
#   输出在两家独立阅读器里打开无修复警告（PR 里写明是哪两家）
#   /ObjStm 输入被拒绝并给出信息，而不是被悄悄弄坏
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode undo
# 合并产物消失，每个输入字节完全一致（比对哈希）
node scripts/regress.ts   # 全绿，含你新加的检查
```

**规模估计：** L，约一周。板上最难的一个，留给"就想要这个"的人，不是留给第一个下午的。

**我们提供什么.** 分阶段 mentor 评审（先解析器设计，再写出器）、一套 fixture、以及在"何时该拒绝输入而不是冒险写出坏文件"上的明确指导。*Skill* 作者署名，发布说明里写明。

**风险与注意.** 一个损坏的输出 PDF 比没有这个功能更糟：先写临时路径，再解析一遍自己的输出核对页数，最后原子移动到位。不要"就为了解析"加依赖——如果你认为依赖不可避免，那是一个关于零依赖约束的 RFC，不是 PR（[rfcs/README.md](../rfcs/README.md)、[GOVERNANCE.md](GOVERNANCE.md)）。永远不要声称支持加密或对象流 PDF；拒绝才是正确行为。

---

## 已经做完的，别重做

这几件事过时的请求还在陆续进来，每一条都有可跑的证明。

| 已经做完 | 证明 |
| --- | --- |
| Linux **窗口级** X11 驱动（`xdotool` + `wmctrl`）：窗口枚举与几何、`type`、`keys`、`moveWindow`、外加 `missingHint()` 安装提示 | `packages/drivers/linux/driver.ts`；`scripts/verify-driver.ts`；`scripts/linux-driver-smoke.ts` 在 CI 的 Xvfb 里跑它——后续缺口是任务 **01**（控件树） |
| `deskshell run a b --parallel` —— 一次调用跑多个 skill，一个失败不影响其它 | `node scripts/parallel-test.ts` → `7/7 passed` |
| 交互式能力授权（`--ask`，逐项，TTY 提问或管道读 `y`/`n`） | `node scripts/ask-test.ts` → `8/8 passed` —— 剩下的缺口是任务 **06**（记住授权） |
| 录制器改用 UIA 事件钩子（`FocusChanged` + `StructureChanged`，由 `$useEvents = -not $Poll` 决定默认）带 `-Poll` 回退 | `node scripts/recorder-mode-test.ts` → `8/8 passed`；`docs/recording.md` 写了两种模式——剩下的缺口是任务 **03** |
| `deskshell history`（任务列表）与 `deskshell show`（单任务步骤） | `bin/deskshell.ts` 第 35–36 行的用法文本；`scripts/regress.ts` 里的 `cli.history` / `cli.show` 检查——剩下的缺口是任务 **05**（跨任务视图） |

还有几条已经成立、动手前需要知道的：每个动作必须有 `post` 断言、必须有 `undo`；`undo: null` 的动作会被内核拒绝；内核零模型依赖，这条不在讨论范围内。

## 维护者不会接受什么

一次说清，省得有人做三天才发现——同一份清单也在 [CONTRIBUTOR-LADDER.md](CONTRIBUTOR-LADDER.md) 与 [GOVERNANCE.md](GOVERNANCE.md)：

- 只在作者机器上跑通一次、没有断言或没有 undo 的 demo 脚本。
- 把协议语义（action 类型、assertion 类型、undo 契约）的改动夹带进功能 PR。那是 RFC。
- 不走 RFC 就新增第三方运行时依赖。
- 在驱动里自己判断权限——权限归 `packages/core/src/policy.ts`。
- 为了让某个 skill 顺手而放宽能力 scope 的"绕过"。
- 靠吞掉错误让 CI 变绿（`continue-on-error`、`|| true`、跳过断言）。
