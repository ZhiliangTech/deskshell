# 固定授权范围内的多轮任务

更新日期：2026-10-31。仓库已实现持久多轮协调器、记事本阶段适配器、常驻服务和 CLI；离线检查及真实 DeepSeek 加合成编辑器均已完成三轮“观察 → 模型选择下一步 → 校验 → 执行 → 再观察”。固定计划另已通过真实记事本服务 IPC、应用宿主与原生驱动链路，CRLF/LF 两次成功。后续本地合成规划加原生、真实 DeepSeek 加原生均完成三轮；四类真机故障、默认生产服务及第二任务拒绝通过，精确版本/语言配置已放行，见[首个应用](first-application.md)。

早期真实模型加合成编辑器三轮使用 889/912/895 token，合计 2,696，保守估算 0.0038343 USD。后续真实模型加原生记事本三轮使用 843/890/810 token，合计 2,543，3 次请求、保守估算 0.0038316 USD；完整服务 IPC 链 succeeded，三个原生阶段 verified，源文保持、精确副本且仅新增预期文件。费用均非账单，两批证据独立保留。追问界面、自由规划及任意应用操作仍未实现。

## 授权与执行

会话绑定已经准备好的本地记事本计划。固定授权范围（envelope）包含计划 ID 与摘要、可信目标条件、源文件与新副本资源、允许的能力和输出、轮数及总时限。正文和路径来自本地计划，模型不能修改。

用户审阅后以精确 `sessionId + digest` 批准会话，宿主在该范围内连续推进，不要求每轮重新确认。同一应用任务沿用原批准与执行认领；模型没有批准 API，不能用“用户已同意”或“任务完成”改变宿主状态。

| 当前阶段 | 唯一有效提案 | 本地执行与核验 |
| --- | --- | --- |
| `planned` | `open` | 打开明确源路径，核验窗口、文档及完整源正文 |
| `open` | `edit` | 输入前比较观察 token，写入已批准正文，重读缓冲区 |
| `edit` | `save-copy` | 另存到固定新路径，核验真实缓冲区与磁盘字节，保留源文件 |

每轮开始和执行后都有可信观察与目标检查；目标已经满足时不再请求模型。无效步骤会被拒绝并记录，其轮次仍计入预算。人工编辑、对象替换或不明效果停止后续规划，不再请求模型猜测恢复动作。

这版证明固定工作流可以根据逐轮结果推进。自由任务分解、自动新增资源、动态修改正文、跨应用规划和扩大授权后的再确认仍待实现。

## 原生执行与跨轮关联

运行时已将驱动输入方式绑定到计划：默认 `foreground`，受信驱动可明确声明 `targeted` 并返回一致证据。targeted 操作不因单纯焦点变化使观察失效，保留真实焦点记录，仍严格核验目标窗口、选中标签/文档、内容、dirty 和标题。任何全局键盘备用路径都须由驱动在该动作前核验前台焦点，模型不能通过提案改变输入方式。

现代记事本同 PID 多窗口、raw CR 文本及文件对话框采用版本化适配，不能把通用 UIA 方法成功返回当作保存成功。固定计划通过完整宿主链后，三个阶段都有原生机器观察及 verified 记录，磁盘独立验证中文路径、空行、UTF-8 无 BOM 的 CRLF/LF 精确副本和源文不变。这个固定计划批次不包含规划请求；后续本地合成规划和真实 DeepSeek 均在同一原生链完成三轮。缓冲修改、未授权对话框、驱动关闭和守卫进程退出四类故障另行通过；早期人工输入拒绝不计为成功。

