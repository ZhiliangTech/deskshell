# 首发名单 · 10 条已写好、可直接发（2026-10-30）

> 数据来源：`candidates.json`（120 人，GitHub API 实测）+ 各自 top repo 的真实描述。
> 规则：**一人一稿，第一句必须关于他**；GitHub 没有私信功能，所以渠道写的是"哪里能找到他"（X / 邮箱 / 他自己仓库的相关 issue）。
> 发之前做三件事：① 打开他的仓库确认描述还成立 ② 把 `{...}` 换成真实内容 ③ 在 TRACKER.csv 记一行。

## A 档（直接共建，先发这 6 个）

| # | handle | 代表仓库 | 为什么是他 | 邀请项 | 渠道 |
| --- | --- | --- | --- | --- | --- |
| 1 | `abrichr` | OpenAdaptAI/OpenAdapt · 1.8k★ | 录一次人类演示、然后重放——重放失败时没有事务语义，正是我们要补的那层 | 协议评审 + 录制器输入覆盖（右键/滚轮/拖拽） | X @abrichr / openadapt.ai |
| 2 | `AmrDab` | AmrDab/clawdcursor · 406★ | 本地 MCP server 给 agent "safe desktop control"，安全靠权限门，缺"断言+撤销" | MCP adapter 设计对齐 + 驱动契约评审 | GitHub issue / 仓库 Discussions |
| 3 | `PM-Shawn` | PM-Shawn/Abu-Cowork · 412★ | 桌面办公助手，"describe the result" 直接改文件，最需要可撤销 | 把 2-3 个办公流程写成 skill | X @pmshawn_x |
| 4 | `ayuayue` | ayuayue/PiDeck · 1.2k★ | 桌面工作台统一管理 PI / DSH agent 会话——你的用户就在产生桌面动作 | 在你的会话面板里接 deskshell 的 preview/undo（或先写一个 skill） | 仓库 issue（中文） |
| 5 | `gnh1201` | gnh1201/welsonjs · 512★ | Windows 工业自动化的 JS 运行时，一次误操作的成本比 demo 高得多 | 录制器输入覆盖 / 驱动评审（Windows 侧你比我熟） | GitHub / catswords.com |
| 6 | `lukemarsden` | helixml/helix · 824★ | "每个 agent 一台 GPU 桌面"——一堆无人值守的桌面，最缺审计与回滚 | 场景评审：多桌面下的 undo 边界该怎么划 | X @lmarsden / helix.ml |

## B 档（小 PR / 评审，A 档回信后再发）

| # | handle | 代表仓库 | 为什么是他 | 邀请项 | 渠道 |
| --- | --- | --- | --- | --- | --- |
| 7 | `Wh1isper` | converge-ai-labs/agent-foundation · 242★ | 自托管 agent 平台，工具层需要可验证的执行器 | 协议评审 / MCP adapter | 博客 blog.wh1isper.top（中文） |
| 8 | `MongLong0214` | MongLong0214/logic-pro-mcp · 160★ | 已经用 "fail-closed" 描述自己的 MCP server——同一套价值观 | 读一遍 spec/protocol-v0.json，挑毛病 | GitHub issue |
| 9 | `divshekhar` | reticlehq/reticle · 1.3k★ | "agent 能写代码但看不懂自己造了什么"——验证侧的同路人 | 评审 undo 语义 / 交叉引用 | X @dshekhar17 |
| 10 | `echoVic` | echoVic/orca-agent · 511★ | DeepSeek-native coding agent，广州，本地优先 | skill 作者（把 orca 的一个动作变成可撤销 skill） | GitHub / echovic.com（中文） |

---

## 1. abrichr（OpenAdapt）

```text
Hi abrichr — OpenAdapt replays a demonstration, but when step 5 fails you are left with a half-driven UI and no record of what changed.

I built deskshell for exactly that: every action declares a post-assertion and an undo, preview is the default, and a failed assertion rolls the task back into a JSONL journal. The driver interface is frozen (6 required methods), protocol v0 is frozen too.

I would value your read on it — your recorder sees the same events mine does. If the model is wrong, tell me where. https://github.com/ciceroyang/deskshell
```

跟进（5 天后，只发一次）：`One more thing worth your 2 minutes: the Linux window-level driver shipped last week, control tree still missing — that is the part I suspect you would do differently.`

## 2. AmrDab（clawdcursor）

