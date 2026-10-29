# 生态冷启动作战计划（deskshell / 阶跃）

> 目标不是“涨 star”，是在 90 天内让 **3 个陌生人稳定提交代码**，并让协议长出第二个平台驱动。
> 文件名里的“阶跃”是项目代号；仓库名 deskshell，协议名 protocol v0。

## 0. 先承认处境

| 事实 | 数字 | 对外怎么说 |
| --- | --- | --- |
| 建仓时间 | 2026-10-29 | 不说“我们做了很久”，说“刚开放，正在找共同作者” |
| star / fork / issue | 1 / 0 / 0 | 不遮掩；把“0 外部贡献者”写成“创始人席位” |
| 已有可信资产 | 协议 v0 冻结、39 项回归（实测 39/39）、13 项驱动契约、Windows 真机 + macOS 真机验证、双语文档站 | 这些才是邀请函，不是 star |
| 最大缺口 | Linux 控件层（AT-SPI2，窗口层已用 xdotool/wmctrl 落地）、录制器事件钩子、没有外部贡献者 | 缺口就是悬赏，越具体越有人来 |

**核心叙事**：AI 已经能操作电脑，但没人给它事务语义。我们把 preview / 断言 / 回滚 / 审计做成了协议，现在缺的是第二个平台、更多 skill，和愿意挑刺的人。

**不要用的叙事**：颠覆、重新定义、下一代操作系统、吊打 pyautogui/Playwright。开发者看到这类词的第一反应是关页面。

## 1. 90 天目标（可验证，不靠感觉）

| 目标 | 度量 | 判定证据 |
| --- | --- | --- |
| G1 首个外部 PR | 1 个非作者账号的 PR 被合并 | GitHub PR 记录 + CONTRIBUTORS.md 新增一行 |
| G2 Linux 控件层 | AT-SPI2 后端让 selector 级 click/invoke 在 X11 上跑通 | scripts/verify-driver.ts 的 linux 分支 + docs/drivers.md 的验证矩阵更新 |
| G3 稳定贡献者 | 3 人各有 ≥2 次合并 | 贡献者看板 |
| G4 生态可见度 | 5 个外部 skill / 2 篇第三方评测或引用 | PR 列表 / 外部链接 |

漏斗数学（取保守值）：

```
有效触达 100 人（读过项目 ≥2 分钟）
  → 回复 15 人（15%）
  → 真正 clone 并跑 doctor 6 人（40%）
  → 交 PR 3 人（50%）
  → 合并 2 人（70%）
```

所以要 3 个稳定贡献者：名单至少 **100 人**、有效触达 **≥100 次**、每人只发一次定制消息。

## 2. 五类开发者，五种钩子

| 画像 | 他们在哪 | 真正在意什么 | 给他什么 |
| --- | --- | --- | --- |
| A. Linux 桌面 / 无障碍工程师（AT-SPI2、Orca、a11y） | topic:accessibility、at-spi 相关仓库、GNOME 社区、r/linux | 别再做 Windows-only；无障碍不是二等公民 | “协议已冻结，只差一个 UiDriver 实现” |
| B. 桌面自动化 / RPA 老兵（pywinauto、AutoHotkey、Robot Framework、Sikuli） | 各仓库 issue、r/automation、V2EX、AHK 论坛 | 脚本一跑就半途失败，留一地垃圾 | “失败自回滚 + 每步后置断言 + 审计日志” |
| C. computer-use / agent 框架作者（browser-use、Open Interpreter、UI-TARS、MCP 生态） | GitHub、Discord、X、HN | 模型很强，执行层不可信；评测无法复现 | “内核零模型依赖，你的模型插在 see()/plan() 后面” |
| D. TypeScript 工具链 / 协议爱好者 | GitHub、HN、掘金 | 接口设计、迁移成本、破坏性变更 | “协议 v0 冻结 + 回归套件 + RFC 流程” |
| E. 内容型开发者（评测、视频、awesome list） | X、掘金、知乎、小红书、newsletter | 有没有新鲜且能讲清楚的东西 | “30 秒能讲完的真实现象：三次操作一次撤销” |

