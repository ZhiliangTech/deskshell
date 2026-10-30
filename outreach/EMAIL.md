# EMAIL — 不发 X 也能触达（公开邮箱，全部来自 git 提交记录）

> 这些地址来自他们自己仓库的 commit author 字段，是公开信息。用途只有一个：**发一封一对一的技术邮件**，不复用、不群发、不进任何列表。
> 发送纪律：一次一封、纯文本、无附件、无追踪像素、正文里不出现「营销/合作/推广」这类词；对方回一句「不需要」就永久停。

## 可用的地址（2026-10-30 核对）

| # | 人 | 邮箱 | 仓库 | 语言 | 首句钩子 |
| --- | --- | --- | --- | --- | --- |
| 1 | Richard Abrich (`abrichr`) | richard.abrich@mldsai.com | OpenAdaptAI/OpenAdapt | EN | 重放到第 5 步失败时，UI 停在半路、没有记录 |
| 2 | Shawn (`PM-Shawn`) | 18856489119@163.com | PM-Shawn/Abu-Cowork | 中文 | 一旦动真实文件夹，用户需要能撤回 |
| 3 | caoayu (`ayuayue`) | 1401262639@qq.com | ayuayue/PiDeck | 中文 | 会话面板最终都落到「改文件、点窗口」 |
| 4 | Namhyeon Go (`gnh1201`) | gnh1201@catswords.re.kr | gnh1201/welsonjs | EN | 工业 Windows 场景，错一次的代价比 demo 高 |
| 5 | Zhongsheng Ji (`Wh1isper`) | jizhongsheng957@gmail.com | converge-ai-labs/agent-foundation | 中文 | 自托管 agent 平台，工具层要能自证成功 |
| 6 | 青雲 (`echoVic`) | 137844255@qq.com | echoVic/orca-agent | 中文 | 本地优先 + DeepSeek，断网可用 |
| 7 | Luke Marsden (`lukemarsden`) | me@lukemarsden.net | helixml/helix | EN | 每个 agent 一台桌面 = 一堆无人审计的机器 |
| 8 | `MongLong0214` | weplay0628@gmail.com | logic-pro-mcp | EN | 他自己就写 fail-closed，同一套价值观 |

`divshekhar`（reticle）没有公开邮箱，走 GitHub issue 评论。

---

## 已写好的四封（复制即可发）

### 1. 给 abrichr（EN）

**Subject:** a transaction layer for OpenAdapt replays — would value your read

```text
Hi Richard,

You wrote the replay half of this problem: a person demonstrates once, the agent repeats it. The part I kept hitting is what happens when step 5 fails — the UI is half-driven, the files are half-moved, and nothing records what changed.

I built deskshell around that: every action declares a post-assertion and an undo, preview is the default, and the first failed assertion rolls the task back. Every step, including failures, lands in a JSONL journal. The kernel has no model in it — models only live behind see()/plan() inside a skill.

Windows (UIA) and macOS (AX) drivers are verified; Linux has a window-level driver via xdotool/wmctrl. Protocol v0 is frozen, so the interface you would review is stable.

Two things I would value from you, in order of usefulness:
1. Where you think the post-assertion model breaks for replay (your recording pipeline sees the same events as my recorder).
2. Whether "one failed step rolls back the whole task" is right for a workflow that is genuinely half-legitimate when it stops.

If this is not interesting, reply "no" and I will not write again.

https://github.com/ZhiliangTech/deskshell

— Cicero
```

### 2. 给 PM-Shawn（中文）

**Subject:** 桌面助手的「撤销」那层，想请教你

```text
Shawn 你好，

Abu-Cowork 的交互我看了：用户说想要什么结果，它直接去做。这一步对，但一旦它动的是真实的下载文件夹，用户第一反应是「刚才那个文件去哪了」。

我做的 deskshell 就是这一层：skill 只声明意图，每个动作必须带一条「怎么算成功」的断言和一条 undo，默认只预览不动手，第一条断言失败就把整个任务回滚，全过程写进 JSONL，失败也写。内核零模型依赖，断网可用。

想请你帮两件事之一：
1. 把 Abu-Cowork 里两个真实的办公流程写成 skill（有 fixture，半天能交第一个 PR）；
2. 或者只看协议，告诉我「断言失败就整体回滚」在你的场景里会不会太激烈。

不合适回一句「不用」就行，我不会再发。

https://github.com/ZhiliangTech/deskshell  ·  https://zhiliangtech.github.io/deskshell/
```