```text
Hi AmrDab — clawdcursor gives agents desktop control with a permission gate, which is the right first move. The part I keep hitting is what happens *after* the gate opens: the click returns, and nobody knows whether it worked.

deskshell makes that a protocol question: every action declares a post-assertion and an undo, preview is the default, failures roll back, and the journal records even the failures. Kernel has no model in it.

Your MCP surface and my kernel are complementary — I would like your critique of the tool contract before I ship an adapter. https://github.com/ciceroyang/deskshell
```

## 3. PM-Shawn（Abu-Cowork）

```text
Hi PM-Shawn — "describe the result and it does it" is the right UX, but the moment it touches a real folder, the user needs to be able to take it back.

deskshell is that layer: skills only declare intent, every action must prove success and carry an undo, preview is the default, and one failed assertion rolls the whole task back. Windows/macOS drivers verified; Linux window-level shipped.

If you want, take downloads-cleanup and photo-sort as references — 30 minutes, `node bin/deskshell.ts doctor`. https://github.com/ciceroyang/deskshell
```

## 4. ayuayue（PiDeck，中文）

```text
ayuayue 你好。PiDeck 把 PI / DSH 的会话收在一个桌面工作台里，这些会话最终都要落到"改文件、点窗口"上，而这层现在没有事务语义——第五步失败，前四步已经改了机器。

我做的是这层：skill 只声明意图，每个动作必须有 post 断言和 undo，默认只预览，断言失败先自撤再逆序回滚，全过程写 JSONL 审计。内核零模型依赖，Windows/macOS 已验证，Linux 窗口层刚落地。

想请你看一眼协议（spec/protocol-v0.json）够不够接住你的会话面板；如果愿意，认领一个 skill 最快。https://github.com/ciceroyang/deskshell
```

## 5. gnh1201（WelsonJS）

```text
Hi gnh1201 — WelsonJS runs automation inside industrial Windows setups, where one wrong click costs more than a failed demo. That is the case I designed for.

deskshell requires every action to declare a post-assertion and an undo, previews by default, rolls back on the first failed assertion, and journals every step including failures. Protocol v0 is frozen; the driver interface is six methods.

The Windows driver is verified on UIA, but my recorder still misses right-click, wheel and drag. You have seen more Windows input than I have — is that worth an hour of your time? https://github.com/ciceroyang/deskshell
```

## 6. lukemarsden（helix）

```text
Hi Luke — helix gives each agent its own GPU desktop. That is a fleet of machines whose actions nobody can audit after the fact.

deskshell is a transaction layer for exactly that: preview by default, post-assertion per action, rollback on failure, JSONL journal per task, kernel with no model dependency. MIT, TypeScript, ~1 day old and honest about it.

I would like your critique of one design question: when an agent owns a whole desktop, where should the undo boundary sit? https://github.com/ciceroyang/deskshell
```

## 7–10（B 档，短版，回信后再扩写）

- **Wh1isper**：「agent-foundation 的工具层需要一个"能证明自己成功了"的执行器。deskshell 的协议 v0 就是干这个的，想请你挑毛病：spec/protocol-v0.json。零依赖，Windows/macOS 已验证。」
- **MongLong0214**：「你的 MCP server 写的是 fail-closed，我的内核写的是"断言失败必须自撤再回滚"——同一套价值观。想请你看 10 分钟协议，尤其是 undo 的 5 种类型够不够。」
- **divshekhar**：「Reticle 解决"agent 看不懂自己造了什么"，我解决"agent 不知道自己改成了没有"。两边都在补同一个洞，想听你对 undo 语义的意见。」
- **echoVic**：「orca-agent 走本地优先 + DeepSeek，和 deskshell 的"内核零模型依赖、断网可用"是一路的。想请你把 orca 的一个动作写成 skill（半天），或者直接挑协议的毛病。」

---

## 发送节奏（不要一次发完）

| 天 | 动作 |
| --- | --- |
| D1 | 发 #1 #2 #3（英文，A 档） |
| D2 | 发 #4 #5（中文 + 英文） |
| D3 | 发 #6，同时去 #1 #2 的仓库做一次技术评论（不贴链接） |
| D5 | 对没回的三位发跟进 1 |
| D8 | 发 #7 #8（B 档） |
| D12 | 发 #9 #10 + 跟进 2（最后一次） |

每天最多 5 条，同一仓库最多 2 人。**回信优先于新触达**——48 小时内没回信的人，比 100 个新名单重要。
