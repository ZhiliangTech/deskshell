# STATE — 对外事实快照（每次发布/迁移后更新）

> 这份文件只写**已经验证过的事实**，给运营、外联和任何新会话当唯一口径。与它冲突的旧文案以本文件为准。
> 最后核对：2026-10-30 02:20（Asia/Shanghai）

## 仓库与站点

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/ZhiliangTech/deskshell>（已从个人账号迁到 `ZhiliangTech` org，旧地址 301） |
| 文档站 | <https://zhiliangtech.github.io/deskshell/>（Pages，push main 自动构建，en / zh-CN 各 15 页） |
| 讨论区 | <https://github.com/ZhiliangTech/deskshell/discussions>（公告 #10、路线图投票 #11） |
| 贡献者板 | <https://github.com/ZhiliangTech/deskshell/issues/3> |
| 安装脚本 | `https://raw.githubusercontent.com/ZhiliangTech/deskshell/main/install.ps1` |
| 回归套件 | `node scripts/regress.ts` → **43/43 passed**（本机实测） |

## 安装渠道（全部实测）

| 渠道 | 命令 | 状态 |
| --- | --- | --- |
| 安装脚本 | `irm …/install.ps1 -OutFile install.ps1; .\install.ps1` | 可用，走 GitHub API 下载 release 资产 |
| GitHub Packages | `npm config set @zhiliangtech:registry https://npm.pkg.github.com` + token → `npm i -g @zhiliangtech/deskshell` | 可用，**0.9.0 / 0.10.0 / 0.11.0** 已发布，latest = 0.11.0 |
| Git 直装 | `npm i -g github:ZhiliangTech/deskshell` | 可用，不经过任何 registry |
| Release 资产 | 每个 tag 都带 `zhiliangtech-deskshell-<ver>.tgz` | 可用（v0.9.0 起） |
| 公共 npm | `npm i -g deskshell` | **不可用**：registry 上只有 `0.0.0-stage` 占位，真版本要维护者用 2FA 批准（见 docs/install.md §5） |

## 对外口径（一句话）

> 把电脑塞进 agent 里：每个动作都可声明、可断言、可撤销、可审计；内核里没有模型。
> The machine as a toolbox inside the agent: every action is declared, asserted, undoable, audited — and there is no model in the kernel.

## 不能说 / 不要承诺

- 没有现金悬赏，`bounty` 只表示"可认领"。被问钱就直接说没有。
- 公共 npm 还不能用，不要写 `npm i -g deskshell`。
- Linux 是「窗口层已实现（xdotool + wmctrl）、控件层待 AT-SPI2」，不是"没驱动"。
- 没有用户数、star 数、融资、合作方、benchmark 可以引用。

## 运营入口

- 每小时流程：[HOURLY.md](HOURLY.md)（先读本文件，再看 TRACKER）
- 名单与私信：[TARGETS.md](TARGETS.md)、[SEND-QUEUE.md](SEND-QUEUE.md)
- 渠道与文案：[CHANNELS.md](CHANNELS.md)、[messages/](messages/)、[OBJECTIONS.md](OBJECTIONS.md)
- 任务板：[GOOD-FIRST-ISSUES.md](GOOD-FIRST-ISSUES.md)（唯一编号来源 GFI-01..12）
- 流水：[TRACKER.csv](TRACKER.csv)；来信处置：[INBOUND.md](INBOUND.md)
