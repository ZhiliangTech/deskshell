# 文件任务撤销与中断核查

更新日期：2026-10-31。新的文件任务宿主已支持普通撤销和中断后的核查恢复。两者都先生成固定恢复预览，再由可信调用方批准精确摘要；不会在重启时自动重放，也不把日志中存在 `undo` 当作恢复依据。

当前仅支持已保存文件计划中的新建目录、普通文件移动和新建文本文件。恢复以整个任务目录为冲突边界：任何额外文件、人工修改、对象替换或目标占位都可能阻止恢复。这里尚未实现 RFC 0002 的选择性合并恢复。

## 从预览到恢复

在完成或停止任务后，使用同一个根目录和状态目录。`undo` 只准备恢复计划，不修改文件：

```powershell
$recovery = node apps/agent/cli.ts undo --root $fixture.root --state $fixture.stateDir --task $plan.taskId | ConvertFrom-Json
$recovery | ConvertTo-Json -Depth 12
```

审阅 `mode`、根目录、每个逆向步骤、摘要和有效期。正常成功任务的 `mode` 为 `undo`；部分执行或中断任务的 `mode` 为 `restore`。确认后再执行：

```powershell
node apps/agent/cli.ts recovery-apply --root $fixture.root --state $fixture.stateDir --recovery $recovery.recoveryId --digest $recovery.digest
node apps/agent/cli.ts status --root $fixture.root --state $fixture.stateDir --task $plan.taskId
```

`recovery-inspect --root ... --state ... --recovery ...` 可重新查看已保存的恢复预览。恢复不调用模型。只有控制通道可以批准恢复；模型提案和任务通道不能签发恢复批准。

恢复成功时，原任务状态为 `undone` 或 `restored`，`recovery.status` 为 `completed`。前向任务的 `goal`、`steps` 和 `journal` 保留作历史证据，不能把其中先前的 `goal.satisfied: true` 解读为当前文件仍保持前向结果。

## 效果证据与中断判定

每个前向或恢复步骤先持久保存 `intent`、固定动作和完整前置快照，提交后再次检查目录及紧邻使用的对象，再开始效果。验证后的完整快照保存为 `verified`。SQLite 保证记录提交的一致性，不把文件系统效果与数据库提交变成同一事务。

| 中断后观察 | 当前处理 |
| --- | --- |
| 当前完整树等于该步前置快照 | 判定该步未发生，保存 `not_applied`，不重放前向效果 |
| 未完成记录是移动，原对象身份、目标和完整树符合预测 | 可补记已核验效果，再生成逆向预览 |
| 新文件或新目录已出现，但尚无持久的已验证身份 | 标为 `RECOVERY_EFFECT_UNKNOWN`，保留现场，不凭路径或相同内容猜归属 |
| 当前树既不符合前置也不符合可核验的后置状态 | 拒绝自动恢复，保持 `needs_attention` |

成功执行后普通撤销使用持久的验证终态。移动会移回同一个普通文件；已核验的新建文件才允许删除；新建目录只在其所有相关内容已恢复且目录为空时删除。恢复最终必须重新核对原始完整快照，包括路径、字节、文件修改时间和保留对象身份。

每份恢复计划也只有一次持久执行认领。重复提交同一 `recoveryId` 返回现有结果，不重复删除或移动。恢复本身被中断时，重启仍先进入 `needs_attention`；重新运行 `undo` 核查已完成的逆向步骤，生成剩余步骤的新预览，再单独批准。旧恢复批准不能授权新预览。

## 停止、冲突和存储迁移

运行期间可以从另一终端调用 `cancel --root ... --state ... --task ...`，或在前台恢复命令按 `Ctrl+C`。停止在动作边界生效；已经产生的逆向效果保留，未完成的恢复返回 `needs_attention`，错误码为 `RECOVERY_CANCELLED`。继续前仍需新的核查和批准。

`RECOVERY_CONFLICT` 表示当前树不再等于已验证的效果链。`STALE_PLAN` 或 `STALE_RECOVERY` 表示预览后状态或证据改变。遇到这些状态先检查原文件和任务记录；系统不会覆盖人工工作以追求“恢复成功”。已经 `undone/restored` 的任务再次准备恢复会返回 `TASK_ALREADY_RESTORED`。

TaskStore 当前 schema 为 2，增加效果检查点、恢复计划、恢复批准和恢复认领。schema 1 可在旧宿主停止后升级，保留原任务记录。旧任务没有新检查点时，不凭旧 JSONL 日志推断动作归属；无法核验的历史效果不会自动恢复。降级旧程序不等于撤销文件操作。

## 已验证范围

`node scripts/task-recovery-test.ts` 的 13 组隔离检查通过，包括成功任务撤销、部分执行恢复、人工修改拒绝、重复请求、权限收紧、迁移和损坏证据拒绝。测试使用真实子进程，在前向移动前后、恢复移动前后及最后目录删除后强制退出；另覆盖新对象身份未落盘的未知状态、恢复中取消，以及 SQLite intent 提交期间插入手工文件的冲突保护。

2026-10-31 15:54 的真实 DeepSeek 合成照片任务另完成 7 步前向执行及单独批准的 7 步恢复，状态为 `undone`。恢复后的完整原始快照摘要相同，包含 7 个文件的路径、字节、修改时间和身份；宿主正常停止/重启后结果仍保持。详见[文件任务证据](agent-file-task.md)和 [STATUS](../../STATUS.md)。

这证明的是受控夹具中的进程中断处理；未验证断电耐久性。当前使用路径和整树检查，没有原生对象句柄锁或完整的对抗式并发隔离。目录大小仍受 2,000 节点、单文件 16 MiB、总内容 64 MiB 限制，逐步快照的留存、压缩和磁盘配额仍需完善。

代码：[恢复协调器](../../packages/runtime/src/recovery.ts)、[任务宿主](../../packages/runtime/src/host.ts)、[TaskStore](../../packages/storage/src/task-store.ts)、[故障测试](../../scripts/task-recovery-test.ts)。相关说明：[任务运行时](task-runtime.md)、[文件任务操作](agent-file-task.md)、[RFC 0002](../../rfcs/0002-semantic-resources-and-effect-receipts.md)。
