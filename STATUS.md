# STATUS — 这个项目现在到底是什么成色

写这份文件的目的：让任何人（包括三个月后的我们）在**五分钟内**判断这个项目值不值得继续投入。
当前修复的验证与历史自动生成的证据分开记录，避免把旧版结果当成当前版本。

## 撤销语义修复轮（2026-11-01，未发布）

对上一轮工程化改动做了第二轮独立审计：三个只读审计员分别对着**执行内核安全语义**、**常驻宿主与授权链**、**工程卫生与文档真实性**跑探针。这一轮修的是审计里能当场复现的洞，主题是**撤销不能成为后门**。

审计发现的最严重问题不是"权限没检查"，而是"权限只检查了一半"：动作路径有两层检查，撤销动作里的路径从来没被查过；不可逆闸门只认字面量 `"noop"`，九个变体全部绕过；账本按文件名合并同目录 JSON，一次普通写入就能让 `undo` 执行伪造条目。

| 问题 | 证据（修复前探针输出） | 处理 |
| --- | --- | --- |
| `undo` 里的 `path/from/to` 完全不经过 root 检查 | `.tmp/audit-sec/p1`：`write.undo→root外` 落地 `OWNED-BY-UNDO`；`move.undo` 把文件搬出 root；`mkdir.undo` 删掉 root 外目录 | `checkAction` 与 `applyUndo` 双层校验撤销路径；计划阶段只做词法检查（本批动作自己会改拓扑），执行撤销时再解析真实路径 |
| 不可逆删除闸门只认字面量 `"noop"` | `p2`：`NoOp`/`NOOP`/`"noop "`/`{}`/`{kind:0}`/`bogus`/`fs.restore+null`/`fs.rmdir` 共 9 个变体全部 `accepted 文件=已被永久删除 journal=rolled-back` | `undo.kind` 改白名单；`fs.delete` 只认"带原文的 `fs.restore`"；`applyUndo` 补 `default: throw` |
| `fs.delete <root>` 合法，一次 `rmSync` 清掉整个任务根 | `p3`：`checkAction(fs.delete root) allowed=true` | 破坏性动作拒绝作用于 root 自身 |
| 账本按名字合并同目录 `<主名>-*.jsonl` | `p13` 端到端：两个零越界的 `fs.write` 投毒后 `undo --last` 写出 root 外文件 | 撤销路径校验后伪造条目只能做 root 内的操作；同目录非普通文件一律忽略 |
| 名字匹配的**目录**让 `load()` 抛 EISDIR，history/undo 全挂 | `p14`：一次普通 `mkdir` 后 `load` 抛错 | `rotatedFiles` 只认普通文件，`readLines` 读失败降级为空 |
| 硬链接穿透：`nlink=2` 不是 reparse point，双层检查都放行 | `p10 A`：`fs.write` 改掉 root 外文件内容 `PWNED-VIA-HARDLINK` | 写入目标 `lstat().nlink > 1` 直接拒绝 |
| `checkAction` 与 `execute` 之间有 `await` 钩子（TOCTOU） | `p7`：钩子里把目录换成 junction，第二步写出 root | 钩子挪到逐动作复查之前 |
| 撤销覆盖已有文件 = 删除，原内容丢失 | `p8`：覆盖后撤销，`<文件已被删除，原内容丢失>`；>64 MiB 无指纹时静默覆盖 | 覆盖已有文件且 undo 只能删除时按不可逆处理；`fs.restore` 无指纹一律拒绝 |
| 失败动作的自撤对 `fs.delete` 永远不触发 | 探针：删除成功后置断言失败 → 文件消失、`rolledBack: 0`、报告不提 | `selfUndoSafe` 不再要求"文件还在"；归属交给指纹闸 |
| 未知动作 kind 不查能力、不执行、却记一条 `ok` | `p9 b`：`process.exec` → `journal=["process.exec:ok"]` | 动作白名单 + `execute` 补 `default: throw` |
| 断言路径不受 root 约束（存在性预言机） | `p11`：只有 `fs.write` 能力也能探到 `C:\Windows\win.ini` 是否存在 | 断言路径同样走 root 检查（允许指向 root 本身） |

