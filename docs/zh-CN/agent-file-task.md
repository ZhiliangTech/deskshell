# 首个云端智能体文件任务

源码入口也可用 `node bin/deskshell.mjs agent --help`；打包入口为 `deskshell agent`，与下文 `npm run agent -- ...` 共用同一客户端与宿主。本轮变更尚未发布。

更新日期：2026-10-31。仓库内的 `agent` CLI 已接入常驻本地宿主，提供自然语言提案、固定计划、单独批准、执行、独立验证、历史、跨进程停止及有条件撤销。照片任务可选择完整内容去重，把副本移入待确认目录。旧 CLI、Shell 和 MCP 尚未迁移，完整产品和多轮规划仍未完成。

## 当前支持的任务

选择目录后，把第一层具有 `.jpg`、`.jpeg`、`.png`、`.heic`、`.webp`、`.gif`、`.tiff`、`.bmp` 扩展名的普通文件，按 `mtime` 和 `Asia/Shanghai` 时区移动到 `YYYY-MM` 子目录。这里的时间是文件修改时间，不是 EXIF 拍摄时间；扩展名筛选不解码图片。

已有月份目录可以复用，目标存在同名文件时直接拒绝。其他文件、已有子目录及其中的文件保留；不递归整理、不读取 EXIF、不覆盖，也不自动改名解决冲突。模型只能提议宿主所选的受限技能和固定参数，不能提供任意命令、改变目录或定义批准。

显式添加 `--deduplicate` 时，比较根层图像扩展名文件的完整内容。每组字节相同的文件按文件名的 UTF-16、区分大小写顺序保留最前一份，其余保留原文件名移到 `_duplicates` 待确认目录；保留的照片仍按自己的修改月份归档。完整 hash 用于筛选候选，再逐字节确认相等，不使用前缀指纹认定重复。这个步骤不删除副本，也不把已有子目录中的照片纳入重复集合。

本地观察沿用 TaskHost 的限制：最多 2,000 个节点、单文件 16 MiB、总文件内容 64 MiB；超过任一限制直接拒绝。链接、junction、硬链接、跨设备文件树也不支持。当前首先用隔离合成夹具验收，不能据此宣称任意大小照片库都可使用。

## 配置与生成预览

在 Windows 的仓库根目录运行，使用 Node 22.18 以上版本。DeepSeek 密钥沿用已配置的 Windows DPAPI 当前账户存储；状态检查为 `npm run model:configure -- --status`，配置方法见[模型接入说明](model-backends.md)。密钥不需要进入命令参数或项目文件。

先建立独立临时夹具。以下用 `node` 入口读取纯 JSON，避免 npm 的命令提示行干扰 `ConvertFrom-Json`；交互使用也可运行 `npm run agent -- fixture`。

```powershell
$fixture = node apps/agent/cli.ts fixture --deduplicate | ConvertFrom-Json
$fixture

$plan = node apps/agent/cli.ts plan --root $fixture.root --state $fixture.stateDir --intent '请按上海时区的文件修改月份整理根层照片，完整内容相同的副本移到_duplicates待确认，保留其他文件。' --cloud --deduplicate | ConvertFrom-Json
$plan | ConvertTo-Json -Depth 12
```

`fixture` 建立不同月份的合成照片、普通文本、已归档照片和子目录内照片；`--deduplicate` 还加入重复内容。它们是带图片扩展名的固定测试字节，不读取用户真实照片，也不验证图像解码。根目录与状态目录彼此分离，命令输出实际路径并保留文件供检查。无需去重时，省略 fixture 和 plan 上的 `--deduplicate`，并使用只要求按修改月份整理的目标。

带 `--root` 的任务命令会自动启动或连接同一状态目录的隐藏宿主子进程；也可显式运行 `host-start --root ... --state ...`。宿主不注册开机启动。状态目录不得位于任务根内、包含任务根、经过链接，或占用非本应用的已有目录；误配在改动权限前拒绝。Windows 使用当前账户私有 DACL，其他受支持平台使用私有目录权限。

