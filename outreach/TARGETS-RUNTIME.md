# TARGETS · agent 运行时 / 沙箱 / CUA（新框架下的第一批）

> 定位换了，名单就得换：这些人不是"写自动化脚本的人"，是**给 agent 提供一台计算机的人**。
> 跟他们谈的不是"我们点得准"，而是"你们的 agent 拿到机器之后，那台机器有没有合同"。

## 为什么是这三类

| 类别 | 他们已经在做的事 | 我们补的那一块 | 谈什么 |
| --- | --- | --- | --- |
| **沙箱 / 运行环境**（e2b、daytona、agent-infra/sandbox） | 给 agent 一台可丢弃的机器：文件、shell、浏览器、MCP | 机器内部的动作没有合同：跑完不知道成没成，坏了不能退 | 把 action contract 作为沙箱的一个暴露面（MCP tool 或 SDK） |
| **CUA 驱动 / 框架**（trycua/cua、AmrDab/clawdcursor） | 真实驱动 + 跨 OS 沙箱 + benchmark | 驱动只说"调用返回了"，不说"世界变了" | 驱动契约的三层拆分（invoke / post / undo），以及失败分类 |
| **agent 运行时**（open-interpreter、browser-use） | 让模型在真实环境里连续行动 | 长任务里第一个失败就污染全局，且无审计 | 断言 + 回滚 + journal，作为 runtime 的一等公民 |

## 名单（公开邮箱来自各自 commit，2026-10-30 核对）

| # | 对象 | 规模 | 邮箱 / 渠道 | 切入角度 |
| --- | --- | --- | --- | --- |
| 1 | `e2b-dev/E2B` | 14.6k★ | hello@e2b.dev | 沙箱已经把机器给了 agent，缺的是动作级合同；可以从"一个 sandbox 里跑一个可撤销任务"的最小 demo 谈 |
| 2 | `daytonaio/daytona` | 71k★ | support@daytona.io | 同一台 dev 环境被 agent 连续改动：谁证明改成了、怎么退回去 |
| 3 | `trycua/cua` | 31k★ | gh@trycua.com | 他们做驱动 + 沙箱 + benchmark；我们做断言与回滚，正好是 benchmark 缺的那半 |
| 4 | `agent-infra/sandbox` | 6.2k★ | GitHub issue | All-in-One Sandbox 已经有 browser/shell/file/MCP，最自然的接缝是 MCP tool 层 |
| 5 | `OpenInterpreter/open-interpreter` | 69k★ | GitHub issue / Discussions | 长任务执行器，最痛的是中途失败后的状态 |
| 6 | `browser-use/browser-use` | 120k★ | GitHub issue | 浏览器侧已经很成熟；桌面侧是空白，且不想自己做驱动 |

## 三封已写好的（新框架，不是"我们点得准"）

### 1. e2b（EN）

**Subject:** your sandbox gives the agent a machine — who gives it a contract?

```text
Hi e2b team,

You already solved the hard infrastructure half: an agent gets a disposable machine with files, a shell, a browser.

The half I keep hitting is inside that machine. An action returns cleanly and nothing happened. A five-step task fails at step four and the first three changes stay. Nobody can say afterwards what changed.

I built deskshell as that layer: every action declares a capability, a post-assertion and an undo; the first failed assertion rolls the task back; every step lands in a JSONL journal. The kernel has no model in it, so it drops into whatever runtime is calling it.

The seam I would like your opinion on: should this live *below* the sandbox API (a sandbox that only accepts contracted actions), or *above* it (a runtime your users opt into)? That answer changes what I build next.

Not useful? One line "no" is enough.

https://github.com/ZhiliangTech/deskshell
```

### 2. daytona（EN）

**Subject:** an agent edits a dev environment for an hour — what proves the edit, and what undoes it?

```text
Hi Daytona team,

Your environments are long-lived and the agent keeps working inside them. That is the case where "the command returned" and "the environment changed" stop being the same statement.

deskshell makes the second statement checkable: each action carries a post-assertion and an undo, preview is the default, a failed assertion rolls the task back, and the journal records failures too. No model in the kernel — it is a runtime layer, not an agent.

I would value one critique from you: for a long-lived environment, is per-task rollback the right unit, or should the undo boundary be a checkpoint the user picks?

https://github.com/ZhiliangTech/deskshell
```

### 3. trycua（EN）

**Subject:** your benchmark measures whether the agent finishes — does it measure whether it could have stopped?

```text
Hi cua team,

You have the drivers, the cross-OS sandboxes and the benchmark. The gap I see in that stack is not capability, it is recovery: a run that fails at step 4 leaves the machine changed, and the benchmark scores it as a failed run without saying what state it left behind.

deskshell is the layer underneath: declared actions, post-assertions, per-step undo, rollback on first failure, JSONL audit. Kernel with no model, so it does not compete with your drivers — it constrains them.

Two concrete asks: (1) would an "undoable task" axis belong in your benchmark? (2) if a driver had to expose one extra method for that, what would it be?

https://github.com/ZhiliangTech/deskshell
```

## 发信规则（沿用，不放松）

- 一封一个人，纯文本，UTF-8（上次 GBK 已把破折号弄坏），无附件、无追踪像素；
- 第一段必须证明你看过他们在做什么；不写 "revolutionary / next-gen"；
- 对方回 "no" 就永久停；
- 发完在 TRACKER.csv 记一行，渠道写 `email`。

## 与旧名单的关系

旧名单（[TARGETS.md](TARGETS.md)）不是废掉，而是降级：`gnh1201`、`PM-Shawn`、`ayuayue` 这类仍然值得发，但他们是**使用者**（用我们的东西做自己的事），不是**共建者**（把我们的东西嵌进 agent 运行时）。两层要分开谈，别用同一套话术。