新增 `scripts/undo-integrity-test.ts`（15 项，已进回归）：上面每一条都有对应用例，修好之前 14/15 是红的。
全量回归 **80/80 passed**；审计探针复跑：`p1/p2/p3/p6/p7/p8/p10/p11/p12/p13/p14` 全部从"可利用"变成"拒/保留现场"。

这一轮**没修**、需要下一轮决定的（都有实测数据）：

| 未决项 | 实测 | 为什么要先决定 |
| --- | --- | --- |
| 能力语义仍然偏软 | `p9`：只授 `fs.write` 就能 `fs.delete`；声明 `scope` 限 sub，实际写 `elsewhere` 仍通过；MCP 把 manifest 声明直接当授予 | 这是设计取舍（`fs.write` 是否包含删除、scope 是否按动作落地），改了会动协议 |
| `fs.mkdir` 打在已存在目录上仍记 ok | `p10 D`：撤销时 `rmdir` 删掉用户原有空目录 | 需要给"这一步真新建了什么"加字段，会动冻结的日志字段 |
| 悬空 junction 策略层放行 | `p4 F`：`checkAction.allowed=true`，靠执行期 `ENOENT` 兜住 | 需要在策略层 `lstat` 判 reparse point，顺带处理"目标稍后出现"的时序 |
| 撤销计数把失败步自撤算进 `rolledBack` | `p5 D`：`rolledBack=1` | 会改 `RunReport` 语义与既有断言 |
| `markRolledBack` 整文件重写非原子 | 未复现丢失（600 条并发可解析） | 真正的修法是 append-only 状态事件，会动账本格式 |

同轮的**运行时**审计（常驻宿主/IPC/批准链/预算/MCP）只跑出原始证据、没跑完，结论不完整，以下按"实测到、未处理"记，证据在 `.tmp/audit-runtime/EVIDENCE.md`：

| 实测 | 含义 |
| --- | --- |
| 批准链站得住：改计划/改版本/改摘要 → `CORRUPT_PLAN`；任务令牌调 `apply`/`recovery.apply`/`shutdown` → `CONTROL_REQUIRED`；重放幂等 | 这一层可以继续信任 |
| 植一个 `host-endpoint.json` 后，CLI 只做一次 `health` 就复用：打印伪造的 preview、`status=succeeded`、把 `--intent` 原文送到伪宿主、并用文件里的 `controlToken` 调 `apply` | 发现文件没有进程身份证明；与"同账户代码受信"的设计一致，但 CLI 不该只凭可达性就上控制令牌 |
| 70 个空闲 loopback 连接就能让 `health` 返回 `HOST_UNREACHABLE`；只发半行头可占位 12 秒以上 | 无鉴权前置的连接耗尽；需要连接数上限 + 请求头超时 |
| 时钟前跳一天 → 立刻拿到新日额度（`afterForwardJump: OK`） | 日预算的前跳防护缺失（回退已防） |
| 一条 payload 不自洽的 plan 能让宿主无法停止（`HOST_STOP_INCOMPLETE`） | 停止路径要能跳过不可解析记录 |
| MCP 收到一行 `null` 直接 `TypeError` 退出 | **本轮已修**：非法请求回 `-32600`，`scripts/mcp-test.ts` 加了一条（15/15） |

## 评审修复轮（2026-10-31 晚，未发布）

对上一轮工程化改动做了独立评审：两名评审者分别只读审查核心执行内核与常驻智能体运行时，另外跑了打包、文档构建与端到端 CLI。这一轮修的是评审里能当场证明的洞，不是新能力。

