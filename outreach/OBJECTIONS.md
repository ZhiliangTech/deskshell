# 异议手册

十条真实会遇到的反对意见。每条给：他真正在问什么、可以直接发出去的答复（中英）、你手上的证据、以及**一句"不要说什么"**。

用法：先判断他是哪一类——**技术怀疑**（1、2、4、5、9）、**信任怀疑**（3、6、7）、**时间怀疑**（8、10）。技术怀疑用证据答，信任怀疑用承诺答，时间怀疑用"更小的第一步"答。答错类型等于没答。

---

## 1. 「又是一个 agent 框架？」

**他真正在问**：这东西是不是又一层套在 LLM 外面的 prompt 编排，三个月后就死了。

**答复（EN）**
> Fair — but it isn't an agent framework. There is no model in the kernel: no LLM calls, no tool-calling loop, no prompt layer, no vendor SDK. It's a transaction layer for desktop actions — permissions, preview, post-assertions, rollback, and a JSONL journal.
>
> Models can only exist behind two interfaces inside a skill, `see()` and `plan()`. Delete every model and the kernel still runs; that's why `story --fail` works offline with no API key. What's frozen is the protocol (v0): 8 action kinds, 7 assertion kinds, 5 undo kinds, 7 capability ids.
>
> 30-minute check: `node bin/deskshell.ts doctor`, then `node bin/deskshell.ts run downloads-cleanup --root .demo/downloads` — no model is loaded at any point.

**答复（中）**
> 说得对，但它不是 agent 框架。内核里没有模型：不调 LLM、没有 tool-calling 循环、没有 prompt 层、没有厂商 SDK。它是一层事务语义——权限、预览、post 断言、回滚、JSONL 审计。
>
> 模型只能待在 skill 里的两个接口后面：`see()` 和 `plan()`。把模型全删了内核照样跑，所以 `story --fail` 断网、无 API key 也能演示。冻结的是协议（v0）：8 种 action、7 种断言、5 种 undo、7 个 capability。
>
> 三十秒自证：`node bin/deskshell.ts doctor`，再跑 `run downloads-cleanup --root .demo/downloads`，全程没有模型被加载。

**证据**：`README.md` 设计不变量第 4 条；`spec/protocol-v0.json` 的 `invariants`（"内核不得依赖任何模型"）；`package.json` 无 `dependencies` 字段。

**不要说什么**："我们和 agent 框架是互补的"——他没问互补，他问的是你会不会死。先证明内核里真的没有模型。

---

## 2. 「已经有 pyautogui 和 Playwright 了」

**他真正在问**：我为什么要再学一个东西。

**答复（EN）**
> You should keep using them — this is the layer above, not a replacement.
>
> pyautogui gives you `click()` and returns. It has no notion of "did the click work", and no inverse operation. Playwright is excellent, but it owns browsers, not the desktop: your export dialog, your file manager, your editor.
>
> deskshell's missing piece is the contract: an action must declare a post-assertion and an undo, preview is the default, a failed assertion rolls the task back, and every step is journaled. A driver is six required methods (`windows`, `tree`, `invoke`, `click`, `type`, `keys`) plus two optional ones (`bounds`, `moveWindow`) — you can implement one on top of pyautogui or AT-SPI2, and the kernel doesn't care how the driver gets it done.
>
> 30 minutes: `node bin/deskshell.ts doctor`, then read `packages/core/src/types.ts` and tell me if six methods are enough for your platform.

**答复（中）**
> 那两个继续用，这是上面一层，不是替代品。
>
> pyautogui 给你 `click()` 然后返回，它不回答"这次点击到底成没成"，也没有逆操作。Playwright 很好，但它管浏览器，不管你的导出对话框、文件管理器、编辑器。
>
> deskshell 补的是契约：动作必须声明 post 断言和 undo，默认只预览，断言失败就回滚整个任务，每一步都进日志。驱动一共六个必选方法（`windows`、`tree`、`invoke`、`click`、`type`、`keys`），另两个可选（`bounds`、`moveWindow`），你完全可以在 pyautogui 或 AT-SPI2 上实现一个，内核不关心驱动内部怎么做的。
>
> 30 分钟：跑 `node bin/deskshell.ts doctor`，然后看 `packages/core/src/types.ts`，告诉我六个方法够不够描述你的平台。

**证据**：`packages/core/src/types.ts` 的 `UiDriver` 接口——6 个必选（`windows`／`tree`／`invoke`／`click`／`type`／`keys`）+ 2 个可选（`bounds`／`moveWindow`）；`spec/protocol-v0.json` 的 `assertionKinds` 与 `undoKinds`。注：`CONTRIBUTING.md` 里写的是七个（含 `focus`），与代码不一致，以代码为准。

