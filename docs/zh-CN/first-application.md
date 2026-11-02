# 首个真实应用 Windows 记事本

更新日期：2026-10-31。固定记事本计划、合成规划三轮和真实 DeepSeek 三轮均已通过服务 IPC、应用任务宿主、原生驱动及持续守卫；四类真机故障保护通过。发行版配置已按精确 `11.2607.14.0/zh-CN` 放行，默认生产服务闭环与第二任务拒绝也已实测。原生范围为 UTF-8 无 BOM、CRLF/LF、固定正文与新副本，不是任意应用规划。

## 当前证据与交付边界

| 层次 | 已验证内容 | 证据边界 |
| --- | --- | --- |
| 任务运行时离线合同 | 合成文件和注入驱动验证固定文本、逐阶段执行、身份绑定、编码、换行、取消、超时和重启保护 | 这些离线检查本身不证明真实 UI 行为 |
| 多轮协调与服务 | 固定计划绑定目标与输出，模型每轮只选择 `open`、`edit`、`save-copy`，控制通道批准后连续执行三轮 | 正文、路径与权限固定，不是自由规划 |
| 真实云模型加合成编辑器 | 真实 DeepSeek 三轮 889/912/895 token，合计 2,696；会话成功、源文本保持、副本精确相等，保守估算 0.0038343 USD（非账单） | 该批次不包含原生记事本 UIA 执行 |
| 早期截图引导冒烟 | 在 `Microsoft.WindowsNotepad 11.2607.14.0` 独立测试窗口实际打开、编辑、另存合成文档；独立重读得到 178 字节、UTF-8 无 BOM、CRLF 的准确副本，源文件未变 | 截图记录本身没有机器可读缓冲区证据 |
| 原生原语真机探测 | 同版本 RichEdit 的 TextPattern/ValuePattern 可读；专用窗口定向打开、编辑和文件名输入已实测，另存得到 145 字节精确副本，源文件未变 | 该历史批次未经过完整服务/宿主链；后续固定计划成功单独记录 |
| 固定计划加原生驱动 | 服务 IPC → 应用宿主 → 原生驱动完整链路，CRLF/LF 两次成功；三个阶段均为 `verified/native-window/targeted`，中文路径、标题修改、追加和空行保留，源文不变且只新增精确副本 | 多轮规划、其他编码/版本/语言/DPI 及完整故障矩阵 |
| 本地合成规划加原生驱动 | 三轮 `open/edit/save-copy` 均 verified，完整 IPC 链成功、源文保持、精确副本且仅新增预期文件 | 早期两次 `GUARD_INPUT_CHANGED` 拒绝另计；规划器为合成实现 |
| 真实云模型加原生驱动 | 真实 DeepSeek 三轮均 verified/succeeded，3 次请求、843/890/810 token，合计 2,543，保守估算 0.0038316 USD；源文保持且副本精确 | 固定批准正文和路径，不含自由改写与扩权；费用不是账单 |
| 原生故障矩阵 | 缓冲修改、未授权对话框、显式驱动关闭、守卫进程中断四类均进入 needs_attention，源文不变且无输出；人工缓冲保留 | 通过独立应用 runtime/driver，非任意 UI 扰动或完整服务故障全集 |
| 生产配置选择与默认服务 | `NOTEPAD_PROFILE_RELEASE_READY=true`；默认服务选择配置后完整任务 succeeded，第二任务在新输入前拒绝 | 精确版本/语言、UTF-8 无 BOM、每宿主一个文档；通用驱动无 profile 仍禁用保存 |

早期 Computer Use 的 `accessibility: null` 是该工具的读取缺口；后续原生 UIA 已读到完整缓冲区，不能继续据此判断记事本没有可访问性。早期截图记录仍保留为 `real-notepad-screenshot-guided-smoke`、`runtimeAutonomousAcceptance: false`，位于 `%TEMP%\deskshell-notepad-live-8f30be924c97465bb3dcf82ef9f30295\verification.json`。截图、原生原语、合成驱动、多轮模型和产品端到端证据分别登记。

固定计划证据分别保存在 `%TEMP%\deskshell-notepad-task-gTttNh\native-verification.json`（CRLF）与 `%TEMP%\deskshell-notepad-task-Iub4pg\native-verification.json`（LF），类型为 `approved-native-notepad`。两份记录均为 `succeeded`、`goal.satisfied=true`、源文件不变、精确副本和仅新增预期文件；该批次不调用模型，显式注入候选配置；后续放行与默认服务路径另行验证。