| 问题 | 证据 | 处理 |
| --- | --- | --- |
| `fs.delete` + `undo:{kind:"noop"}` 绕过硬删闸，preview/undo/日志三重谎报 | 评审探针实测：无 `allowIrreversible` 也执行，文件消失，日志标 `rolled-back` | 策略拒绝 noop 占位的删除；`fs.move`/`fs.write` 的 noop 算不可逆 |
| 路径检查只在批次开头做一次，同批两步可写出 task root | 评审探针：junction 先 move 再 write，落地到 root 外 | 改为逐动作复查；越界按失败处理并回滚已完成步骤 |
| `fs.move` 撤销无条件删目标位文件；`fs.delete` 撤销无内容指纹 | 评审探针：用户新建的同名文件被静默覆盖 | 撤销带 sha256 指纹，目标位不符即拒绝并保留现场 |
| 一行半截 JSON 让整份账本不可读，回滚收尾还会顶掉原始错误 | 评审探针：`load()` 抛 SyntaxError，`RunReport` 返回 `null` | 坏行跳过且原样保留；回写失败降级为附加说明 |
| 轮转文件名写死 `journal-`，自定义日志名丢历史 | 评审探针：`audit.jsonl` 轮转后只读到 1 条 | 轮转前缀跟随主文件名 |
| `node scripts/build-docs.ts` 在 Windows 上崩掉（`fs.cpSync` → 访问违例，退出码 139），`site/` 只剩 `style.css` | 本地实测 | 新增 `copyTree()`；文档构建恢复 36 页，`docs.build` 重新进回归 |
| `npm i -g` 后 `npm run demo` / `npm run clock` 找不到文件 | `npm pack --dry-run` 清单比对 | `files` 覆盖 `apps/`、`scripts/` 等目录；新增 `packaging-test` 用真实清单断言 |
| 文档里 `latest=0.18.6`、"公共 npm 还在等 2FA 批准"等陈旧说法 | `npm view` 实测 `latest=0.18.7` | 中英文 install 与 README 同步更新 |

`npm run cleanroom`（把源码复制到系统临时目录再跑回归）**72/72 passed，4 skipped，94.4 秒**；4 项跳过仍是 doctor、doctor JSON、桌面壳与录制器，不是原生 Notepad 验收。新增 `undo-honesty-test`（9 项）与 `packaging-test`（40 项断言）纳入回归，协议冻结项从 24 增至 27。

仍未处理、需要在下一轮决定的（有实测数据，不是猜测）：apply/undo 每步做一次全树 `captureTree`，成本 O(步数×节点)，240 张照片 41.7 秒，而客户端 `tasks.apply` 超时是 120 秒，超时后宿主仍在写盘但 CLI 报 `IPC_CANCELLED`；`sessions.prepare` 之前只回 digest 不回正文（本轮已带 `preview`）；凭据与私有状态目录仍缺自动化用例。这些见文末"未决"。

## 应用任务与有界多轮版本（2026-10-31，未发布，真机自主验收未完成）

新增独立 NotepadTaskHost、持久 AutonomyHost，以及常驻宿主上的 `notepad-*` / `session-*` 命令。记事本计划固定源文件身份、编码、换行、完整目标正文和新副本路径；会话一次批准同一摘要后，模型可连续提出 `open → edit → save-copy`，每轮由本地宿主重新观察、校验并记录效果。模型没有批准接口，也不能修改正文、路径、能力或预算。错误步骤可在有界轮次内重规划，取消、未知效果和崩溃不自动重放。

真实 DeepSeek 验证使用合成编辑器，三轮分别返回 889 / 912 / 895 token，合计 **2,696 token、3 次请求**，保守估算合计 **0.0038343 USD**（不是账单）。完整会话成功、源文本保持、输出精确相等。验证记录位于本机临时目录 `deskshell-notepad-task-EhW4Eg/live-verification.json`；这是实际云模型与合成应用执行器联调，不是原生 UIA 验收。

Windows Notepad `11.2607.14.0` 另经 Computer Use 截图逐步引导，实际打开合成文档、改标题及追加正文、通过另存为生成新文件。磁盘重读确认 178 字节、UTF-8 无 BOM、CRLF、中文内容精确相等，源文件不变。工具未返回可访问性正文，不能为自主运行时提供完整缓冲证据；用户随后按 Esc 停止桌面操作，已停止一切桌面输入。原生驱动代码及离线协议测试已建立，但没有执行原生 helper；生产 profile 未启用，`notepad-plan` 默认返回 `CAPABILITY_UNAVAILABLE`。这项阻塞保留，不把截图成功或仿真成功当作全自动应用成功。