`plan --cloud` 明确允许把**输入的目标文本和固定技能说明/schema**发送给 DeepSeek。程序不自动发送 `--root`、文件名、文件列表、hash、文件正文或截图；如果自己把路径或其他信息写进 `--intent`，这些文本也会被发送。可信目标的完整文件集合与校验摘要在本地生成。

每次 `plan` 最多发出一次请求，限制为 8,192 输入字节、512 输出 token、30 秒、0.01 USD 估算费用，无自动重试。服务还使用跨状态目录共享的持久 UTC 日预算，默认每天 10 次请求、0.10 USD 估算上限；重启或换任务目录不会重置同一用户的该额度。请求先原子预留，取消、超时和结果未知不退款；估算额度不是供应商账单保证。详情见[模型预算](model-backends.md)。

正常输出含 `taskId`、`planId`、`digest`、`root`、整理规则、每步预览、到期时间及模型用量。此时任务为 `awaiting_approval`，照片未移动，未签发执行批准。模型返回的 `goalCriteria` 不决定验收标准。

## 审阅、单独批准和查看结果

先审阅实际目录、修改时间规则、全部步骤和到期时间。需要重新查看持久计划时，单独运行：

```powershell
npm run agent -- inspect --root $fixture.root --state $fixture.stateDir --plan $plan.planId
```

确认预览符合意图后，再单独运行下面的 `apply`。它是对所给 `planId` 和**完整 digest** 的明确批准；不要把生成预览和执行合并为未经审阅的一键脚本。

```powershell
npm run agent -- apply --root $fixture.root --state $fixture.stateDir --plan $plan.planId --digest $plan.digest
```

`apply` 重新检查目录授权、文件快照、技能修订、摘要和有效期，签发仅匹配这一计划的批准并认领执行。默认预览有效期为 10 分钟；目录或技能变化后必须重新 `plan` 和审阅，旧批准不沿用。执行使用已保存动作，不再次询问模型或重新规划。

每个动作后校验实际效果，全部动作后独立核对移动目标、源文件消失、完整内容、修改时间、原有资源身份及其他文件保留。只有目标满足才返回 `succeeded` 和 `goal.satisfied: true`。同一个计划重复 `apply` 返回已有结果，不重复移动。

退出命令后可在新进程中读取持久结果：

```powershell
npm run agent -- status --root $fixture.root --state $fixture.stateDir --task $plan.taskId
npm run agent -- list --root $fixture.root --state $fixture.stateDir
```

状态目录保存 SQLite 任务/计划/批准/执行认领、逐步效果证据、恢复计划、JSONL 动作日志和模型请求摘要。请求摘要不保存密钥、原始目标文本或模型内部推理；计划本身会保存用户目标，状态目录因此也属于私有数据。请求摘要中的意图 hash 用于关联；进程中断留下 `started` 时表示用量或结果仍未知，不能按零费用解释。

## 停止和需要处理的状态

运行中和等待批准的任务都可以在另一终端查询、取消：

```powershell
npm run agent -- cancel --root $fixture.root --state $fixture.stateDir --task $plan.taskId
```

正在请求模型或执行时，在该运行终端按 `Ctrl+C`。模型请求支持取消；文件执行在动作边界处理信号，当前已经开始的步骤会完成核验和记账，然后不再开始下一步。已有结果保留，不自动撤销；有部分效果时通常返回 `partial`。若全部动作已经完成，仍需核验目标并报告实际结果。

同一状态目录只允许一个宿主，其他命令通过本地 IPC 连接它。同一宿主同时执行一个前向或恢复任务，其他任务的执行请求返回 `HOST_BUSY`，预览仍保留。`host-status --state ...` 查询宿主，`host-stop --state ...` 请求停止活动任务并等待收尾，再结束宿主。强制结束进程不是正常停止，重启时未完成执行或恢复会标为 `needs_attention`，不自动重放。

IPC 只监听 `127.0.0.1` 随机端口，使用存于私有状态目录的任务令牌和控制令牌。批准执行、恢复和预算设置要求控制令牌；模型工具不持有它。CLI 不打印令牌或把它们放入模型上下文。这个边界服务于同账户受信组件，不是恶意插件或同账户任意代码的沙箱。

