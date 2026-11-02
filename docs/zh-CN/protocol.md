# 协议 v0

协议只有五个类型。所有 skill、驱动、UI 都围绕它们工作。

### `irreversible`

有些动作撤不回来——按钮按下去就是按下去了。与其假装能撤，不如让它自己说出来：

```ts
{ id: "submit", kind: "ui.invoke", window: "Form", selector: { name: "OK" }, irreversible: true }
```

内核会：

1. 在 `preview.summary.irreversible` 里计数；
2. **整单拒绝执行**（一个字节都不动），除非调用方显式确认：CLI 用 `--allow-irreversible`，MCP 传 `allowIrreversible: true`。

省略 `undo` 或设置为 `null` 时，也需要同样的确认。显式 `irreversible: true` 优先于附带的 `undo`：这一步不会被记为可撤销。`fs.delete` 的策略更严格，缺失或为 null 的 `undo` 始终被拒绝，确认不能绕过这条规则。

这是硬闸不是警告：审计链的意义就在于——**唯一撤不回来的那一步，必须是被提前批准过的**。

## 1. Capability —— 能力申请

```ts
interface CapabilityRequest {
  id: "fs.read" | "fs.write" | "fs.delete" | "ui.read" | "ui.input" | "process.exec" | "net.http";
  scope?: string;   // 文件能力是路径根，UI 能力是应用标识
  reason: string;   // 必须是人话，会原样展示给用户
}
```

规则：

- 声明的能力必须被用户授予，否则内核直接拒绝整个任务；
- `fs.*` 的 `scope` 必须落在本次任务的 root 内，否则拒绝；
- 动作必须被声明的能力覆盖；空能力列表也不会跳过检查。

## 2. Action —— 一步操作

当前实现的动作：

```ts
type Action =
  | { kind: "fs.mkdir"; path: string }
  | { kind: "fs.move"; from: string; to: string }
  | { kind: "fs.delete"; path: string }
  | { kind: "fs.write"; path: string; content: string }
  | { kind: "ui.invoke"; window: string; selector: UiSelector }
  | { kind: "ui.click"; window: string; selector: UiSelector }
  | { kind: "ui.type"; window: string; selector: UiSelector; text: string }
  | { kind: "window.move"; window: string; rect: Rect };
```

动作的公共字段如下：

```ts
{
  id: string;             // 稳定标识，用于日志与定位
  risk?: "low" | "medium" | "high";
  pre?: Assertion[];      // 执行前必须成立
  post?: Assertion[];     // 已提供的断言在执行后必须成立
  undo?: UndoAction | null; // 缺失/null = 不可撤销 → 需要确认
  irreversible?: boolean; // 显式不可撤销，即使同时提供 undo
}
```

协议 v0 为兼容现有技能，保留 `post` 和 `undo` 可选。编写技能时建议每步提供有意义的 `post`；内核会校验已提供的断言，但不强制列表非空。缺失 `undo` 时适用上面的确认策略。

## 3. Assertion —— 断言

```ts
type Assertion =
  | { kind: "path.exists"; path: string }
  | { kind: "path.absent"; path: string }
  | { kind: "file.count"; dir: string; equals: number }
  | { kind: "ui.value"; window: string; selector: UiSelector; equals: string }
  | { kind: "window.rect"; window: string; rect: Rect; tolerance?: number }
  | { kind: "window.exists"; window: string; timeoutMs?: number }
  | { kind: "ui.exists"; window: string; selector: UiSelector };
```

断言是"我以为成功了"的解药。没有 post 断言的动作，等于把结果交给运气。

`ui.value` 会让内核去读控件树、比对输入框当前值——它比"截图看起来对"可靠，因为它是结构化的。

断言检查是异步的：文件类断言同步判定，UI 类断言需要调用驱动读控件树，因此内核按顺序 `await`，失败即停。

## 4. UndoAction —— 撤销

```ts
type UndoAction =
  | { kind: "fs.move"; from: string; to: string }
  | { kind: "fs.rmdir"; path: string }
  | { kind: "fs.restore"; path: string; content: string | null }
  | { kind: "noop" };
```

`fs.restore` 的 `content` 为 `null` 表示"这个文件是新建的，撤销就是删掉它"。撤销也会清理该次写入自动创建的空父目录，保留原本存在或包含其它文件的目录。

## 5. Journal —— 审计

```ts
interface JournalEntry {
  ts: number;
  taskId: string;
  actionId: string;
  kind: string;
  summary: string;     // 人话，用于展示
  status: "ok" | "rolled-back" | "failed";
  detail?: string;     // 失败原因，仅在 failed 时出现
  undo?: UndoAction;
}
```

落盘为 JSONL，一行一条。撤销时按 `taskId` 逆序重放。

格式约定：

- 文件位置固定为 `<root>/.deskshell/journal.jsonl`；
- 只追加，不原地修改；唯一例外是撤销后把对应行重写为 `rolled-back`；
- `taskId` 在一次 `run()` 内唯一，跨任务可比较先后（取最小 `ts`）；
- 失败的步骤也会落盘（`status: "failed"` + `detail`），因为"出过什么事"不能只留在终端输出里；
- 缺少 `undo` 的条目会返回撤销失败，保留未撤销状态，不计入 `rolledBack`；
- 任务的所有步骤成功撤销后，再次撤销返回 0 步；撤销失败或不可撤销的条目在后续尝试中仍然可见。

## 6. Manifest —— skill 清单

```json
{
  "name": "downloads-cleanup",
  "version": "0.1.0",
  "description": "按类型整理下载文件夹",
  "entry": "./index.ts",
  "internal": false,
  "platforms": ["win32", "darwin"],
  "capabilities": [{ "id": "fs.write", "scope": "{{root}}", "reason": "移动文件" }]
}
```

- `name` 必须匹配 `^[a-z0-9][a-z0-9-]*$`；
- `internal: true` 用于测试 skill，不出现在 `deskshell list` 里；
- `platforms` 缺省表示全平台；声明后，其余平台上该 skill 会被标记为不可用；
- 完整 JSON Schema 见 `schema/skill.schema.json`，`deskshell add` 会在安装前按同一套规则校验。

## 内核流程

```
校验能力 → 生成计划 → 检查每个动作（路径/撤销性）
        → preview：只打印，不执行
        → apply：逐条 执行 → 后置断言 → 写日志
                 失败则逆序回滚已成功的步骤
        → undo：读日志 → 逆序执行 undo → 标记 rolled-back
```

## 不变式

1. 任何动作都不得越过 root；
2. 任何动作都必须可撤销，除非用户显式确认；
3. 失败时尽力恢复任务起始状态，个别撤销失败后继续处理其它步骤，并报告恢复不完整；仅成功撤销的步骤标为 `rolled-back`，已确认执行的不可逆动作无法恢复；
4. 内核不依赖模型，模型只能出现在 skill 内部；
5. **动作必须被声明的能力覆盖**：`ui.click` / `ui.type` / `ui.invoke` 需要 `ui.input`，文件类动作需要 `fs.write`。声明了 `ui.read` 却试图点击的 skill，会在执行前被整体拒绝。

第 5 条是 v0.1 补上的：它防的是"skill 悄悄超出自己申请的权限"。能力声明不是装饰，是执行前的硬校验。
