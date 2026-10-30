# deskshell

![deskshell](brand/banner.svg)

![deskshell demo](assets/hero.gif)

deskshell 不是一个"会点鼠标的 agent"，而是**把整台电脑变成 agent 工具箱的那层运行时**。它把"AI 要做什么"和"怎么保证不出事"彻底分开：

- **Skill** 只描述意图（要做什么），不碰系统 API；
- **Kernel** 负责权限、预览、执行、断言、回滚、审计；
- **Driver** 负责具体平台的操作（Windows UIA / macOS AX / Linux AT-SPI）。

## 一起把它做出来

12 个已经拆好的任务，每个都带可跑的验收命令——没有现金悬赏。你拿到的是：做出来的东西归你维护、名字进贡献者名单、两个 PR 合并后有路线图投票权。

- [贡献者板](https://github.com/ZhiliangTech/deskshell/issues/3) —— 一条评论就能认领
- [任务清单](https://github.com/ZhiliangTech/deskshell/blob/main/outreach/GOOD-FIRST-ISSUES.zh-CN.md) —— 验收标准、工期、我们提供什么
- [Discussions](https://github.com/ZhiliangTech/deskshell/discussions) —— 提问与路线图投票

## 三个概念

**Capability** —— skill 向用户申请的能力，带作用域和人话理由。用户可以不批。

**Action** —— 一步操作，必须声明"执行前必须成立"（pre）、"执行后必须成立"（post）和"怎么撤销"（undo）。

**Journal** —— 审计日志。每一步做了什么、是否成功、怎么撤销，全部落盘。

## 为什么是协议优先

大多数"AI 操作电脑"的项目死在同一个地方：能跑通 demo，但没人敢用。因为用户不知道它下一步要干什么，也不知道出事之后怎么恢复。

deskshell 的答案是：**把信任做成协议的一部分**。

- 没有 post 断言的动作，内核不认；
- 不可撤销的动作，默认拒绝；
- 越出作用域的路径，直接拦掉。

## 现在有什么

- v0 协议与内核（TypeScript，零第三方依赖）
- Windows UIA 驱动（已验证）：枚举窗口、读控件树、点击、输入、按键
- macOS 驱动（实验性）：System Events，支持窗口/控件读取、聚焦、输入、按键
- 三个参考 skill：`downloads-cleanup`、`browser-tabs`、`first-skill`
- 任务录制：焦点 + 鼠标点击 → skill 草稿，自动推断输入断言
- 命令行 demo：预览 / 执行 / 撤销 / 权限拒绝

## 平台状态

| 平台 | 状态 | 验证 |
| --- | --- | --- |
| Windows | 已验证 | `node scripts/verify-driver.ts` |
| macOS | 实验性 | `node scripts/verify-driver.ts --input` |
| Linux | 计划中 | — |

## 许可

MIT。贡献前请读仓库根目录的 `CONTRIBUTING.md`。