新增分组验证：记事本状态机 **34/34**、多轮协调器 **16/16**、三轮适配器 **11/11**、真实 IPC/CLI 应用集成 **9/9**、原生传输协议 **21/21**，均为离线合成测试。关停发现的半关闭、并发等待和迟到效果所有权问题已修复：未决操作仍占用宿主，停止不完整时保留端点和查询，允许明确重试。

冻结源码后的独立临时副本执行全量无桌面回归：**68/68 passed，4 skipped**。16 个新增或变更的核心源码/测试与验证副本 SHA-256 一致；本地打包安装检查 18/18、文档构建 36 页通过。4 项跳过为 doctor、doctor JSON、桌面壳与录制器检查，不是原生 Notepad 验收通过。详见[应用任务](docs/zh-CN/first-application.md)和[多轮自主任务](docs/zh-CN/autonomous-tasks.md)。长期目标仍进行中；桌面操作已停止，原生应用验收未完成。没有提交、发布或注册开机启动。

## 常驻文件智能体版本（2026-10-31，历史批次）

这一版把受限任务扩展为可持续运行的文件原型：`npm run agent -- ...` / `deskshell agent ...` 共用本地常驻宿主，支持运行期间跨进程查询、停止，完整内容去重待确认，以及单独批准的撤销和中断核查。旧 v0 命令、Shell、MCP 保持原入口，并未全部迁移。

| 交付 | 已实现与验证的范围 |
| --- | --- |
| 宿主与 IPC | 隐藏子进程、每状态目录一个宿主、回环随机端口、当前账户私有 ACL、任务/控制双令牌；执行和恢复必须由控制通道批准。并发启动复用同一实例，运行中状态和取消可达 |
| 照片组合任务 | 根层图像扩展名文件按 mtime/上海时区归档；完整 SHA-256、大小和二次字节比较后，每组保留文件名排序最前的一份，其余移入 `_duplicates` 待确认，不删除或覆盖 |
| 撤销与核查 | 每步持久保存 intent/verified 快照；已验证效果可生成固定恢复计划，精确摘要批准后执行。人工变化、占位或未知新对象保留现场；恢复本身中断也需重新核查批准 |
| 持久预算 | 当前用户的宿主共享 UTC 每日 10 请求/0.10 USD 估算额度；并发原子预留、重启不清零、时钟回退不借旧日额度、未知请求不退款。单次仍限 1 请求/0.01 USD，配置不清已用量 |

15:54 的一次真实 API 请求使用 1,165 token（输入 760、输出 405），保守预留 0.0013473 USD。合成目录经 7 步批准执行后成功；再经独立预览、批准完成 7 步撤销，原始完整树摘要一致，全部 7 个文件的路径、字节、修改时间和身份恢复。真实宿主重启后，任务记录与用户级预算保持。本版本新增真实请求仅 1 次，未使用用户真实照片，最后正常关闭验证宿主。

离线分组检查：照片 26、模型预算 23、恢复 13、服务 13、CLI 9、智能体链路 12；既有模型适配器 17、TaskHost 19、存储 12 继续通过。恢复包含真实子进程强制退出和提交窗口人工改动注入。独立临时副本执行完整回归：**63/63 passed，4 skipped**；本地打包安装检查 18/18，含新 agent 入口；文档站构建 36 页通过。回归发现并修复并发启动的过早失败，修复后整套通过。回归本身不读取真实密钥或调用真实模型。

当前仍限 2,000 节点、单文件 16 MiB、总 64 MiB；无图片解码/EXIF、跨子目录去重、覆盖写入或选择性合并。恢复验证针对进程中断，不代表断电耐久性或原生句柄级无竞态保证。多轮追问/重规划、真实记事本、开机启动和第三方隔离尚未交付，未发布或提交本轮改动。详见[使用说明](docs/zh-CN/agent-file-task.md)、[恢复边界](docs/zh-CN/task-recovery.md)和[预算方案](docs/zh-CN/model-backends.md)。

## 首个文件智能体闭环（2026-10-31，历史批次）

新增仓库内 `npm run agent -- ...` 入口，提供合成夹具、云端计划、保存计划审阅、精确摘要批准执行、状态查看与取消。自然语言目标由 DeepSeek 提出受限方案，本地宿主固定目录与独立验收条件；模型不能签发批准。当前技能将根层图像扩展名文件按修改时间、Asia/Shanghai 时区移入月份目录，保留其他文件，不覆盖、不去重、不读取 EXIF。