### 3. 给 ayuayue（中文）

**Subject:** PiDeck 的会话最后都落到「改文件、点窗口」，这层现在是空的

```text
ayuayue 你好，

PiDeck 把 PI / DSH 的会话收在一个工作台里，这些会话最终都要执行动作：读文件、改文件、点窗口。而执行这层现在没有事务语义——第五步失败，前四步已经改了机器，没人知道改了什么。

deskshell 是把这层做成协议：每个动作有 post 断言和 undo，默认预览，失败先自撤再逆序回滚，全流程 JSONL。内核零模型依赖，Windows / macOS 已验证，Linux 窗口层刚落地。

如果你觉得有价值，最省事的参与方式是把你工作台里最常跑的一个流程写成 skill（`node scripts/new-skill.ts`，只改 plan()）。也欢迎直接挑协议毛病：`spec/protocol-v0.json`。

不合适回一句就行。

https://github.com/ZhiliangTech/deskshell
```

### 4. 给 gnh1201（EN）

**Subject:** atomicity for Windows automation — the industrial case you probably already hit

```text
Hi Namhyeon,

WelsonJS runs automation inside industrial Windows setups, where a wrong click costs more than a failed demo. That is the case I designed deskshell for.

Every action must declare a post-assertion (how we know it worked) and an undo; preview is the default; the first failed assertion rolls the task back; every step, success or failure, is written to a JSONL journal. Protocol v0 is frozen and the driver interface is six required methods.

The Windows driver is verified on UIA, but my recorder still misses right-click, wheel and drag. You have seen more industrial Windows input than I have — is that worth an hour of your time? If not, a one-line "no" is fine.

https://github.com/ZhiliangTech/deskshell
```

---

## 剩下四封的骨架（30 秒改完）

- **Wh1isper**（中文）：`agent-foundation 的工具层需要一个「能证明自己成功了」的执行器；deskshell 的协议 v0 就是这件事。想请你挑毛病，尤其 undo 的 5 种类型够不够。`
- **echoVic**（中文）：`orca-agent 走本地优先 + DeepSeek，和「内核零模型依赖、断网可用」是一路的。半天时间把一个 orca 动作写成 skill，或者直接挑协议。`
- **lukemarsden**（EN）：见下方模板，替换第 2 段为「一台 GPU 桌面 = 一台没人审计的机器」。
- **MongLong0214**（EN）：`你把自己的 MCP server 写成 fail-closed，我的内核写的是「断言失败必须自撤再回滚」——同一套价值观。给我 10 分钟意见：undo 的 5 种够不够。`

## 通用骨架（EN）

```text
Subject: <一句话，具体到他的项目，不要出现 deskshell>

Hi <name>,

<他是谁 + 你读过他什么，一句话，必须具体>

<问题是什么，一句话。不评价他的方案>

<我做的是什么，两句，只讲差异，不列功能>

<一个具体请求：一个问题，或者一个半天能做完的动作>

If this is not useful, a one-line "no" is enough — I will not follow up.

<链接>
```

## 发完之后

- 在 [TRACKER.csv](TRACKER.csv) 把 `channel` 改成 `email`，`outcome` 改成 `sent`，日期填今天。
- 5 天后没回 → 跟进一次（只发一句「补一个证据：<新事实>」），12 天后仍没回 → `dead`。
- **同一邮箱只发一次**。被拒绝或没回，都不再发第二封主题邮件。

## 为什么不发 X 也不影响

- 邮件是**一对一**的，比公开推文更适合「求批评」这种姿态；
- 这些人多数在 GitHub 上活跃、邮箱在 commit 里，收信率不比私信低；
- 邮件里可以写两段技术细节，X 上写不了；
- 不需要养号、不需要粉丝，也不会因为账号新被限流。