三轮原生证据位于 `%TEMP%\deskshell-notepad-task-QTiwOk\native-verification.json`（本地合成规划）及 `%TEMP%\deskshell-notepad-task-rAEZ8F\native-verification.json`（真实 DeepSeek）。后者 `newRequests=3`，每轮请求和原生 journal 均 verified。早期两次人工输入拒绝保留为失败记录，不混入成功次数。

默认生产服务证据为 `%TEMP%/deskshell-notepad-task-HnCZB2/native-verification.json`：`defaultServiceProfile=true`，配置 `notepad-11.2607.14.0-zh-CN-v2`，三个原生阶段与精确副本目标通过，`secondTaskRejectedBeforeInput=true`。probe 同时报告 `available/profileVerified=true` 和 `runtimeVerified=false`，分别表示配置可用及探测不替代运行验收。

[配置选择器](../../packages/drivers/windows/notepad-profile-selection.ts) 已放行精确 `11.2607.14.0/zh-CN`，不匹配或能力不全时拒绝准备/执行；实际控件仍逐步核验。`notepad-probe` 是元数据/能力报告，`runtimeVerified` 始终为 `false`，`profileVerified` 与 `profileSelection` 另行表示配置状态，不能把探测成功当作当前文档验收。CLI、环境变量和模型没有覆盖候选配置的入口。

## 选择理由

首个应用需要同时验证磁盘文件、内存文档、窗口与控件之间的关联，也需要能独立检查最终产物。记事本适合从纯文本任务起步，保存结果可通过文件读取核验，且当前开发机已安装，无需先建立外部业务账户。

这项选择用于验证语义资源身份、固定计划和执行证据。它不证明已支持任意办公应用，也不把记事本文本范围自动当作可安全合并的结构化字段。JSON 字段级选择性恢复继续在 RFC 0002 的受控原语中验证。

## 与首条文件任务的关系

照片按月整理、重复内容进入待确认目录仍是第一条完整文件任务。专用 UI fixture 验证基本控件合同后，以记事本文档任务进入真实应用；后续可把文件整理结果接入记事本，形成归档说明的组合流程。

首轮真实应用任务使用独立测试目录中的 `任务说明.txt`：读取已知正文，按用户指令修改指定标题并补充一段已给定的内容，另存为同目录的 `任务说明-已整理.txt`。不要求模型自由生成长文，便于独立判断操作是否正确。

## 完整任务验收

1. 宿主记录源文件身份、完整内容、编码和换行，确认输出目标未冲突。模型只得到已允许向云端发送的任务观察。
2. 打开已知测试文件，建立文件、文档实例、窗口与活动标签的证据关系；检查实际正文与预期源文件一致。标题相同不足以确认目标。
3. 可信调用者给出完整目标正文或明确追加文本，准备具体差异、目标路径与后置条件，按固定计划批准；模型每轮只能选择已批准的下一阶段。
4. 仅在核验到的文档上编辑。执行后读取编辑缓冲区，确认目标段落、保留内容和活动文档正确；UI 输入成功返回不能替代这一步。
5. 另存为指定新文件，核验保存结果与路径，独立重读磁盘内容。源文件保持原内容，输出内容满足目标；编码和换行分别检查。
6. 展示任务结果、效果与未完成状态。遇到人工编辑或身份不明时保留现场并报告冲突；本版尚无应用 Undo 或自动补偿，不能以文件任务恢复代替应用恢复。

这条验收必须真正经过记事本的编辑与保存操作。先在文件系统中写好全部结果再打开文件，只能算文件工作流与应用启动检查，不能算应用编辑验收通过。

## 文档身份与设置

测试记录 Windows 版本、记事本应用版本、语言、DPI、窗口实例、活动标签、源/目标路径与文档内容。应用更新后先跑能力探测，不把 `11.2607.14.0` 当作已确认的最低支持版本。

先使用任务创建的测试文档和可可靠区分的窗口/标签。本机记事本会共享 PID 管理多个窗口，因此以具体窗口、选中标签和文档绑定来隔离；不能为了满足“唯一进程”假设关闭用户窗口。定向操作仅作用于已验证的控件；全局输入前仍核验前台窗口、键盘焦点和文档。

需要探测控件的 TextPattern、ValuePattern、选择与输入能力。微软文档明确 TextPattern 主要用于读取和选择，不提供直接文本修改，实际写入需依据控件支持的其他方式验证。[UI Automation TextPattern](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-textpattern-overview)

