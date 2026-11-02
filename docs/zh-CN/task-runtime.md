# 文件任务宿主、应用任务与本地服务

更新日期：2026-10-31。文件 TaskHost 已支持固定计划、独立批准、SQLite 认领、逐步效果和有条件恢复；常驻 `agent` 服务另接独立记事本任务运行时与固定授权多轮协调器。真实 DeepSeek 加合成编辑器已完成三轮；固定原生计划通过完整服务 IPC/宿主/驱动链，分别验证 CRLF 与 LF。本地合成规划和真实 DeepSeek 加原生三轮、四类真机故障与默认生产服务均通过，精确版本/语言配置已放行。旧 CLI、Shell、MCP 仍为 v0，追问界面和完整 G1–G4 产品验收尚未完成。

## 运行与入口

在仓库根目录运行：

```powershell
node apps/runtime/demo.ts
node apps/runtime/demo.ts --apply
```

第一条只准备并显示计划；第二条在新建的独立临时夹具中批准并执行。每次使用不同临时目录，输出实际路径并保留文件和数据库供检查。演示不接触日常文档、不启动桌面应用，也不调用云端模型。等价 npm 入口为 `npm run runtime:demo -- --apply`。

另有 `npm run runtime:cloud-demo -- --live`，使用已在本机配置的 DeepSeek 凭据进行一次受限付费请求。它只发送固定合成文本与技能 schema，校验模型提案后调用同一个 `prepare`，停在 `awaiting_approval`，不签发批准或执行。验收条件由可信代码固定；配置、请求限额和实测用量见[模型接入说明](model-backends.md)。

新增 `npm run agent -- ...` 提供 `fixture`、`plan --cloud [--deduplicate]`、`inspect`、精确 `apply`、`list/status/cancel`、`undo` 和精确 `recovery-apply`。带根目录的任务命令自动连接或启动隐藏宿主；`host-start/host-status/host-stop` 提供生命周期入口，没有注册开机启动。操作步骤见[文件任务](agent-file-task.md)，恢复语义见[撤销与中断核查](task-recovery.md)。这个新入口不表示旧三入口已迁移。

同一服务提供 `notepad-fixture/probe/plan/inspect/apply/status/cancel` 和 `session-plan/run/status/cancel`。会话准备固定授权范围，精确 `session-run` 才签发批准并开始模型循环；正文与路径留在本地，模型只能选阶段。原生发行版配置已精确放行，不匹配环境或能力缺失时拒绝。服务选择器只匹配记事本 `11.2607.14.0`、`zh-CN`，原生限 UTF-8 无 BOM；通用无 profile 驱动仍禁用保存。probe 是元数据/能力报告，`runtimeVerified` 始终为 false，配置状态另看 `profileVerified/profileSelection`。用法见[首个应用](first-application.md)与[多轮任务](autonomous-tasks.md)。

[createTaskHost](../../packages/runtime/src/host.ts) 接收私有 dataDir、获准目录、能力集合和可信技能/目标验证器注册表，返回两个独立对象：

| 对象 | 接口 | 持有者 |
| --- | --- | --- |
| `tasks` | `prepare`、`inspect`、`execute`、`get`、`list`、`cancel`、`prepareRecovery`、`inspectRecovery`、`recover` | 任务入口，没有批准方法 |
| `approvals` | `approve(planId, digest)`、`approveRecovery(recoveryId, digest)` | 创建宿主的可信调用方，不作为模型工具暴露 |

这是库级能力分离。服务层另以任务令牌和控制令牌区分 IPC 权限，只有控制通道能批准执行、批准恢复和更改日预算。当前只能在主线程创建 TaskHost；同数据目录的第二个存活宿主被拒绝，同一主线程也不能重复创建宿主。客户端通过现有服务连接，避免每条命令各自打开数据库。

## 常驻服务与权限边界

[服务](../../packages/agent/src/service.ts) 监听 `127.0.0.1` 随机端口；[客户端](../../packages/agent/src/host-client.ts) 在需要时启动隐藏子进程，并读取私有状态目录的端点文件。端点文件含两种 bearer token，不应复制到聊天、日志或模型工具参数。状态和帮助输出不包含令牌。

