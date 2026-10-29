# RFC 流程与模板

这份目录放**会改变别人代码**的提案。协议 v0 冻结在 `spec/protocol-v0.json`，任何语义改动都得先在这里说清楚，再动代码。

## 什么必须走 RFC

- 改 `spec/protocol-v0.json` 的任何内容。
- 改 `Action` / `Assertion` / `Undo` 的语义，或新增类型。
- 改内核的事务边界：什么时候回滚、回滚到什么程度、失败如何进日志。
- 新增第三方运行时依赖（破坏"零依赖"不变量）。
- 改贡献政策、许可、治理规则。

## 什么不走 RFC

- 给 `UiDriver` **增加**可选方法（现有实现退回 `not implemented` 即可）。
- 新增 skill、修 bug、改文档、改测试、加只读 CLI 命令。
- 内部数据格式（例如录制器 JSONL）的变化——改完更新 `docs/recording.md` 即可。

判断标准一句话：**这个东西发出去之后，别人的代码会不会因此必须改？** 会，就是 RFC。

## 编号与命名

- 文件名：`rfcs/NNNN-kebab-slug.md`，四位数、不回收、不复用。
- 编号取当前最大编号 + 1。第一个 RFC 是 `0001`；不要为小事占号。
- PR 标题：`rfc(NNNN): <一句话>`。

## 状态机

```
Draft ──► Review ──► Accepted ──► Implemented
  ▲          │           │
  └──────────┘           └──► Rejected
     (打回需写理由)
```

| 状态 | 含义 | 谁能改到这个状态 |
| --- | --- | --- |
| Draft | 作者还在写，欢迎随便提意见 | 作者 |
| Review | 提案已完整，进入至少 7 天的公开评审窗口 | 作者（提交时） |
| Accepted | 方向定了，等待实现 | 维护者 |
| Implemented | 实现已合并，CHANGELOG 有迁移说明 | 实现的 PR 作者 |
| Rejected | 不做，**理由必须写进文件本身**，不只在 PR 评论里 | 维护者 |

两个约束：

1. 状态变更必须改文件顶部的 `Status:` 行，并在 `## History` 里追加一行日期 + 谁 + 为什么。历史只追加，不删除。
2. 一个 RFC 被接受后两周内没有对应实现 PR，维护者可以把它降回 `Draft`——避免"看着已经决定了"的假象。

## 必须包含的内容

一份 RFC 少任何一节，评审不会开始：

1. **Motivation** — 现在哪里痛，谁痛，有多具体。不要写"更优雅"。
2. **Protocol diff** — 改了什么（类型、字段、语义），用 before/after 对照，不要只说"支持 X 了"。
3. **Migration** — 现有 skill、现有 `.deskshell/journal.jsonl` 怎么办；是否需要迁移脚本；旧数据能不能读。
4. **Regression evidence** — 命令与真实输出。至少要有：
   - `node scripts/protocol-freeze-test.ts` 全绿（或说明为什么这个测试本身要改，那是更强的信号）；
   - `node scripts/compat-test.ts` 全绿；
   - `node scripts/snapshot-test.ts` 输出 `3/3 snapshots match`，或者列出每个受影响的快照与理由；
   - `node scripts/regress.ts` 全绿。
5. **Alternatives** — 至少两个被否掉的方案，以及否掉的理由。
6. **Rollback** — 如果上线后发现错了，怎么退回去。

## 模板

把下面整段复制到 `rfcs/NNNN-your-slug.md`，填完再开 PR。

```markdown
# RFC NNNN — <标题>

- Status: Draft
- Author: @<github-handle>
- Created: <YYYY-MM-DD>
- Protocol: v0 → <v0 | v1>
- Related: <issue / PR 链接，可空>

## Motivation

<现在什么做不到 / 什么会出错。给一个具体的、能复现的场景，不要写"更灵活"。>

## Proposal

<改什么。类型、字段、语义，逐条列。>

## Protocol diff

```diff
- // 之前
- { kind: "window.rect"; window: string; rect: Rect; tolerance?: number }
+ // 之后
+ { kind: "window.rect"; window: string; rect: Rect; tolerance?: number; display?: number }
```

## Migration

- 现有 skill：<需要改吗？怎么改？谁改？>
- 既有 journal：<旧条目还能读吗？>
- 迁移脚本：<有 / 无，路径>

## Regression evidence

```bash
node scripts/protocol-freeze-test.ts
node scripts/compat-test.ts
node scripts/snapshot-test.ts
node scripts/regress.ts
```

<贴上真实输出，不要写"应该通过"。>

## Alternatives

1. <方案 B> — 否掉的理由
2. <方案 C> — 否掉的理由

## Rollback

<如果错了怎么退：回滚哪个 PR、数据要不要修、多久内能退干净。>

## History

- <YYYY-MM-DD> @<handle> — 创建，状态 Draft
```

## 评审规则

- 评审窗口至少 **7 天**，从状态改成 `Review` 起算。
- 反对意见必须写清具体后果：哪条不变量被破坏、哪个既有 skill 会坏、哪条测试会红。"我不喜欢"不算理由。
- 能跑一条命令分出对错的争论，就去跑，不辩论。
- Accepted 需要维护者 approve。完整的分歧处理见 [../outreach/GOVERNANCE.md](../outreach/GOVERNANCE.md)。

## 已接受的 RFC

| 编号 | 标题 | 状态 | 实现 |
| --- | --- | --- | --- |
| — | 还没有。第一个 RFC 的位置在这里。 | — | — |