本轮一次真实请求（15:39，输入 673 / 输出 189 / 合计 862 token，保守预留 0.0012414 USD，非账单）生成 5 步计划。工程测试在隔离合成目录审阅后，单独通过精确 planId/digest 批准执行，结果 `succeeded`、独立目标验证通过；另以已知夹具内容检查全部 6 个文件，并在新进程读回任务记录。没有读取用户真实照片，云端只收到本次合成目标文本与固定技能说明。

照片技能测试 14 组、智能体链路测试 12 组通过，TaskHost 测试扩展到 19/19。覆盖已有月份目录与冲突、目标内容核验、模型伪造参数/目标、云端等待期间目录变化、跨进程批准/取消/幂等，以及异步动作边界取消。独立临时副本执行完整无桌面回归：**59/59 passed，4 skipped**；回归使用假 HTTP，不消耗真实 API 额度。文档站构建 36 页通过。

这是一条受限文件任务链路；现有 CLI/Shell/MCP 三入口尚未整体迁移，完整观察/重规划循环、可信 IPC、普通撤销、崩溃恢复、每日额度和记事本验收仍待完成。运行期间可在原终端 Ctrl+C；独立 cancel 仅用于未运行任务，已产生的效果保留。操作与约束见 [文件任务使用说明](docs/zh-CN/agent-file-task.md)。

## DeepSeek 首次接入验证（2026-10-31）

已实现 DeepSeek 官方 `deepseek-flash` 提案适配器及 Windows DPAPI 当前账户凭据存储。真实请求一次通过：固定合成目标与技能 schema → 有效提案 → 本地 TaskHost 固定计划，任务停在 `awaiting_approval`；没有批准执行，也没有上传用户文档、截图或本地路径。

北京时间 15:23 的请求返回模型标识 `deepseek-flash`，输入 584、输出 194、合计 778 token。此次限制为一次请求、8 KiB 输入、256 输出 token、30 秒、0.01 美元估算上限；保守预留为 0.0008271 美元，不代表实际账单。凭据目录及密文文件受私有 ACL 保护；明文不写入项目、日志、参数或环境变量。

适配器的 17 组离线检查通过，覆盖 schema、错误去敏、并发预算、超时、取消和响应大小。独立临时副本执行 `node scripts/regress.ts --headless`：**57/57 passed，4 skipped**，包含文档站构建；付费连接演示不进入回归。预算目前只约束单个适配器实例，尚无持久每日额度；这次验证不代表 G3 规划循环完成。使用方式见 [模型接入](docs/zh-CN/model-backends.md)。

## G1 首批实现与验证（2026-10-31）

新增可嵌入的文件 TaskHost/TaskService、固定计划、独立批准对象、SQLite 原子执行认领和保留现场的失败状态。新增固定动作 18/18、文件计划 14/14、存储 12/12、运行时集成 16/16。独立临时副本执行 `node scripts/regress.ts --headless`：**56/56 passed，4 skipped**；隔离演示的真实文件创建与目标校验通过。

当前验证为 Windows / Node 22.23.4，内置 SQLite 仍带实验特性标记。新宿主尚未迁移 CLI/Shell/MCP，没有可信 IPC、普通撤销或 G2 步骤恢复；这批 G1 验证未测试云端 API 与真实应用，之后的云端连接证据见上节。旧 v0 默认补偿保留，新宿主发生失败时保留现场并标 `needs_attention`。使用方式与边界见 [G1 实现说明](docs/zh-CN/task-runtime.md)。

## 前一轮修复验证（2026-10-31）

版本为 `0.18.7` 加未发布修复，环境为 Windows / Node `22.23.4`。在独立临时副本中执行 `node scripts/regress.ts --headless`：**52/52 passed，4 skipped**。

| 检查 | 结果 |
| --- | --- |
| 权限、不可逆确认及撤销记账 `scripts/action-safety-test.ts` | 13/13 |
| 嵌套写入恢复与外部文件保护 `scripts/write-recovery-test.ts` | 6/6 |
| MCP 桌面流程（MockDriver）`scripts/mcp-ui-test.ts` | 19/19 |
| 原有 MCP 子进程协议 `scripts/mcp-test.ts` | 14/14 |
| 文件 R0 `scripts/recovery-bench.ts` | 17 次后置断言失败注入通过，正常路径撤销 5/5 |

