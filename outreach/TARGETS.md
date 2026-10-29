# TARGETS — 候选名单（真实 GitHub 数据，2026-10-30）

> 数据来自 `candidates.json`（`scan.mjs` 实测，120 人 / 唯一的仓库 owner 或前 2 名贡献者），已剔除机器人账号与同仓库重复贡献者。
> A 档 = 已写好私信，见 [SEND-QUEUE.md](SEND-QUEUE.md)；B 档 = 值得单独写一封；C 档 = 放大器（列表 / 内容 / 生态位）。
> 发送纪律：一天最多 5 条，同一仓库最多 2 人，两次跟进后不再发。

## A 档 · 直接共建（已排队，10 人）

| handle | 代表仓库 | 为什么匹配 | 邀请项 | 渠道 |
| --- | --- | --- | --- | --- |
| `abrichr` | OpenAdaptAI/OpenAdapt · 1.8k★ | 演示重放，失败后没有事务语义 | 协议评审 + 录制器输入覆盖 | X @abrichr |
| `AmrDab` | AmrDab/clawdcursor · 406★ | 给 agent "safe desktop control"，缺断言与撤销 | MCP adapter 对齐 | GitHub issue |
| `PM-Shawn` | PM-Shawn/Abu-Cowork · 412★ | 桌面办公助手直接改文件 | 写 2 个 skill | X @pmshawn_x |
| `ayuayue` | ayuayue/PiDeck · 1.2k★ | 统一管理 PI / DSH 会话 | 接 preview/undo 或写 skill | 仓库 issue（中文） |
| `gnh1201` | gnh1201/welsonjs · 512★ | Windows 工业自动化，误操作成本高 | 录制器输入覆盖 | GitHub / 官网 |
| `lukemarsden` | helixml/helix · 824★ | 每个 agent 一台 GPU 桌面，无人值守 | undo 边界评审 | X @lmarsden |
| `Wh1isper` | agent-foundation · 242★ | 自托管 agent 平台，工具层要可验证 | 协议评审 | 博客（中文） |
| `MongLong0214` | logic-pro-mcp · 160★ | 自己就写 "fail-closed" | 挑协议的毛病 | GitHub issue |
| `divshekhar` | reticlehq/reticle · 1.3k★ | "agent 看不懂自己造了什么" | undo 语义评审 | X @dshekhar17 |
| `echoVic` | echoVic/orca-agent · 511★ | DeepSeek-native、本地优先 | 把一个动作写成 skill | GitHub（中文） |

## B 档 · 值得单独写一封（10 人，本轮新增）

| handle | 代表仓库 | 为什么匹配 | 邀请项 | 渠道 | 开场句要点（≤25 字） |
| --- | --- | --- | --- | --- | --- |
| `lahfir` | lahfir/agent-desktop · 1.8k★ | Rust 写的可靠 computer use，读真实 UI 结构 | 驱动/树接口评审 | X @mdlahfir | "你读真实 UI 结构那段，和我 tree() 撞了" |
| `lerogo` | AMAP-ML/LongHorizon-Harness · 1.8k★ | 长时程 computer-use，跑久了最怕半途失败 | 断言与回滚语义 | GitHub issue | "长跑任务第 N 步失败，你怎么收场" |
| `qufei1993` | qufei1993/skills-hub · 1.8k★ | 跨平台管理 Agent Skills 并同步 | skill 分发/注册表 | GitHub issue（中文） | "你管 skill 分发，我管 skill 能不能撤销" |
| `hiyouga` | penguin-harness · 3.1k★ | 北京，训练+执行栈，工程判断强 | 协议评审 | X @code_hiyouga | "你的 harness 缺一层执行事务语义" |
| `3361559784` | moeru-ai/auv · 195★ | 武汉，OS 自动化编排层，0 token | 驱动/编排对接 | GitHub（中文） | "你也把 OS 自动化当编排层" |
| `FunctionFreak` | ComputerUseAgent/AutoCua · 803★ | 跨 macOS/Win/Linux/浏览器的 CUA | 多平台驱动矩阵 | GitHub issue | "你的跨平台矩阵，正好缺 Linux 控件层" |
| `harshitsinghbhandari` | agent-orchestrator · 13.8k★ | 桌面端调度 agent 舰队到合并 PR | 执行层可审计 | X @the_hsbhandari | "舰队跑起来后，谁证明每一步成了" |
| `eliasstravik` | eliasstravik/shepherdr · 989★ | 跨机器跑多个 coding agent | 远程执行审计 | X @eliasstravik | "跨机器跑 agent，审计日志在哪" |
| `aicodeking` | aicodeking/pandacode · 857★ | 桌面 coding agent 工作台 | skill 作者 | GitHub issue | "calm workspace，缺一个 undo 按钮" |
| `Eynzof` | Eynzof/Hermes-CN-Desktop · 1.7k★ | Tauri + Rust 的 Windows-first 桌面 agent | 驱动契约 | 官网/GitHub | "Windows-first 的桌面 agent，驱动最难" |