**判断**：A 和 C 是共建者，B 是使用者转贡献者，D 是评审者，E 是放大器。第一批私信只发 A 和 C。

## 3. 十二条获取渠道（按性价比排序）

| # | 渠道 | 具体动作 | 每日配额 | 预期 |
| --- | --- | --- | --- | --- |
| 1 | 精准 GitHub 私信 / 邮件 | 用 TARGETS.md 的 A 档名单，一人一段定制开场，先提他自己的实现细节 | 5-10 | 最高，回复率 10-20% |
| 2 | 在别人仓库做技术评论 | 找“撤销 / 失败恢复 / 录制”相关 open issue，给可运行思路，末尾一句“我们在做同样的事” | 2-3 | 中高，积累信誉 |
| 3 | 自建悬赏 issue | 12 个带验收标准的任务，good first issue + bounty 标签 | 一次性 | 让回复的人有落点 |
| 4 | awesome-list PR | awesome-computer-use、awesome-ai-agents、awesome-automation，一页说明 + 证据链接 | 每周 3-5 | 长尾，持续数年 |
| 5 | Show HN | 标题只讲一个事实：“AI 操作电脑，每一步都能撤销”；附 demo gif | 一次 | 要么 0 要么 200 |
| 6 | Reddit | r/LocalLLaMA（协议与执行层）、r/automation（回滚）、r/opensource（治理）各一帖 | 每周 2 | 中 |
| 7 | V2EX 分享创造 | 中文、讲工程细节、不吹 | 一次 | 中，评论区质量高 |
| 8 | 掘金 / 知乎 | 长文《为什么 AI 操作电脑需要事务语义》，带真实失败案例 | 每两周 1 | 中，适合招中文贡献者 |
| 9 | X / Twitter | 5 条 thread + 每周 2 条“今天修了什么” | 每天 1 | 低但复利 |
| 10 | Discord / Slack | 先潜水回答问题，第二周才提项目 | 每周 3 个社区 | 中 |
| 11 | newsletter / 播客投稿 | 给 5 个 AI 工程类 newsletter 投 150 字 pitch | 每月 5 | 低 |
| 12 | 线下 meetup / 黑客松 | 带一台 Windows 机器现场演示“三次操作一次撤销” | 每月 1 | 高信任 |

**渠道纪律**：同一渠道连发 3 次无回复 → 停 30 天；不在别人 issue 贴链接除非对方问了；不群发、不 @ 全员、不买 star。

## 4. 邀请的正确顺序（决定性细节）

大多数人失败在顺序：先夸项目，再要人。正确顺序是 **先证明你懂他，再给一个 30 分钟能完成的具体动作**。

1. **开场（≤25 字）**：提他仓库里的一个具体实现细节（“你在 xxx 里用 AXObserver 替代轮询那段”）。
2. **共识（1 句）**：说出他已经在解决的问题，不评价好坏。
3. **差异（1 句）**：我们多做了一件事——把 preview / 断言 / 回滚 / 审计变成协议，内核零模型依赖。
4. **具体请求（1 个）**：只给一个任务，附链接、验收命令、预计耗时。
5. **退出通道**：“不合适回一句 no 就行，我不会再打扰。”

追问节奏：首次触达 → 5 天后跟进 1（补一个新证据：CI 绿 / 新 skill / 有人合并了）→ 12 天后跟进 2（最后一次，给出口）。**两次之后不再发。**

## 5. 让人留下来的机制（比拉新更重要）

- **48 小时首响**：任何 issue / PR 48 小时内有人回，哪怕只是“我看过了，周三给结论”。
- **30 分钟首个 PR**：文档 typo、skill.json 校验、新增一条测试都算，必须有 5 个这种入口。
- **署名可见**：CONTRIBUTORS.md 按贡献类型分节；README 不放虚的贡献者墙，放真实合并记录。
- **所有权**：驱动 = 平台维护者；skill = 作者自治；协议 = RFC。给出所有权，人才会长期留下。
- **不夺功**：release note 写清谁做的；不把别人的 PR 重写后署自己名。