`--headless` 明确跳过两项 doctor 检查、桌面壳 UI 自检和录制器检查；本轮没有操作真实窗口。MCP 桌面验证使用内存驱动，不能替代各平台真机验证。R0 的可追溯指标目前只检查日志存在性，覆盖边界见 [docs/zh-CN/recovery.md](docs/zh-CN/recovery.md)。

## 历史快照（0.5.0，2026-10-29）

下方自动证据及后续平台、缺口说明保留自旧版本，不能用于判断当前版本是否已实现对应能力。自动证据可由 `node scripts/status-evidence.ts --write` 刷新；本轮未运行其真实桌面检查。

<!-- EVIDENCE:START（由 scripts/status-evidence.ts 生成，勿手改） -->
- 版本：`deskshell 0.5.0`（协议 v0）
- 环境：win32 / Node 24.21.0 / 2026-10-29
- 规模：59 个 TS 文件，11 个 skill（7 公开 / 4 内部），12 页文档 × 2 语言

| 能力 | 命令 | 实测输出 |
| --- | --- | --- |
| 版本与平台 | `deskshell version` | `deskshell 0.5.0  (protocol v0, node 24.21.0, win32)` |
| 环境自检 | `deskshell doctor` | `7 passed, 0 warning, 0 failed` |
| 驱动自检 | `scripts/verify-driver.ts` | `4 passed, 0 failed` |
| 驱动契约（内存驱动） | `scripts/contract-test.ts` | `13/13 passed` |
| 预览快照 | `scripts/snapshot-test.ts` | `3/3 snapshots match` |
| 全量回归 | `scripts/regress.ts` | `33/33 passed` |
| 照片按月份归档 | `scripts/photo-sort-test.ts` | `files 12 → 2 → 12（原始 12）` |
| 日志归档 + 批量改名 | `scripts/new-skills-test.ts` | `8/8 passed` |
| 指定任务撤销（幂等） | `scripts/undo-test.ts` | `PASS（第二次撤销 0 步）` |
| 性能基准（1000 文件） | `scripts/bench.ts 1000` | `plan 43 ms · apply 793 ms（0.8 ms/步）` |
| 文档站构建 | `scripts/build-docs.ts` | `built 26 pages` |
<!-- EVIDENCE:END -->

---

## 五分钟验证

```bash
node bin/deskshell.ts version    # 版本与平台
node bin/deskshell.ts doctor     # 环境自检（Node/驱动/权限/清单/可写）
node scripts/regress.ts          # 24 项回归
node scripts/status-evidence.ts  # 重跑上面那张表的每一条
```

四条命令全绿 = 这台机器上项目是健康的。上面表格里的每一行都是真的跑过，跑失败会让生成脚本以非零退出。

---

## 关键设计决定（以及为什么）

1. **能力声明是硬校验，不是装饰**：动作必须被声明的能力覆盖，`ui.read` 的 skill 点不了鼠标。
2. **失败也要进日志**：否则"出过什么事"只留在终端里，审计就是假的。
3. **失败动作自身的副作用必须回滚**：0.1.0 修过一次（写完文件才断言失败会留孤儿文件）；0.3.0 又修了一次——**前置断言失败时不该自撤**，否则 `move` 的 undo 会把本来就在目标位置的文件搬走。
4. **内核零模型依赖**：模型只能出现在 `see()` / `plan()` 两个可替换接口后面；断网可用。
5. **预览是默认模式**：`run` 不加 `--mode apply` 绝不动手。
6. **路径检查查两次**：词法（拒绝 `..`）+ 真实路径（root 内指向外部的 junction/symlink 拒绝）。

---

## 平台证据

| 平台 | 状态 | 证据 |
| --- | --- | --- |
| Windows 11 | 已验证 | 上面整张表 |
| macOS 26.6 / arm64 | 已验证（真机，2026-10-29） | `doctor` 8 项全过；20 窗口 36ms；控制树 181 节点；坐标点击 `7 × 8 = 56`；AXPress 被拒时回退到元素中心命中（落点 = 中心）；窗口移动逐像素还原 |
| Linux | 未实现 | 协议已平台无关，补 AT-SPI2 即可 |