记事本有会话恢复相关行为，微软曾说明其可恢复标签与未保存内容；会话保存不能等同磁盘文件保存。本次安装版本的具体行为仍需实测，记录开关、恢复状态和未保存指示，不能直接沿用旧版本结论。[微软记事本会话恢复说明](https://blogs.windows.com/windows-insider/2023/08/31/new-updates-for-snipping-tool-and-notepad-for-windows-insiders/)

测试不通过静默修改用户全局设置制造成功。需要特定设置时，在可控测试配置中登记；无法满足该前提则记录未通过及原因。

## 原生适配的确定设计

以下设计依据本机 `11.2607.14.0` 的实际观察形成，驱动整合与验收状态按上表登记。

| 实际发现 | 驱动采用的合同 |
| --- | --- |
| 同 PID 多窗口；标签 HelpText/ItemStatus 没有完整路径 | 创建并认领专用新窗口，绑定进程启动身份、HWND、选中标签与 Document；由该窗口所属 Open 对话框的明确路径操作建立来源关联 |
| RichEdit 同时支持 TextPattern/ValuePattern，但 `ValuePattern.SetValue` 未产生所需 dirty 状态 | 完整文本仍由机器接口读取；编辑采用已验证的定向 `EM_SETSEL + EM_REPLACESEL` 路径，随后核对正文及真实修改标志，不主动清改标志制造成功 |
| 编辑器原始段落分隔符为 CR，源文件可为 CRLF 或 LF | 将原始缓冲区表示与保存字节区分，依据原文约定精确映射，保留末尾换行和空行；两种换行已分别通过完整原生执行，磁盘哈希与编码仍比较完整字节 |
| 文件对话框的 UIA 只暴露 Pane，缺少所需 patterns | 使用经确认的原生 HWND、窗口类、控件 ID 与 owner 链定位输入框/按钮；每个操作重新核验所属窗口和目标控件 |
| Save As 文件名 `WM_SETTEXT` 后读回正确，但应用内部路径模型未更新 | 文件名采用已实测成功的 `EM_REPLACESEL` 交互路径；文本读回只是前提，最终另存路径及字节还要独立验证 |
| Save As 中三个 ComboBox 使用相同控件 ID | 按完整编码选项签名唯一定位编码框，不能只凭 ID 或找到的第一个控件；选择后读取当前项并独立核对保存字节 |

`inputMode` 已进入运行时合同。默认 `foreground` 保留焦点保护；只有驱动显式声明 `targeted` 且观察证据一致时，计划才允许定向输入。模式纳入计划摘要，焦点实际值保留在 journal；targeted 的观察 token 只忽略焦点变化，仍绑定窗口、标签/文档、路径、正文、dirty 和标题。任何使用全局键盘的备用操作仍须紧邻输入核验前台，不允许后台发送键盘事件。

路径关联按操作链维护：Open 前后记录源文件身份和完整字节；对话框 owner 必须归属于认领窗口，完整绝对路径在提交前读回；返回后绑定该窗口中明确选中的标签与 Document。不能用同名、同字节或相似标题重建丢失的关联。Save As 如需更新原生控件标识，只能发生在已登记的保存阶段并记录明确的前后关系。

持续守卫从第一次打开前完成就绪握手，一直覆盖模型思考和短命驱动调用之间的间隙。当前实现保守地比较交互会话最后输入时间戳是否改变，不假设它单调增长。鼠标移动或键盘输入都可能永久使本次关联失效，包括用户操作其他应用和已授权动作期间；不采集按键或窗口正文。宿主为 Open/Save As 登记有时限、绑定操作的短许可，只允许已核验的菜单窗口及最多一个所属原生对话框；保存须观察到该对话框完整周期，许可结束时不能残留可见 owned 窗口。helper 在实际输入前后检查输入时间戳，并通过私有管道确认许可仍有效。未获准窗口事件、守卫失联、消息序号缺口、消息泵中断或重启使关联失效。

这是一项合作式人工冲突守卫，用于阻止“同一标签人工另存到另一目录的同名同字节文件”后继续沿用旧关联；它不证明没有丢失任何 OS 事件，也不抵御同账户外部代码任意调用 UIA 或 SendMessage。各阶段仍重新核验选中标签、文档身份、完整文本与文件。targeted 合同允许单纯焦点变化，当前原生守卫则进一步要求无人工输入的连续执行区间，因此暂不承诺用户可在执行期间同时操作其他应用。守卫的实际集成与故障结果须单独验收，实现见[连续会话守卫](../../packages/drivers/windows/notepad-session-guard.ts)。

当前候选原生配置仅支持 UTF-8 无 BOM，CRLF 与 LF 已分别实测。运行时离线合同支持 UTF-8 BOM、UTF-16LE BOM，不意味着原生驱动支持这些编码；它们须另行验证缓冲区映射、文件对话框选择和最终字节。

## 恢复边界

磁盘文件、未保存文档、撤销栈和会话恢复数据是不同状态。文件恢复成功后，记事本仍可能保留较新的缓冲区并再次保存，所以不能只比较磁盘哈希就宣布整个应用已恢复。

本版应用任务没有普通 Undo、Ctrl+Z 补偿或自动恢复入口，文件任务的 `undo/recovery-apply` 不适用于记事本文档。执行前取消无 UI 效果；已有 UI 效果后的取消、超时、未知保存结果或重启进入 `needs_attention`，保留缓冲区、文件和 journal。尚未结束的驱动调用继续占用执行权，不能在迟到效果未结束时启动另一任务。

后续应用恢复须同时核验文件身份、内容和文档状态。若文档仍打开，必须处理或明确报告其未恢复状态，防止再次写回；不能盲目发送 Ctrl+Z，也不批量关闭应用来清理测试。

人工修改、未知保存状态、标签替换、会话恢复内容不明或恢复中断时，分别报告冲突、已知残留或结果未知。文件级恢复、文档级补偿和完整任务恢复分开计数；未核验的撤销栈或应用历史不宣称已经恢复。

## 必须包含的扰动

本轮已完成以下四类真机检查；均在专用合成窗口中先成功打开，再注入扰动，随后确认没有 edit intent、输出文件或源文改动。

| 已验证场景 | 观察到的拒绝 | `%TEMP%` 下的证据文件 |
| --- | --- | --- |
| 缓冲区外部修改 | `BUFFER_CHANGED`，修改后的缓冲区保留 | `deskshell-native-faults-wTiCso/deskshell-notepad-task-Jek6m2/fault-verification.json` |
| 未授权另存对话框 | `GUARD_UNLEASED_EVENT`，精确绑定的 owned dialog 取消后确认关闭 | `deskshell-native-faults-N2Wqvw/deskshell-notepad-task-yqZs9q/fault-verification.json` |
| 显式驱动关闭 | `NOTEPAD_DRIVER_CLOSED` | `deskshell-native-faults-o9bgYl/deskshell-notepad-task-t7gcm6/fault-verification.json` |
| 守卫进程中断 | `GUARD_EXITED`；仅终止夹具创建的 monitor 子进程，未终止记事本 | `deskshell-native-faults-gBpGW8/deskshell-notepad-task-5NYnpd/fault-verification.json` |

下表是更完整的持续验收范围；不能把上面四项推导为所有场景均已真机通过。

| 场景 | 通过条件 |
| --- | --- |
| 同名同字节标签切换 | 选中标签与文档 token 不符时停止，不凭内容相同继续 |
| 同一标签人工另存到另一目录的同名文件 | 持续守卫使旧路径关联失效，即使正文与 RuntimeId 未变 |
| 多窗口、切换焦点、窗口重建 | targeted 允许单纯失焦；实际对象变化拒绝，前台键盘操作仍检查焦点 |
| 未保存的用户修改 | 保留修改并报告冲突，不用源文件快照覆盖缓冲区 |
| 输出重名与保存失败 | 不静默覆盖既有文件；验证实际目标及夹具内意外文件，错误与残留可定位 |
| 编码、换行和中文文本 | 精确验证 raw CR 映射、空行/末尾换行与磁盘编码字节，显示正确不能替代验收 |
| 云端断网、超时与晚到响应 | 不开始依赖新推理的动作；取消后晚到提案不触发执行 |
| 修改后、保存前、保存后中断 | 可区分缓冲区修改、磁盘保存与未知状态，不盲目重放 |
| 恢复时人工再次修改 | 冲突可见，人工工作不被静默覆盖 |

目标成功、错误对象操作、人工修改保护、文件与文档恢复、拒绝、未知结果、误报完成分别报告。首次冒烟先验证定位、读取、编辑和保存能力，再扩展扰动矩阵。

## 已实现的运行时合同

[应用运行时](../../packages/runtime/src/notepad-task.ts) 与旧文件宿主分离。`prepare` 不操作 UI，绑定源文件身份、完整字节、修改时间、编码、换行、新副本路径、目标正文、驱动会话与代码摘要。计划默认 10 分钟有效；批准须携带精确 ID 和摘要。源与目标须在同一获准根目录及文件系统，目标不得已存在，状态目录与文档根目录分离。

`advance` 每次只执行 `open`、`edit`、`save-copy` 中的一步，`expectedPhase` 拒绝重复请求跳到下一阶段。各阶段前后绑定 `appId/windowId/documentId/driverSessionId` 与完整观察 token；标识可以由驱动提供，不凭窗口标题猜路径或伪造 PID。驱动还须在实际输入前再次比较 token。

每个 UI 效果先持久化 intent，再紧邻输入检查源文件和目标路径，验证后记为 verified。保存阶段重读磁盘的完整字节、身份、编码和换行。`tasks.observe` 再次核验实际 UI 与文件，历史 `succeeded` 不替代当前目标检查；CLI `notepad-status` 只显示持久记录。

运行时合同支持严格 UTF-8、UTF-8 BOM、UTF-16LE BOM，以及一致 LF 或 CRLF；当前原生配置限 UTF-8 无 BOM。拒绝混合换行、孤立 CR、NUL、无效 Unicode、链接和超限文本。源文件及编码后目标正文上限为 256 KiB；CLI 目标正文文件另限 16,384 字节，IPC 请求体上限 65,536 字节。

生产宿主每个生命周期只执行一个记事本文档任务。第二个任务在任何新模型调用或 UI 输入前返回 `NOTEPAD_HOST_RESTART_REQUIRED`；同一任务的原三阶段可继续。完成或异常后须停止并重新启动宿主，再准备新计划。宿主不会自动关闭记事本窗口；已产生的缓冲区与文件供人工核查，旧计划不能跨驱动会话继续执行。

## CLI 使用方式

在仓库根目录创建全新合成夹具并查询能力：

```powershell
$fixture = node apps/agent/cli.ts notepad-fixture | ConvertFrom-Json
npm run agent -- notepad-probe --root $fixture.root --state $fixture.stateDir
```

在精确支持的版本/语言和 UTF-8 无 BOM 文档上准备计划。探测结果只是配置与能力报告；实际窗口、文件和控件仍在执行阶段核验。操作期间保持无鼠标或键盘输入，输入冲突会停止当前会话。

```powershell
$plan = node apps/agent/cli.ts notepad-plan --root $fixture.root --state $fixture.stateDir --source $fixture.sourcePath --copy $fixture.copyPath --text-file $fixture.textFile | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "记事本计划未准备成功；检查能力探测结果。" }
npm run agent -- notepad-inspect --root $fixture.root --state $fixture.stateDir --plan $plan.planId
```

单独审阅源文件、目标正文、另存路径与完整摘要后，确定性执行入口是：

```powershell
npm run agent -- notepad-apply --root $fixture.root --state $fixture.stateDir --plan $plan.planId --digest $plan.digest
```

若由模型逐轮选择下一步，保留尚未执行的计划，改用[多轮任务说明](autonomous-tasks.md)中的 `session-plan/session-run`。不要对同一计划先直接 apply，再启动多轮会话。

查询、取消与停止宿主分别使用：

```powershell
npm run agent -- notepad-status --root $fixture.root --state $fixture.stateDir --task $plan.taskId
npm run agent -- notepad-cancel --root $fixture.root --state $fixture.stateDir --task $plan.taskId
npm run agent -- host-stop --state $fixture.stateDir
```

实现见[原生驱动](../../packages/drivers/windows/notepad.ts)、[服务](../../packages/agent/src/service.ts)和[CLI](../../apps/agent/cli.ts)。旧 [notepad-demo](../../packages/skills/notepad-demo/index.ts) 仍是录制草稿，不作为这套合同的实现依据。

## 开发者真机冒烟

以下命令显式创建专用合成文件和新记事本窗口，并保留验收证据；需要当前用户会话的真实桌面。普通无桌面回归不执行这些 UI 或云端命令。先审阅测试范围，运行期间保持无人工输入；结束不自动关闭记事本窗口。

```powershell
node scripts/notepad-native-live-smoke.ts --native
node scripts/notepad-native-live-smoke.ts --native --lf
node scripts/notepad-native-live-smoke.ts --native-production
node scripts/notepad-native-live-smoke.ts --native-offline
node scripts/notepad-native-fault-smoke.ts --native-faults
```

`--native` 使用显式候选配置，`--native-production` 使用默认服务选择器，`--native-offline` 使用本地合成规划器但仍操作真实记事本。需要验证真实云模型时，另外显式运行下列命令；它读取本机 DPAPI 凭据，最多调用 DeepSeek 3 次，正常成功为 3 次，消耗共享日预算，没有自动重试：

```powershell
node scripts/notepad-native-live-smoke.ts --native-live
```

下一步扩展同名同字节切换、人工另存、取消与恢复等扰动，以及其他版本/语言/编码的独立支持矩阵。技术路线见 [RFC 0001](../../rfcs/0001-local-agent-system.md)，最新验证状态见 [STATUS](../../STATUS.md)。