Windows 状态目录使用当前账户私有 DACL，其他受支持平台使用 `0700` 目录权限。目录不得位于任务根内、成为根的祖先、经过链接，或覆盖不属于本应用的已有目录；错误配置在调整 ACL 前拒绝。权限声明与 bearer token 面向同账户的受信组件，不隔离已能读取该账户秘密或执行任意代码的恶意插件。

关闭 CLI 不会结束宿主；另一进程可以继续查询或取消任务。`host-stop` 在宿主空闲时结束它，任务、计划和预算保留；忙碌时先停止当前任务并等待结果。未结束的应用调用仍保留执行权，停止不完整时保持可查询并可重试停止，不能提前释放数据库。当前没有开机启动、桌面面板接管、睡眠唤醒或服务安装器。

## 固定计划和执行

`prepare` 调用一次受信技能，保存规范化动作、技能内容修订、输入、用户目标、验证器版本、权限、完整限额文件快照、到期时间和 SHA-256 摘要。预览从保存的动作生成，调用方得到的是副本。

`execute` 接收计划标识、摘要、宿主批准凭据和请求幂等键，不接收新的技能参数。执行前重新核验当前宿主目录授权、能力、技能/验证器修订、有效期及文件快照。每个计划只能持久认领一次执行，更换请求幂等键不会再次执行同一计划；当前去重以 planId 为准，幂等键暂作为请求关联字段。

宿主串行处理准备、执行和恢复。每步先保存 intent 与前置快照，提交后重新核验完整文件树和即将使用的源身份、目标缺席条件，再启动效果；成功后保存已验证快照。全部动作完成后，再运行可信目标验证器；动作成功但目标不满足时返回 `partial`。

技能和验证器均为受信代码。注册时的 `revision()` 必须覆盖代码及依赖；运行时不会自动替任意 JavaScript 建立可信摘要。规划阶段的前后快照检测不构成对恶意技能的系统访问隔离。

## 独立应用任务与多轮协调

[记事本运行时](../../packages/runtime/src/notepad-task.ts) 不复用文件原语假装 UI 已执行。可信调用者给定源文件、完整目标正文或追加文本，以及不存在的新副本路径；计划绑定源身份/字节/编码/换行、驱动会话与实现摘要。每次 `advance` 只做 `open/edit/save-copy` 中的一步，输入前比较完整观察 token，先记 intent，随后紧邻输入重查前提，验证后记录效果。保存后独立重读磁盘，`observe` 对历史成功也重新核验当前资源；未完成的驱动读取可取消，但其底层调用未结束前仍保留宿主所有权。

输入默认要求前台；受信驱动显式声明 `targeted` 且观察证据一致时，计划允许定向输入，单纯焦点变化不使 token 失效，其余文档和正文绑定保持。原生持续守卫覆盖模型轮次和 helper 之间的间隙，任何人工输入变化都停止，包含其他应用的鼠标或键盘输入；它不是同账户任意外部 UIA/SendMessage 的隔离层。生产宿主每个生命周期仅执行一个文档任务，第二任务在新 API/UI 动作前返回 `NOTEPAD_HOST_RESTART_REQUIRED`；后续须停止/重启宿主并准备新计划，不自动关闭记事本窗口。

[多轮协调器](../../packages/agent/src/autonomy.ts) 固定计划摘要、资源、能力、输出、轮数和时限；一次精确会话批准覆盖该范围，模型每轮只选择下一阶段。真实 DeepSeek 配合合成编辑器已完成三轮，分别 889/912/895 token，合计 2,696，保守估算 0.0038343 USD（非账单），源文保持、副本精确匹配。

真实 DeepSeek 配合原生记事本随后经完整服务链完成三轮，843/890/810 token，合计 2,543，保守估算 0.0038316 USD（非账单）；原生 journal 与逐轮结果均 verified。默认生产服务也已独立复验完整固定任务，第二文档任务在新输入前返回 `NOTEPAD_HOST_RESTART_REQUIRED`。

照片单计划仍为 1 请求/0.01 USD 估算；应用会话默认 6 轮、可设 3–10 轮、5 分钟，后端实例估算上限 0.05 USD；均受同用户 UTC 日默认 10 请求/0.10 USD 约束。会话外发 intent、脱敏阶段观察、上轮反馈及固定 schema，不自动发送正文、路径或哈希；intent 中主动填写的文字会外发。