macOS 的结论来自真机运行，但当前这台 Windows 上没法复跑——上面的自动表格里不会出现它。

---

## 评审未决项（下一轮开工前先看）

这些是评审实测出来的、本轮**没有**修的问题，按影响排序：

| 未决项 | 实测 | 为什么要先决定 |
| --- | --- | --- |
| apply/undo 每步 3 次全树 `captureTree`，成本 O(步数×节点) | 30/60/120/240 张照片 → 0.64s/1.8s/7.6s/41.7s；步数不变、节点 31→631→1231 时 0.64s→6.4s→12.4s | 客户端 `tasks.apply` 超时 120s，约 400 张就触顶；超时后宿主继续写盘，CLI 却报 `IPC_CANCELLED`/退出码 130（等于告诉用户"已取消"）。要么改增量校验，要么先把超时语义改成"仍在运行，用 status 跟进" |
| 凭据层与私有状态目录零自动化用例 | `credentials.ts`/`credential.ps1` 唯一引用者是交互式 `configure-deepseek.ts` | DPAPI 往返、ACL、替换窗口、失败阶段都靠人工验证；本轮只补了错误码，没补用例 |
| 目录 junction 整树拒绝 | `mklink /J` 后 `UNSUPPORTED_FILE_TREE`，且错误里不含路径 | 把图片库链接到 D: 盘是常规做法，现在会直接失败且不知道是哪个节点 |
| 文档正文上限三层不一致 | task 256 KiB / IPC 64 KiB / CLI 16 KiB | 64–256 KiB 的正文在任何路径都写不进去，报的是传输层 `REQUEST_LIMIT` |
| 零步恢复仍记 `restored` | `recovery.ts` 的 inverse 为空时直接返回 `restored`/`rolledBack:0` | "什么都没做"被写成"已恢复" |
| `--root` 指向用户主目录必然失败 | budgetDir 落在 root 内 → `INVALID_STATE_SCOPE` | "整理我的主目录"这种目标拿到的是看起来无关的错误码 |
| 没有类型检查 | 无构建步骤、无 `tsc`，类型只在阅读时起作用 | 本轮就碰到 `JournalEntry` 缺 `createdDirs` 却没报错；要不要引 `tsc --noEmit` 得先决定（会打破"零依赖"） |

## 没做到的（如实写）

| 缺口 | 影响 | 现在能做什么 |
| --- | --- | --- |
| Linux 驱动未实现 | Linux 只能用文件类 skill | 补 AT-SPI2 即可，驱动接口已经冻结 |
| 录制器是 300ms 轮询 | 快速切换可能漏采；只抓左键 | 事件钩子是下一步 |
| macOS 无拖拽/右键菜单 | 只能点击、输入、移动窗口 | AX 桥已经能按坐标点击，扩展动作类型即可 |
| 没有桌面壳 | 用户仍要自己敲命令 | 产品范围待定（见 roadmap） |
| 公共 npm registry 未发 | `npm i -g deskshell` 装不到 | 已发 `@zhiliangtech/deskshell`（`latest=0.18.7`）；无 scope 的 `deskshell` 停在 0.11.0，别用 |
| 尚无外部贡献者 | 没有真实用户反馈 | 待拍板 |

---

## 需要拍板的五件事

见 [docs/roadmap.md](docs/roadmap.md) 末尾：公开仓库、跨平台投入、产品范围、安全策略、模型接入。

---

## 怎么判断这份文件没在吹牛

1. 表格由脚本生成，命令就在第二列，你自己可以跑；
2. 生成脚本有一条命令失败就以非零退出，不会写出"看起来很绿"的表格；
3. 每个"已完成"背后至少有一条测试，测试名字写在 `scripts/regress.ts` 里；
4. macOS 那几行是真机输出，命令与数字都在"平台证据"里，但本轮没法在这台机器上复现——所以我们把它标成"真机验证过、此处不可复跑"，而不是混进自动表格。