模型思考期间仍须保持文件到活动文档的关联。持续守卫从首次打开前启动，短许可绑定本次受信动作，并额外监视所属窗口事件、失联和序号连续性。当前原生实现对任何人工输入变化都停止，包括用户操作其他应用或在合法许可期间输入；因此尚不提供执行期间并行操作电脑的体验。它属于合作式冲突检测，不是同账户外部 UIA/SendMessage 的隔离保证。异常使关联失效，下一轮先停止本地执行而非继续请求云端。详细输入、映射与路径合同见[原生适配设计](first-application.md#原生适配的确定设计)。

## 外发内容与预算

`session-plan --cloud` 明确允许后续云端推理，准备会话本身不调用模型。执行时发送用户填写的 intent、脱敏阶段观察、上轮阶段反馈和固定技能说明/schema；不自动发送文档正文、文件路径/名称、哈希、窗口标题、原生标识或恢复材料。用户若主动把路径或正文写入 intent，这部分文字仍会外发。

密钥沿用 Windows DPAPI 配置。生产后端每次请求输入至多 16,384 字节、输出至多 512 token、超时 30 秒；会话后端实例请求数受剩余轮数约束，估算费用上限为 0.05 USD。费用是预留与估算，不是供应商账单。

记事本会话默认最多 6 轮，可设 3–10 轮，批准后执行时限为 300 秒；计划和待批准会话默认 10 分钟有效。共用全用户持久 UTC 日预算，默认 10 请求/0.10 USD，重启或更换状态目录不会重置。无效提案已经消耗请求，取消或超时后未知用量不自动退还预留。详见[模型后端](model-backends.md)。

## CLI 流程

先按[首个应用](first-application.md#cli-使用方式)创建 `$fixture`，配置放行并匹配本机版本/语言后准备 `$plan`，审阅正文和另存路径。精确 `11.2607.14.0/zh-CN` 配置已放行，原生限 UTF-8 无 BOM；执行期间保持无人工鼠标或键盘输入。`notepad-probe` 的 `runtimeVerified=false` 始终表示探测不替代实际执行验收。

准备固定会话并查看完整范围：

```powershell
$session = node apps/agent/cli.ts session-plan --root $fixture.root --state $fixture.stateDir --plan $plan.planId --intent "按已批准正文编辑，并保存为指定新副本" --cloud --rounds 6 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "会话预览未准备成功。" }
npm run agent -- session-status --root $fixture.root --state $fixture.stateDir --session $session.sessionId
```

单独审阅 envelope、原计划摘要、能力、资源、输出、轮数和时限后，运行精确会话：

```powershell
npm run agent -- session-run --root $fixture.root --state $fixture.stateDir --session $session.sessionId --digest $session.digest
```

控制通道在此签发批准。正常有效提案对应三次模型请求和三次单阶段执行；某轮失败或拒绝不能算作完成。只有独立目标验证通过才返回 `succeeded`。

另一个终端可查询或取消：

```powershell
npm run agent -- session-status --root $fixture.root --state $fixture.stateDir --session $session.sessionId
npm run agent -- session-cancel --root $fixture.root --state $fixture.stateDir --session $session.sessionId
npm run agent -- notepad-status --root $fixture.root --state $fixture.stateDir --task $plan.taskId
```

执行终端的 Ctrl+C 会发送取消请求。会话记录模型轮次和授权，应用任务记录 UI 效果与文档验证。上述 status 查询持久历史；协调器运行中的 `tasks.observe` 才执行新鲜目标检查。

## 持久化与停止

协调器存储会话、批准、每轮请求状态、受限提案、效果 intent、执行结果、后续观察和目标验证，不保存模型内部推理。应用任务另存固定计划、批准、唯一认领和观察 token；私有批准标识不通过任务列表返回。

取消禁止下一轮，向支持取消的操作传播信号，丢弃晚到模型结果。确定未开始的任务可为 `cancelled`，已有已知效果的会话可能为 `partial`，未知效果、冲突或中断为 `needs_attention`。轮数或时限耗尽也不会扩大授权。宿主启动不自动重放中断 UI 输入，旧驱动会话不能用于新窗口。

应用任务跨轮保留 `running` 与下一阶段；内嵌协调器的 `sessions.advance` 可在已验证边界返回 `paused`。当前 CLI 的 `session-run` 驱动完整循环，没有单轮推进或重启后 UI 续跑命令。应用效果需人工核查时不盲目 Ctrl+Z，目前不提供一般 Undo。

生产宿主每个生命周期只执行一个记事本文档任务；同一任务的三阶段仍连续推进。后续不同任务须 `host-stop`、重新启动宿主并准备新计划，旧驱动会话不复用。第二任务在新模型请求或 UI 输入前拒绝；停止宿主不自动关闭记事本窗口。

HTTP 服务绑定 `127.0.0.1`，验证 Host、Origin、实例标识和 bearer token。任务通道可准备、查询、取消，执行及会话运行需要控制通道；服务串行协调写操作。相同系统账户代码仍属于可信边界，这不是不可信插件的 OS 沙箱。

实现见[协调器](../../packages/agent/src/autonomy.ts)、[记事本适配器](../../packages/agent/src/notepad-agent.ts)、[应用运行时](../../packages/runtime/src/notepad-task.ts)和[服务](../../packages/agent/src/service.ts)。真实窗口、离线模型、原生驱动协议与云端调用分别统计，最新验证记录见 [STATUS](../../STATUS.md)。