**不要说什么**："pyautogui 太老了"——贬低他用得顺手的东西，等于让他替它辩护，对话就结束了。

---

## 3. 「只有 1 个 star 凭什么让我投入时间」

**他真正在问**：我会不会白干。

**答复（EN）**
> You shouldn't take the star count as evidence — take the commands. Five minutes:
>
> ```
> git clone {repo_url} && cd deskshell
> node bin/deskshell.ts doctor
> node bin/deskshell.ts story --fail
> node scripts/regress.ts
> ```
>
> `scripts/regress.ts` prints `39/39 passed` on a clean checkout, and `story --fail` shows a rigged failure undoing itself. If that output doesn't convince you, no number of stars would. STATUS.md pairs every capability with a reproducible command and its real output — including the ones that are not done (Linux is window-level only, the recorder misses drag/right-click/wheel, no public npm package).
>
> The real risk isn't code quality, it's maintainer time. That's a legitimate reason to say no, and I'd rather you say it than be polite.
>
> 30 minutes: `node scripts/regress.ts` and read the last 20 lines of output.

**答复（中）**
> star 数不该当成证据，该看命令。五分钟：
>
> ```
> git clone {仓库地址} && cd deskshell
> node bin/deskshell.ts doctor
> node bin/deskshell.ts story --fail
> node scripts/regress.ts
> ```
>
> `scripts/regress.ts` 在本机跑出 `39/39 passed`，`story --fail` 能看到一次故意失败被完整撤销。如果这些输出都说服不了你，多少 star 都不行。STATUS.md 里每条能力都配一条可复现命令和真实输出——包括没做到的（Linux 只有窗口层、录制器还没抓拖拽和右键菜单、npm 没发）。
>
> 真正的风险不是代码质量，是维护者时间够不够。这是个体面的拒绝理由，我宁愿你直说，而不是客气。

**证据**：`STATUS.md`「怎么判断这份文件没在吹牛」四条；`docs/install.md` 的失败表（每条都注明是验收时真踩到的）。

**不要说什么**："项目刚起步，以后会好的"——这是让他用信念补证据缺口，正好落进他最担心的地方。

---

## 4. 「协议会不会变？我不想追着改」

**他真正在问**：我现在写的代码，半年后还编得过吗。

