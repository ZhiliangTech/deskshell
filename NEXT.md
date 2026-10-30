# NEXT — 项目侧接下来要做的三件事（设计与验收标准）

> 这份文件是**设计交付**，不是实现。实现归项目会话；这里只写"做成什么样算对"。
> 每条都有：为什么、边界、验收命令、不要做什么。

## 1. MCP adapter（对应 GFI-09）——让别人能把电脑接进 agent

**为什么**：定位是"agent 的 OS 运行时"。没有调用入口，这句话无法验证。

**边界**：零依赖、stdio、手写 JSON-RPC 2.0（不要引入 @modelcontextprotocol/sdk）。三个 tool，不多不少：

| tool | 入参 | 行为 | 失败 |
| --- | --- | --- | --- |
| `deskshell.preview` | `{ skill, root? }` | 调 `kernel.preview`，**只读** | 未知 skill → JSON-RPC error |
| `deskshell.apply` | `{ taskId }` | 执行 preview 过的任务 | 未 preview 的 taskId → 拒绝，不执行 |
| `deskshell.undo` | `{ taskId }` | 撤销该任务 | 已撤销 → 幂等成功，不报错 |

**验收**：`node scripts/mcp-smoke.ts` 依次完成 `initialize` → `tools/list`（恰好 3 个）→ `tools/call preview`（fixture 哈希不变）→ 用不存在的 taskId 调 apply（返回 error 而非崩溃）→ 退出码 0。

**不要做**：不要在这层做权限判断（内核的事）；不要暴露任意 shell；不要在 manifest 里写"支持全部 MCP 客户端"这种没测过的句子。

---

## 2. R0 基准（recovery rate at zero residue）——把"跨时代"变成一个数

**为什么**：所有 computer-use 项目都在比成功率，没人比"失败之后留下了什么"。定义一个别人不测的维度，比在别人的维度上追分更快成为标准。

**定义**：给定 N 个任务 × M 种失败注入，统计三个比例：

```
R0.1 副作用归零率   = 失败后文件树/窗口几何与执行前逐字节一致的任务数 / 总任务数
R0.2 可追溯率       = journal 中每一步都有 actionId + summary + status 的任务数 / 总数
R0.3 撤销还原率     = undo 后与初始快照哈希一致的任务数 / 总数
```

**注入矩阵（最小集）**：第 1 步失败 / 中间步失败 / 末步失败 / 断言失败（动作本身成功）/ undo 本身失败。

**验收**：`node scripts/recovery-bench.ts` 打印一张表（任务 × 注入点 → 三个比例），末行 `R0 = <n>/<n>`，退出码 0，且运行前后仓库工作区无改动（`git status --short` 不变）。

**不要做**：不要为了让数字好看而缩小注入矩阵；报告里必须写明样本量与注入方式，否则这张表没有价值。

---

## 3. 30 秒演示——不读文档就能看懂的瞬间

**为什么**：现在唯一的"证据"是 43 项回归，只有工程师看得懂。破圈需要一个 30 秒内能看懂的镜头。

**分镜（5 拍，无旁白，只有字幕）**：

| 拍 | 画面 | 字幕（EN / 中文） |
| --- | --- | --- |
| 1 | 一个乱的下载文件夹（13 个文件） | "AI is about to clean this up" / "AI 要清理这个文件夹" |
| 2 | preview 输出：步骤、风险、每一步是否可撤销 | "Nothing happens yet. This is the plan." / "还没动手，这是计划" |
| 3 | apply 到第 4 步，断言失败，红字 | "Step 4 failed." / "第 4 步失败" |
| 4 | 前面三步自动退回，文件数回到 13 | "The first three were undone." / "前三步已自动退回" |
| 5 | journal 逐行出现，含失败那一步 | "Every step, including the failure." / "每一步，包括失败" |

**验收**：产出 `docs/assets/undo-30s.gif`（< 4 MB，首屏可加载）与一版 1080p mp4；README 第一屏引用 GIF，不用 mp4。

**不要做**：不要配乐、不要真人出镜、不要用"revolutionary"这类词；字幕只有事实。

---

## 验收现状（运营侧复跑，2026-10-30）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| R0 基准 | ✅ 达标 | `R0-残渣 100% / 回滚 100% / 可追溯 100%（15 次注入），逐字节还原 4/4` |
| MCP adapter | ⚠️ 缺验收脚本 | `docs/mcp.md` 与 `packages/mcp/server.ts` 已有（4 个 tool），但规格要求的 `scripts/mcp-smoke.ts` 尚不存在；补齐前不对外宣称"可接入" |
| 30 秒演示 | ⏳ 未开始 | `docs/assets/undo-30s.gif` 不存在 |

## 优先级与依赖

1. **MCP adapter** 最先——它是定位的接口证明，且不依赖演示素材。
2. **R0 基准** 第二——它需要 adapter 之外的内核能力已就绪（已就绪），可与演示并行。
3. **30 秒演示** 最后——它要拍的是前两件做完后的真实输出，提前拍会拍到临时行为。

## 交给项目会话时的口径

- 每条任务都按"验收命令 + 不要做什么"两段交付，不接受"完成了"这种口头完成；
- 三条都做完之前，不要新增 UI 自动化能力——那不会加强论点；
- 任何一条的验收命令跑不过，就在 issue 里贴真实输出，不要改验收标准。
