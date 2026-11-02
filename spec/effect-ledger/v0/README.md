# Effect Ledger Protocol v0（执行账本协议）

- Status: **Draft 0 / 可用于实现**
- 目标级别：**L3 原语的候选**——任何 agent 动用户的文件，都应经过一层"可核对、可撤回、可追责"的执行层，而不是让每个 agent 自己决定怎么记账。
- 本规范只定义**数据形状、操作语义、错误码与一致性向量**；不定义实现语言、存储引擎、UI。
- 参考实现见仓库内核（`packages/core`），独立最小实现见 `impl-mini.ts`（不依赖内核，只依赖本文件）。

## 1. 范围

本协议规定四件事：

1. **Effect**：一次改动的可核对描述（改了哪个对象、改前改后是什么、凭什么认定）。
2. **Append-only Ledger**：效果的追加式记录（JSONL，一行一条）。
3. **Revert**：按记录撤回一次效果；撤回失败必须如实拒绝，不得谎报。
4. **Conformance**：一套语言无关的向量，任何实现都能跑；两个实现通过同一套向量，才叫互操作。

不规定：授权与审批、模型接入、UI、任务编排。它们可以建在本协议之上，但不属于 v0。

## 2. 数据模型

```jsonc
// 一条账本记录（JSONL 一行）
{
  "v": 0,
  "id": "step-1",              // 任务内唯一
  "taskId": "t-1",
  "seq": 1,                    // 单调递增，从 1 开始
  "kind": "fs.write",
  "object": "a.txt",           // 相对路径
  "beforeHash": null,          // 改前内容摘要；不存在为 null
  "afterHash": "sha256:…",     // 改后内容摘要
  "undo": { "kind": "restore", "content": null },  // null 表示"撤销=删除"
  "status": "ok",              // ok | rolled-back
  "at": 1767225600000
}
```

`undo.kind` 取值：`restore`（写回给定内容）、`delete`（删除该对象）、`move`（移动回原位）、`none`（不可撤销，见 §4）。

机器可校验的形状见 `schema.json`（JSON Schema 2020-12），实现方可以直接拿它做校验。

## 3. 操作

| 操作 | 语义 | 成功 | 失败 |
| --- | --- | --- | --- |
| `apply(action)` | 执行一次改动，追加账本记录 | `{status:"ok", id, seq}` | `{status:"refused", reason}` |
| `revert(target)` | 按记录撤回；`target` 为 `last` 或 step id | `{status:"restored", id}` | `{status:"refused", reason}` |
| `read(path)` | 读对象当前状态 | `{exists:true, content}` | `{exists:false}` |
| `ledger()` | 返回记录（按 seq 升序） | `{entries:[…]}` | — |

`apply` 支持的 action 最小集：`write{path, content}`、`delete{path, undo}`、`move{from, to}`。实现可以支持更多，但必须支持这三个。

## 4. 不变量（MUST）

1. **可撤回才允许执行**：没有真实 undo 的 `delete` 必须被拒绝，`reason=DELETE_WITHOUT_UNDO`。
2. **占位不算撤销**：`undo:{kind:"none"}`（含 `noop` 语义）对 `delete`/`move`/`write` 一律视为"撤不掉"，`reason=DELETE_WITH_PLACEHOLDER_UNDO`。UI 动作可以另议，不在 v0 范围。
3. **撤回不覆盖别人的改动**：撤回时若对象当前内容与 `afterHash` 不一致，必须拒绝，`reason=CONFLICT`，且不得写入。
4. **撤回先于记账**：先执行恢复，再改记录状态；恢复失败时记录保持 `ok`。
5. **账本可损坏而不致命**：读取时遇到无法解析的行 MUST 跳过，不得使整份账本不可读；被跳过的行 MUST 原样保留（不得在重写时抹掉）。
6. **撤回幂等**：已 `rolled-back` 的记录再次撤回必须拒绝，`reason=ALREADY_REVERTED`。

## 5. 错误码表（固定 token，不得翻译）

| reason | 触发 |
| --- | --- |
| `DELETE_WITHOUT_UNDO` | delete 无 undo |
| `DELETE_WITH_PLACEHOLDER_UNDO` | delete 的 undo 是 `none` |
| `CONFLICT` | 对象在 apply 之后被改动 |
| `NOTHING_TO_REVERT` | 没有可撤回的记录 |
| `ALREADY_REVERTED` | 目标已撤回 |
| `UNSUPPORTED` | 未实现的 action / undo |

错误码是协议的一部分：不同实现必须返回**同样的字符串**，否则不叫互操作。

## 6. 一致性向量

`vectors.json` 里每个用例都是对上述四个操作的一段指令序列，附期望结果。运行方式：

```bash
node scripts/conformance-test.ts            # 参考实现（内核适配）
node scripts/conformance-test.ts --impl mini # 独立最小实现
node scripts/conformance-test.ts --compare   # 两者必须完全一致
```

判定标准：**逐条 status 与 reason 相等**。任何一条不一致即失败——这正是"两个实现通过同一套向量"的含义。

## 7. 兼容与版本

- 所有对象带 `v:0`；新增字段不得改变既有语义。
- 破坏性变更必须升 `v`，并保留旧实现的读取路径。
- 错误码只增不改；收到未知 reason 的实现必须原样透传，不得替换。

## 8. 为什么这是一个"层"而不是一个库

如果每个 agent 自己做记账，结果就是每个 agent 都有自己的"不可撤销"定义，用户面对 N 套语义。协议的价值在于：**同一份账本可以被不同的 agent 写、被不同的工具读、被同一个审批界面核对。** 这是 L3 起步的必要条件，也是把"可核对"从某个产品的功能变成基础设施的唯一路径。