**答复（EN）**
> v0 is frozen as of 2026-10-30 in `spec/protocol-v0.json`. After freezing, only backward-compatible field additions are allowed; removing a field or changing its semantics requires an RFC and a protocol version bump.
>
> For kernel changes, CONTRIBUTING.md states three conditions: existing skills' preview snapshots must not change (or you ship a migration script), the regression suite must be green, and the CHANGELOG must spell out the migration steps. During 0.x, breaking changes are listed in CHANGELOG.md with migration notes — that's already how the rollback-order fix shipped.
>
> Practical answer: a skill is `plan() → Action[]`. If you only write skills, the surface you depend on is the 8 action kinds, which is the most stable part of the whole thing.
>
> 30 minutes: read `spec/protocol-v0.json` (it's short) and tell me which field you think will hurt first.

**答复（中）**
> v0 在 2026-10-30 冻结在 `spec/protocol-v0.json`。冻结之后只能加向后兼容的字段；删字段或改语义要走 RFC 并升协议版本。
>
> 内核改动有三个条件写在 CONTRIBUTING.md 里：现有 skill 的预览快照不能变（或者你提供迁移脚本）、回归套件必须全绿、CHANGELOG 必须写清迁移步骤。0.x 期间的破坏性变更都列在 CHANGELOG 里并附迁移说明——回滚顺序那两次修正就是这么发的。
>
> 实用一点的回答：skill 就是 `plan() → Action[]`。你只写 skill 的话，你依赖的面是那 8 种 action，这是整份协议里最稳的部分。

**证据**：`spec/protocol-v0.json` 的 `frozen` 与 `note` 字段；`CONTRIBUTING.md`「改内核」三条；`CHANGELOG.md` 0.6.0 / 0.7.0 的 migration 段落。

**不要说什么**："基本不会变"——"基本"两个字等于承认会变且没规矩，刚好是他怕的。

---

## 5. 「我不用 Windows」

**他真正在问**：这项目对我有用吗，还是我只能在旁边看。

**答复（EN）**
> Then be precise about what works for you:
>
> - **File-based skills: any platform.** The kernel, assertions, rollback and journal are platform-independent; `doctor`, `run`, `undo` and the regression suite run on your machine today.
> - **UI skills on macOS:** verified on real hardware through a native Swift AX bridge (build it with `packages/drivers/macos/build.sh`, then grant Terminal accessibility permission).
> - **UI skills on Linux:** window-level works today — an X11 driver on xdotool + wmctrl (list windows, move, focus, window-level keys/type). Control-level (AT-SPI2: the tree, selector-scoped click/invoke) is not implemented, and those calls fail loudly instead of pretending to succeed. That's the highest-value contribution available right now, and the interface is already frozen at six required methods.
>
> If you're Linux-only and only care about UI scenarios, don't spend time on this yet. If you care about the file side, or you want to own the Linux control layer, there's a clear first issue.
>
> 30 minutes: `node bin/deskshell.ts doctor` on your box — it will tell you exactly which capabilities this platform has.

**答复（中）**
> 那说清楚哪些对你有用：
>
> - **文件类 skill：全平台可跑。** 内核、断言、回滚、日志都跟平台无关，`doctor`、`run`、`undo` 和回归套件在你这台机器上今天就能跑。
> - **macOS 的 UI 场景**：真机验证过，走原生 Swift AX 桥（先 `packages/drivers/macos/build.sh`，再给终端开辅助功能权限）。
> - **Linux 的 UI 场景**：窗口层今天就能用——X11 驱动（xdotool + wmctrl）能列窗口、移动、聚焦、做窗口级键盘输入。控件层（AT-SPI2：控件树、selector 级的 click/invoke）没实现，这类调用会明确报不支持，不会假装成功。这是现在价值最高的一个贡献位，接口也已经冻结在六个必选方法上。
>
> 如果你只有 Linux 且只关心 UI 场景，现在别投时间。如果你关心文件那一侧，或者想拿下 Linux 控件层，有明确的第一件事可做。
>
> 30 分钟：在你机器上跑 `node bin/deskshell.ts doctor`，它会直接告诉你这台机器支持哪些能力。

**证据**：`packages/drivers/linux/driver.ts`（X11 窗口层：xdotool + wmctrl；selector 级操作明确声明不支持并给出 AT-SPI2 说明）；`scripts/verify-driver.ts` 的 linux 分支与 `missingHint()` 安装提示。注：`README.md` 平台表仍写 Linux Planned，落后于代码，以代码为准。

**不要说什么**："Linux 驱动还没有"——窗口层驱动已经在代码里了，说"没有"会被当场打脸；要说清"窗口层有、控件层没有"。

---

## 6. 「我做完你不合并怎么办？」

**他真正在问**：我的时间会不会变成一次白工。

**答复（EN）**
> Reasonable fear. Three things reduce it:
>
> 1. **Open an issue first, get a yes before writing code.** I'd rather spend ten minutes scoping than have you spend a weekend. If the answer is no, you'll get the reason in writing on the issue.
> 2. **The merge bar is written down**, not vibes: for a skill, every action needs a post-assertion and an undo, and skills don't call system APIs. For a driver, implement the six required methods, add the platform branch to `scripts/verify-driver.ts`, and document verified/unverified capabilities and known limits in `docs/drivers.md`. For the kernel, an RFC plus unchanged preview snapshots (or a migration script), a green regression suite, and CHANGELOG migration steps.
> 3. **Small first.** A one-skill PR or one extra assertion kind gets reviewed the same day. A 3000-line refactor of the kernel will not.
>
> And if it doesn't get merged: your branch is yours, and I'll credit the work in the issue thread either way.
>
> 30 minutes: open an issue with "I want to do X, is this in scope?" — that's the cheapest way to test whether I'm serious.

**答复（中）**
> 这个担心合理，三件事能降低它：
>
> 1. **先开 issue，拿到"可以做"再写代码。** 我宁愿花十分钟对齐范围，也不想你花一个周末。如果答案是不做，理由会写在 issue 里。
> 2. **合并标准是写下来的**，不是感觉：skill 要求每个动作有 post 断言和 undo，且不调系统 API；驱动要实现六个必选方法、在 `scripts/verify-driver.ts` 加平台分支、在 `docs/drivers.md` 写清已验证/未验证/已知限制；内核改动要走 RFC，预览快照不变（或给迁移脚本），回归全绿，CHANGELOG 写迁移步骤。
> 3. **第一次做小的。** 一个 skill 的 PR 或者加一种断言，当天就看。三千行的内核重构不会。
>
> 万一没合并：分支是你的，issue 里我会把这份工作记下来。
>
> 30 分钟：开一个 issue 写"我想做 X，在不在范围内"——这是检验我是否认真的最便宜的方式。

**证据**：`CONTRIBUTING.md`「贡献一个 skill」三条硬规则、「贡献一个驱动」三步、「改内核」三条。

**不要说什么**："放心，肯定合并"——承诺你控制不了的事，比不给承诺更伤信任。

---

## 7. 「有没有钱 / 有赞助吗？」

**他真正在问**：这事能不能持续，我的贡献有没有回报。

**答复（EN）**
> No. No funding, no sponsorship, no paid tier, no company behind it. MIT, one maintainer, so far unpaid.
>
> What I can actually offer: a same-day first review, your name in CHANGELOG.md on the line that ships your work, and a real seat in the protocol discussion while v0 is still the only version — after 1.0 the cost of changing anything goes up for everyone.
>
> What I can't offer: money, a job, or "exposure that turns into money". If you need paid work, this isn't it, and I'd rather say that now.
>
> 30 minutes: pick an issue from the roadmap's "no decision needed" list — those are scoped to be finishable by one person in an evening.

**答复（中）**
> 没有。没有融资，没有赞助，没有付费层，背后没有公司。MIT，一个维护者，目前没有报酬。
>
> 我能给的：当天第一次评审、CHANGELOG 里单独一行写你的名字、以及协议还是 v0 的时候在讨论里有一个真正的席位——1.0 之后任何人改东西的成本都会变高。
>
> 我给不了的：钱、工作、"能变成钱的曝光"。如果你需要的是有偿的活，这不是，我宁愿现在说清楚。
>
> 30 分钟：从 roadmap 里"不需要决策"的清单挑一个，那些都按"一个人一晚上能做完"来切的。

**证据**：`LICENSE`（MIT）；仓库无 `.github/FUNDING.yml`；`docs/roadmap.md`「Next (no decision needed)」清单。

**不要说什么**："以后商业化了一定会回报贡献者"——这是空头支票，而且会被截图。

---

## 8. 「我一个人能做什么？」

**他真正在问**：这事太大，我从哪下手。

**答复（EN）**
> Three options, all under 30 minutes:
>
> - **See if it's real**: `node bin/deskshell.ts doctor`, then `node bin/deskshell.ts story --fail`. Read the journal it leaves behind.
> - **Write one skill you actually need**: `node scripts/new-skill.ts --name my-skill`, edit only `plan()`, run with `--mode preview`. Every action needs a post-assertion and an undo. That's the whole difficulty.
> - **Claim one issue**: the roadmap's "no decision needed" list — the Linux control layer on AT-SPI2, multi-display/DPI coordinate mapping, recorder support for drag/right-click/wheel, inferring `window.rect` assertions from recordings, per-action dry-run diffs, undo timeline view, `run --parallel`, fault injection, docs search.
>
> My honest ranking if you have one evening: the Linux control layer (AT-SPI2 `tree()` plus selector-scoped `click`/`invoke`) changes the most for the most people. A new assertion kind is the smallest useful thing.
>
> 30 minutes: run `node scripts/new-skill.ts --name my-skill` and see how much is already scaffolded.

**答复（中）**
> 三个选项，都在 30 分钟内：
>
> - **先看它是不是真的**：`node bin/deskshell.ts doctor`，再 `node bin/deskshell.ts story --fail`，然后看它留下的那份日志。
> - **写一个你自己真需要的 skill**：`node scripts/new-skill.ts --name my-skill`，只改 `plan()`，`--mode preview` 跑。每个动作要有 post 断言和 undo，难点就这些。
> - **认领一个 issue**：roadmap 里"不需要决策"那一档——Linux 控件层（AT-SPI2）、多显示器/DPI 坐标映射、录制器补拖拽/右键菜单/滚轮、从录制推断 `window.rect` 断言、每步 dry-run diff、撤销时间线视图、`run --parallel`、故障注入、文档站搜索。
>
> 如果只有一个晚上，我的排序：Linux 控件层（AT-SPI2 的 `tree()` 加 selector 级 `click`/`invoke`）对最多人影响最大；加一种断言类型是最小的有用改动。
>
> 30 分钟：跑一次 `node scripts/new-skill.ts --name my-skill`，看看脚手架已经帮你做了多少。

**证据**：`docs/roadmap.md`「Next (no decision needed)」逐条；`scripts/new-skill.ts`；`CONTRIBUTING.md` 里的三条提交前命令。

**不要说什么**："你想做什么都行"——没有边界的选择等于没有选择，他会直接走开。

---

## 9. 「让 AI 操作电脑不安全吧？」

**他真正在问**：出了事谁兜。他也在试探你会不会吹。

**答复（EN）**
> Some of it isn't solvable at this layer, so here's what's structural and what isn't.
>
> Structural: capabilities are declared in the manifest and enforced as a hard check — a skill with `ui.read` cannot click. Preview is the default, so nothing executes without `--mode apply`. Every action needs a post-assertion, so a silently wrong step halts the run instead of compounding. Every step, failures included, is journaled. The kernel has no model, so the model can't reach the disk or the mouse directly — only through actions that were declared.
>
> Not structural: there's no sandbox and no VM isolation. Undo covers file and window-geometry changes; network side effects are not undoable, and the protocol rejects `undo: null`. A dangerous action that passes its assertions will still have happened.
>
> So the honest advice: run it in a disposable VM or a separate user account, keep capability grants narrow, and treat the preview as the review step. If you're looking for "safe by default", this isn't that — it's "auditable and reversible by default".
>
> 30 minutes: `node bin/deskshell.ts run downloads-cleanup --mode apply --grant fs.read` and watch it refuse before touching anything.

**答复（中）**
> 有一部分在这一层解决不了，所以分开说哪些是结构性的、哪些不是。
>
> 结构性的：能力写在清单里并且是硬校验——声明了 `ui.read` 的 skill 点不了鼠标。默认预览，不加 `--mode apply` 一步都不执行。每个动作必须有 post 断言，悄悄错掉的一步会中断，而不是往下叠加。所有步骤（含失败）都进日志。内核里没有模型，模型没法直接碰磁盘和鼠标，只能通过被声明过的 action。
>
> 不是结构性的：没有沙箱，没有虚拟机隔离。撤销覆盖文件和窗口几何；网络副作用不可撤销，协议直接拒收 `undo: null`。一个通过了断言的危险动作，它还是发生了。
>
> 所以实话是：放在一次性虚拟机或单独用户里跑，能力授权给窄一点，把预览当成 review 环节。你要找"默认安全"，这不是；这是"默认可审计、可回退"。
>
> 30 分钟：`node bin/deskshell.ts run downloads-cleanup --mode apply --grant fs.read`，看它在动手之前拒绝你。

**证据**：`spec/protocol-v0.json` 的 `invariants`（动作不得逃出 task root，词法 + 真实路径双重检查）；`STATUS.md` 关键设计决定第 1、2、6 条；`docs/quickstart.md`「Permission denial」。

**不要说什么**："绝对安全"或"我们有沙箱"——前者是谎，后者仓库里没有。

---

## 10. 「我先看看」

**他真正在问**：现在不想承诺，但也没关门。

**答复（EN）**
> Sure — no follow-up needed. If it helps, here's what's worth looking at, in this order:
>
> 1. `spec/protocol-v0.json` — the whole contract, shorter than most READMEs.
> 2. `STATUS.md` — every capability next to the command that proves it, plus a section on what is *not* done.
> 3. `packages/core/src/types.ts` — the `UiDriver` interface: six required methods, two optional.
>
> If any of those make you think "this is wrong", that's the most useful thing you could send me. Watch the repo and you'll see changes in CHANGELOG.md; I won't message you again unless you write back.
>
> 30 minutes: `node bin/deskshell.ts doctor` — one command, tells you whether this platform is even supported.

**答复（中）**
> 行，不追问。如果有点用，按这个顺序看就行：
>
> 1. `spec/protocol-v0.json` —— 整份契约，比多数 README 都短。
> 2. `STATUS.md` —— 每条能力旁边就是证明它的命令，另有一节专门列没做到的。
> 3. `packages/core/src/types.ts` —— `UiDriver` 接口：6 个必选方法，2 个可选。
>
> 如果其中哪一条让你觉得"这是错的"，那是对我最有用的反馈。watch 仓库就能看到 CHANGELOG 的变化；你不回，我不会再发消息。
>
> 30 分钟：`node bin/deskshell.ts doctor`，一条命令，直接告诉你这个平台支不支持。

**证据**：三个文件都真实存在；`spec/protocol-v0.json` 只有 30 行。

**不要说什么**："那我明天再问一下"——"我先看看"就是"别再推了"，再推一次这个人就永久关掉了。

---

## 附：三条通用纪律

1. **先承认对方对的部分**，再给证据。直接反驳会让他转去捍卫原来的判断。
2. **只用一个数字**。一条回复里塞五个指标，等于一个都没记住。
3. **答完就停**。补一句"你也可以看看我们的 roadmap"会把好不容易建立的信任又推回去。