应用取消、冲突、中断和未知保存效果保留现场，不自动重放，也不提供普通 Undo。真实固定原生计划已完成三阶段 verified/native-window/targeted 观察与独立磁盘核验；原生多轮的人工输入拒绝不计成功。早期截图工具 accessibility 为 null 不代表记事本缺少机器读取能力。追问界面、自由规划、动态扩大权限和应用恢复仍待实现。下面的文件原语、树限额与 RecoveryPlan 专属于文件 TaskHost，不适用于记事本缓冲区。

## 文件原语支持范围

| 原语 | 当前边界 |
| --- | --- |
| `fs.mkdir` | 目标原本不存在，父目录已存在或由前一步明确创建 |
| `fs.move` | 普通文件移到同一任务根内的空目标，不支持目录、链接或跨设备移动 |
| `fs.write` | 新建 UTF-8 文本文件，拒绝覆盖已有文件 |

宿主生成必要前后条件和逆动作资料，同时校验额外断言和撤销字段没有越界。普通撤销使用独立 RecoveryPlan 和批准凭据，从已验证效果反向生成移动、删除已核验新文件、删除空的新建目录；不直接信任技能提供的逆动作。

观察默认最多 2,000 个节点、单文件 16 MiB、总文件内容 64 MiB，超限直接拒绝。符号链接、junction、硬链接、跨设备资源及不完整扫描拒绝。这些限制仅属于新原型入口，原 v0 技能入口保持兼容。

快照和动作之间仍有外部进程并发修改的时间窗口。原型面向受控、非敌对文件场景，尚未通过原生句柄关闭所有检查到使用的竞态。宿主串行也不能阻止其他应用或用户修改文件。

## 持久化与任务结果

[TaskStore](../../packages/storage/src/task-store.ts) 使用 Node 内置 `node:sqlite`，没有新增第三方依赖。schema 2 包含原有计划、批准、认领和任务，以及 effects、恢复计划、恢复批准和恢复认领。批准消费、唯一认领和状态升级在同一事务完成。schema 1 升级保留任务记录，存活旧宿主必须先停止。宿主用 OS 进程启动身份区分存活实例和旧 PID，无法核验时拒绝抢占。

当前在 Windows / Node 22.23.4 验证，该 Node 版本将 SQLite 标为实验特性。新宿主的进程身份实现支持 Windows/Linux，macOS 明确拒绝启动新宿主；原 v0 和 macOS 驱动不受影响，Linux 功能还需对应真机验证。

TaskResult 保留 taskId、planId、状态、逐步结果、真实日志、实际回滚数、目标验证和错误。执行前取消持久记为 `cancelled`；执行中取消阻止下一步，让已开始的步骤完成记账，已有修改保留并返回 `partial`。全部动作已完成后仍核验目标。

宿主在动作边界让出事件循环并检查停止信号，使前台 `agent apply` 可用 `Ctrl+C` 停止后续动作。运行中的 `status/cancel` 经同一常驻服务处理；客户端不尝试抢占正在使用的数据库。恢复也可取消，已执行的逆向效果保留，剩余工作进入 `needs_attention`。

新宿主对失败采用保留现场策略，不调用旧内核的自动补偿；错误和残留进入 `needs_attention`。旧 `run()` 默认行为保持不变，新 `runActions()` 通过显式 `rollbackOnFailure: false` 启用此策略。

重启时，尚为 `running/cancelling/recovering` 的任务转为 `needs_attention`，保留执行认领，禁止自动重放。恢复前重新观察，区分未发生、已核验和未知效果。已出现但未持久保存验证身份的新文件或目录不猜归属；手工改动导致整树不匹配时拒绝覆盖。SQLite 不能将数据库与文件效果变成同一原子事务，也不证明任意副作用恰好执行一次。

恢复成功后状态为 `undone/restored`，原始前向结果保留作历史，`recovery` 字段记录恢复状态与已完成步骤。当前验证覆盖进程中断，未验证断电耐久性；细粒度锁、选择性合并恢复和恢复数据配额仍待推进。

