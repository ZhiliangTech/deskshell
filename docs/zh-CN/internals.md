<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# 内部实现

各部分到底怎么咬合，哪条规则在哪一层执行。写给要扩展它的人，不只是要跑它的人。

## 完整流程

```
skill.plan(input, ctx) → Action[]          纯描述，无副作用
        ↓
checkCapabilities(caps, granted, root)     声明的能力必须全部被授予
        ↓
checkAction(action, root, ids, caps)       逐动作：路径逃逸、窗口作用域、可撤销性
        ↓
preview  ─ 打印后停止
apply    ─ 每个动作：前置断言 → 执行 → 后置断言 → 写日志
undo     ─ 读日志 → 逆序回放撤销 → 标记 rolled-back
```

以上全是同步的文件系统操作加驱动调用。没有调度器、没有重试循环、没有模型。

## 策略层到底查什么

| 检查 | 位置 | 挡住什么 |
| --- | --- | --- |
| 能力是否被授予 | `checkCapabilities` | 拿用户没给过的权限干活 |
| `fs.*` 作用域在 root 内 | `checkCapabilities` | 声明 `C:\` 当作用域 |
| 动作被声明的能力覆盖 | `checkAction` | 声明 `ui.read` 却去点鼠标 |
| 路径词法在 root 内 | `checkAction` → `isInside` | `..` 穿越、绝对路径 |
| 路径真实位置在 root 内 | `checkAction` → `isInsideReal` | root 内指向外部的 junction / 软链接 |
| 窗口落在声明作用域内 | `checkAction` | 声明"记事本"却操作"计算器" |
| 动作可撤销 | `checkAction` | `fs.delete` 配 `undo: null` |

真实路径检查会沿最近的存在祖先解析，所以目标还不存在也能查；对 `fs.move` 的**源**只查父目录——搬走一个快捷方式本身是合法操作。

## 失败语义

动作失败时，内核依次做四件事：

1. 把失败写进日志（`status: "failed"` + `detail`）；
2. 撤掉失败动作自身的副作用——但**只有真的进入过执行阶段**、且效果确实存在时才撤（`selfUndoSafe`），避免"前置断言失败却把别人的文件搬走"这类事故；
3. 逆序回滚所有已完成的步骤；
4. 只把**确实撤销成功**的步骤标成 `rolled-back`。

如果撤销本身失败（比如文件被改过），那一步在日志里保持未撤销状态。日志不会谎报回滚。

## 日志是唯一事实来源

`<root>/.deskshell/journal.jsonl`，一行一个 JSON 对象：

```json
{"ts":1793281142815,"taskId":"task-1793281142815","skill":"photo-sort","actionId":"move:IMG_0001.jpg",
 "kind":"fs.move","summary":"move IMG_0001.jpg → …/2026-03/IMG_0001.jpg","status":"ok",
 "undo":{"kind":"fs.move","from":"…/2026-03/IMG_0001.jpg","to":"…/IMG_0001.jpg"}}
```

- `taskId` 把一次 `run()` 归组；
- `skill` 让 `deskshell history` 可读；
- `hash` 出现在 `fs.write` 步骤上：写入内容的 sha256。撤销时若文件当前哈希不同就拒绝覆盖——人工改过的内容不会被悄悄冲掉；
- `status` 只有 `ok` / `failed` / `rolled-back`。

`deskshell history` 汇总任务，`deskshell show <taskId>` 打印单次任务时间线。

## 并行执行

`deskshell run a b c --parallel` 在同一个进程里并发跑多个 skill：各自保留自己的计划和上下文，共用一份日志。日志写入是同步的，所以追加不会交错丢行；`markRolledBack` 的读-改-写也在同一个 tick 内完成。

一个 skill 失败会让 CLI 以非零退出，但**不会**中断其它 skill——有测试专门把"必然失败"的 skill 和 `photo-sort` 放在一起跑。

## skill 放在哪

1. `packages/skills/` —— 内置，随包发布；
2. `~/.deskshell/skills/`（或 `$DESKSHELL_SKILLS_DIR`）—— 通过 `deskshell add` 安装。

同名时用户目录优先；因为它在包外，升级 deskhell 不会把它冲掉。

## 扩展点

- **新 skill** —— 一个目录，`skill.json` + `index.ts`，只写 `plan()`。
- **新驱动** —— 实现 `UiDriver`、通过 13 项契约测试；内核不动。
- **模型** —— 坐在 `plan()` 之上，产出的动作照样过同一套策略检查；内核里没有任何模型引用。

## 故意没做的东西

没有调度器、队列、常驻服务、数据库、插件沙箱。在基础还没被证明之前，每一个都是新的故障面。日志 + 撤销栈已经足够跑一次、解释一次、还原一次——这就是全部承诺。
