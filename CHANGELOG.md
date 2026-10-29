# CHANGELOG

本项目遵循语义化版本；`0.x` 期间破坏性变更会写在这里，并给出迁移说明。

## 0.1.0 — 2026-10-29

首个可用版本：协议 + 内核 + 驱动 + skill + CLI + 文档站 + 回归套件。

### 协议 v0

- 能力（Capability）：声明式申请，带作用域与人话理由；未授予则整体拒绝。
- 动作（Action）：`fs.mkdir` / `fs.move` / `fs.delete` / `fs.write` / `ui.invoke` / `ui.click` / `ui.type` / `window.move`。
- 断言（Assertion）：`path.exists` / `path.absent` / `file.count` / `ui.value` / `window.rect` / `window.exists` / `ui.exists`。
- 撤销（UndoAction）：`fs.move` / `fs.rmdir` / `fs.restore` / `window.move` / `noop`。
- 审计（Journal）：JSONL，只追加；记录成功、撤销、失败三种状态。
- 不变式：路径不越界、动作必须可撤销、失败必须回滚、内核零模型依赖、动作必须被声明的能力覆盖。

### 内核

- `preview / apply / undo` 三种模式；`undo` 分"撤销上一次"、"撤销指定任务"、"撤销全部"。
- 失败即回滚：先撤失败动作自身的副作用，再按 LIFO 回滚已成功步骤。
- 失败步骤写入审计日志（`status: "failed"` + `detail`）。
- 回滚与撤销走同一套 `applyUndo(undo, ctx)`，动作类型与撤销类型对称。

### 驱动

- Windows：UI Automation 读控件树、ValuePattern 写入、Invoke/Select、坐标点击、窗口矩形读写、`WH_MOUSE_LL` 点击捕获。
- macOS：原生 Swift AX 桥（`axbridge`）——窗口枚举 36ms、控件树、聚焦、Unicode 输入（绕开输入法）、AXPress 点击、窗口移动与还原；无桥时回落 System Events。
- macOS 实测坑位：AppleScript 枚举窗口 19–23s、`keystroke` 受输入法影响、进程名本地化导致 -1719、计算器按钮无标题只能靠 AXIdentifier。
- Mock：纯内存驱动，用于契约测试与平台无关性验证。

### Skill 与工具

- `downloads-cleanup`：按类型整理下载目录，重复文件移入 `.trash`。
- `browser-tabs`：读取浏览器标签页并生成可撤销的归档清单。
- `tile-windows`：窗口平铺，逐窗可撤销。
- 录制器：聚焦 + 鼠标点击 + 新窗口出现三类事件；草稿生成器自动推断 `ui.value` / `window.exists` / `ui.exists` 断言。
- `deskshell` CLI：`list / run / story / journal / undo / add / verify / doctor`。
- 文档站 8 页 + JSON Schema + 预览快照测试 + 21 项回归。

### 已知限制

- macOS 驱动未在真机验证；`verify` 与 `doctor` 是验证入口。
- Linux 驱动未实现。
- macOS 不支持按选择器点击与 invoke。
- 录制器为轮询采样（300ms），快速切换可能漏采；只捕获左键。
- 撤销语义覆盖文件与窗口几何；网络请求等外部副作用不可撤销。

## 迁移说明

`0.1.0` 之前无公开版本，无迁移负担。