| 状态或错误 | 含义与处理 |
| --- | --- |
| `NO_PHOTOS` | 根层没有支持的图像扩展名文件，不能算任务完成 |
| `PHOTO_DESTINATION_EXISTS` | 同名目标或月份目录位置冲突；先由用户处理冲突，再生成新预览 |
| `NO_PROPOSAL` | 模型未给出适用提案；当前规则不支持任意照片需求 |
| `STALE_PLAN` / `PLAN_EXPIRED` | 观察、技能或有效期不再匹配；重新生成和审阅计划 |
| `cancelled` | 未执行或在产生效果前停止，任务不再等待批准 |
| `partial` | 已有部分效果或目标未完全满足，不能当作全部成功 |
| `needs_attention` | 执行失败或中断，保留现场和记录供核查 |

`undo --root ... --state ... --task ...` 只生成固定恢复预览；审阅后用 `recovery-apply --root ... --state ... --recovery ... --digest ...` 单独批准。恢复支持已核验的新建目录、移动和新建文件，成功后状态为 `undone/restored`。整树不匹配、人工修改或新对象归属未知时拒绝猜测和覆盖；详见[撤销与中断核查](task-recovery.md)。不要用旧入口的撤销命令代替新任务的恢复协议。

宿主运行时，可用 `budget --state ...` 查看额度，`budget-set --state ... --requests 10 --usd 0.10` 显式配置全用户日预算。修改额度不清空当天已用量。停止宿主后，已有 SQLite 记录仍保留，下次任务命令重新启动时继续使用。

## 历史连接与当前验证范围

2026-10-31 15:39（Asia/Shanghai），DeepSeek 真实请求 `a1ad0e54-eac3-47a9-8175-518e22131699` 返回有效照片整理提案：输入 673、输出 189、合计 862 token，保守费用预留为 0.0012414 USD，非实际账单。

提案准备为 2 次目录创建和 3 次文件移动。审阅后通过独立、精确 `apply` 执行，结果 `succeeded` 且 `goal.satisfied: true`；三个根层合成照片归档成功，普通文本、已归档照片及子目录照片保留，跨进程 `status` 读取成功。没有使用用户真实照片。

上面是早期只做按月整理的历史证据，其完整无桌面回归为 59/59、4 项真实桌面检查跳过。后续版本的照片检查已扩展到 26 组、持久预算 23 组、恢复 13 组、服务 IPC 13 组；宿主 19 组及智能体集成 12 组保持单独验证。最新真实 API、去重与撤销演示，以及完整回归结果统一记录在 [STATUS](../../STATUS.md)，不把旧批次数字当作当前全集。应用版本已另实现固定授权多轮，并通过固定原生记事本服务链；后续真实模型加原生三轮及四类故障也已通过；旧入口迁移、自由规划、更广泛扰动与研究收益仍在推进，见[首个应用](first-application.md)。

2026-10-31 15:54 的文件版本另发出一次真实请求 `a32ccbaa-cc9f-4308-ba64-080734d7304c`：输入 760、输出 405、合计 1,165 token，保守费用预留 0.0013473 USD。夹具有 4 个根层照片和 3 个保留文件；模型提案形成 3 次建目录、4 次移动，经单独精确 `apply` 后目标满足。随后单独审阅恢复预览并精确批准，7 个逆向步骤返回 `undone`，原始完整快照摘要完全相同，包括全部 7 个文件的路径、字节、修改时间和身份。真实宿主停止/重启后，任务结果与全用户预算的 1 次请求/0.0013473 USD 记账保持，最后正常停止宿主。没有使用用户真实照片。

代码入口：[CLI](../../apps/agent/cli.ts)、[照片任务协调器](../../packages/agent/src/photo-agent.ts)、[受信技能与验证器](../../packages/runtime/src/photo-task.ts)。运行时边界见[任务宿主说明](task-runtime.md)。
