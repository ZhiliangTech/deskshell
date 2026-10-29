# 协议 v0

协议只有五个类型。所有 skill、驱动、UI 都围绕它们工作。

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
- 用户可以在执行中途撤销授权（v0.2 实现）。

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

每个动作还必须带三个字段：

```ts
{
  id: string;             // 稳定标识，用于日志与定位
  risk?: "low" | "medium" | "high";
  pre?: Assertion[];      // 执行前必须成立
  post?: Assertion[];     // 执行后必须成立（内核强制校验）
  undo?: UndoAction | null; // null = 不可撤销 → 内核拒绝
}
```

`ui.invoke` / `ui.type` 已在驱动层实现，动作类型将在 v0.2 进入协议。

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

`fs.restore` 的 `content` 为 `null` 表示"这个文件是新建的，撤销就是删掉它"。

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
- 缺少 `undo` 的条目不可撤销，撤销时会被跳过而不是报错；
- 重复撤销同一任务是幂等的：第二次找不到 `status: "ok"` 的条目，返回 0 步。

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
3. 任何失败都必须回滚到任务开始前的状态；
4. 内核不依赖模型，模型只能出现在 skill 内部；
5. **动作必须被声明的能力覆盖**：`ui.click` / `ui.type` / `ui.invoke` 需要 `ui.input`，文件类动作需要 `fs.write`。声明了 `ui.read` 却试图点击的 skill，会在执行前被整体拒绝。

第 5 条是 v0.1 补上的：它防的是"skill 悄悄超出自己申请的权限"。能力声明不是装饰，是执行前的硬校验。