## 6. 30 / 60 / 90 天节奏

| 阶段 | 重点 | 交付 |
| --- | --- | --- |
| Day 1-7 | 铺基础设施：悬赏板、贡献阶梯、12 个 issue、README 钩子 | 别人来了能自助 |
| Day 8-21 | A 档 10 人 + B 档 10 人首触；3 个 awesome-list PR；Show HN 一次 | 首批回复 |
| Day 22-45 | 把回复转成 PR：每人一个 issue、一个 fixture、一个 15 分钟录屏 | 首个外部 PR |
| Day 46-70 | 中文渠道（V2EX / 掘金 / 知乎）+ 3 个社区；首个贡献者升 Skill Author | 3 个贡献者 |
| Day 71-90 | 复盘渠道 ROI，砍掉最差 2 个；发第一期 Contributor Update | 稳定节奏 |

## 7. 风险与对策

| 风险 | 现实表现 | 对策 |
| --- | --- | --- |
| 被当 spam | 账号被限、issue 被删 | 一人一稿、先给价值、遵守各社区规则、不贴裸链接 |
| 协议变更吓退人 | “现在写会不会白写” | 协议 v0 冻结写进 README 顶部；破坏性变更走 RFC + 迁移脚本 |
| 单人维护瓶颈 | PR 堆积 → 贡献者流失 | 评审 SLA 写死；先合小 PR；给可信的人 triage 权限 |
| star 太少没人信 | 打开就关 | 用证据替代声量：39 项回归实测、真机验证、失败回滚日志截图 |
| 中英文档漂移 | 两套文档不同步 | 英文为准，zh-CN 由贡献者认领；build-docs.ts 一次生成两站 |

## 8. 业主已拍板（2026-10-30 定稿，不再翻案）

| 事项 | 决定 | 现状 |
| --- | --- | --- |
| 现金悬赏 | **不做**。`bounty` 标签只表示"可认领、有验收标准、有署名"，不涉及任何钱 | 已在两版任务板与 issue 模板里写明 |
| Discussions | **已开** | 公告 [discussion #10](https://github.com/ZhiliangTech/deskshell/discussions/10)，路线图投票 [#11](https://github.com/ZhiliangTech/deskshell/discussions/11) |
| Roadmap 决策权 | **已公开**：2 个合并 PR 即获得正式一票，投票在 Discussions 里公开计票 | 见 CONTRIBUTOR-LADDER 第 93 行、GOVERNANCE |
| 迁到 org | **待办（卡在平台上）**：当前账号没有任何 org，GitHub REST 也不允许用个人账号建 org；需要先在网页建 org，再 `/repos/{owner}/{repo}/transfer` | 见下方"迁 org 的实际步骤" |
| 公共 npm | **待办（卡在凭据上）**：本机无 npm CLI、`~/.npmrc` 无 token、环境变量里也没有 `NPM_TOKEN`；`scripts/publish-npm.ts` 已就绪 | 给一个 token 就能发，见下方命令 |

### 迁 org 的实际步骤（3 分钟）

1. 打开 <https://github.com/account/organizations/new>，建一个免费 org（建议 `deskshell-dev` 或与你 GitHub 账号同名的 org）。
2. 执行：`POST /repos/ZhiliangTech/deskshell/transfer`，body `{"new_owner":"<org>"}`（我有 token，说一声就发）。
3. 转移后记得改这三处引用：README 里的徽章链接、`package.json` 的 `repository`/`homepage`、`install.ps1` 里的 raw 地址；npm 包名 `@zhiliangtech/deskshell` 可以保留不动。

### 发公共 npm 的实际步骤（1 条命令）

```bash
NPM_TOKEN=npm_xxx node scripts/publish-npm.ts            # 先跑 --dry-run 看打包清单
```

> 需要的 token 类型：Automation token，权限 `read+write packages`。没有 token 之前，安装通道保持 `install.ps1` + GitHub Packages 两条，README 里已经写清。