## C 档 · 放大器（列表维护者与内容型，10 个）

| handle | 载体 | 为什么找他 | 请求 |
| --- | --- | --- | --- |
| `ranpox` | awesome-computer-use | 最贴题的 awesome list | 按 [AWESOME-LISTS.md](AWESOME-LISTS.md) 提 PR |
| `ZoranPandovski` | awesome-testing-tools | 规则宽松，收 desktop/UI automation | 提 PR（Desktop 分类） |
| `lukeslp` | awesome-accessibility | 收工具，且看重"在维护" | 先开 issue 再 PR |
| `punkpeye` | awesome-mcp-servers · 97k★ | 量最大的 MCP 入口 | **等 MCP adapter 合并后**再投 |
| `yzfly` | Awesome-MCP-ZH | 中文 MCP 生态入口 | 同上，adapter 之后 |
| `WenyuChiou` | awesome-agentic-ai-zh · 8k★ | 中文 agentic 路线图，受众精准 | 投稿「执行层」一节 |
| `777genius` | agent-notifications · 837 followers | 跨工具通知，触达面广 | 互相引用/联调 |
| `DayuanJiang` | next-ai-draw-io · 36k★ | MCP + 桌面端双形态，影响力大 | 技术互评（不推销） |
| `ulivz` | bytedance/UI-TARS-desktop · 39k★ | 行业标杆，回复概率低但值得一次 | 只发一次，求批评不求采用 |
| `QinghongLin` | showlab/computer_use_ootb · 2k★ | 学术向 GUI agent，评测视角 | 请他用我们的 journal 做可复现性评测 |

## 扫描方法与复现

```bash
GITHUB_TOKEN=... node outreach/scan.mjs        # 输出 candidates.json / candidates.csv
```

- **查询面**：`topic:computer-use`、`topic:desktop-automation`、`topic:uia`、`topic:accessibility`、`topic:mcp`、`topic:agent`，以及关键词 `computer use agent`、`desktop agent`、`screen automation`、`pywinauto`、`at-spi2`、`windows automation`、`mcp server desktop`。
- **取样规则**：仓库 20–2000★ 优先、近 90 天有提交；每个仓库取 owner + 前 2 名贡献者；剔除 `claude` / `cursoragent` / `github-actions` / `dependabot` 等账号。
- **已知偏差**：① star 少 ≠ 不活跃，名单里 100–500★ 的仓库回复率往往更高；② 中国开发者 GitHub 资料常空，看仓库语言和 issue 语言补；③ contributors 接口按提交数排序，会漏掉只做 issue/评审的人 —— 那类人只能靠人工翻 issue 找。
- **下一步**：每 30 天重跑一次；本轮 120 人里只用了 30 个，剩下 90 个在 `candidates.json`，需要时再筛。