## 验证

以下保留文件宿主各批次的历史验证结果，脚本使用独立临时夹具并在清理前核验范围；最新完整回归见 [STATUS](../../STATUS.md)：

| 命令 | 历史文件批次结果 |
| --- | --- |
| `node scripts/fixed-actions-test.ts` | 18/18 |
| `node scripts/file-plan-test.ts` | 14/14 |
| `node scripts/task-store-test.ts` | 12/12 |
| `node scripts/task-runtime-test.ts` | 19/19，包含动作边界信号处理 |
| `node scripts/photo-task-test.ts` | 26 组，包含按月、完整内容去重和独立目标验证 |
| `node scripts/photo-agent-test.ts` | 12 组，照片智能体提案与批准执行集成 |
| `node scripts/task-recovery-test.ts` | 13 组，真实子进程故障注入、恢复中断和冲突保护 |
| `node scripts/agent-service-test.ts` | 13 组，本地 IPC 与权限边界、跨宿主预算 |
| `node scripts/agent-cli-test.ts` | 9 组，真实隐藏宿主的 CLI 生命周期、并发启动与任务命令 |
| `node scripts/model-budget-test.ts` | 23 组，持久日预算和并发预留 |
| `node scripts/regress.ts --headless` | G1 首批独立临时副本 56/56，4 项真实桌面检查跳过；后续完整回归见 [STATUS](../../STATUS.md) |

应用与多轮版本的专项验证另计。下表保留已记录批次，后续扩展计数以 STATUS 的最终回归为准：

| 命令 | 已记录专项结果 |
| --- | --- |
| `node scripts/test-notepad-task.ts` | 已验证 38 组，含阶段执行、身份/字节/编码、定向输入与焦点、人工编辑、取消、迟到调用和重启保护 |
| `node scripts/notepad-native-test.ts` | 离线原生协议专项；新配置与守卫改动后的最新计数见 STATUS，该脚本本身不执行真实 UIA |
| `node scripts/test-autonomy.ts` | 16 组，固定会话范围、逐轮规划、预算、取消和中断 |
| `node scripts/test-notepad-agent.ts` | 11 组，应用适配器、多轮集成与外发边界 |
| `node scripts/test-application-service.ts` | 9 组，应用/会话 IPC 与停止生命周期 |

真实固定原生验收使用 [native live smoke](../../scripts/notepad-native-live-smoke.ts)，经服务 IPC 和精确批准执行；CRLF/LF 两次通过，中文路径和正文、空行、UTF-8 无 BOM、源文保持、精确副本与仅新增预期文件均验证。同一脚本的本地合成规划、真实 DeepSeek 三轮和默认生产服务模式均已通过。[四类故障脚本](../../scripts/notepad-native-fault-smoke.ts) 真机 4/4 通过，经过应用 runtime/driver，不冒称完整服务故障测试。显式命令及证据见[开发者冒烟](first-application.md#开发者真机冒烟)，常规无桌面回归不运行它们。

17 组 DeepSeek 离线检查、历史照片请求、真实模型加合成编辑器三轮、截图冒烟、原生原语和固定原生完整链分别记录。各专项计数不等同完整回归；总结果以 [STATUS](../../STATUS.md) 为准。更完整的原生扰动矩阵、追问界面、自由规划、选择性恢复和旧三入口一致性尚未完成。

## 下一批工程工作

1. 迁移 CLI、Shell、MCP，统一预览、taskId、授权与失败结果。
2. 在已落地的服务和批准分离基础上完善安装更新、桌面视图、休眠恢复和外部用户验收。
3. 扩展恢复材料留存、配额、原生并发控制与有可信语义的选择性恢复，继续保持未知状态拒绝。
4. 在已实现的固定授权多轮基础上补追问界面、自由任务规划和留出任务评估；在已放行的精确原生配置上扩展真实扰动与版本、语言和编码支持矩阵。

相关入口：[PROJECT](../../PROJECT.md)、[RFC 0001](../../rfcs/0001-local-agent-system.md)、[RFC 0002](../../rfcs/0002-semantic-resources-and-effect-receipts.md)、[STATUS](../../STATUS.md)。
