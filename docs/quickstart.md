# 快速开始

## 环境

- Node.js 22+（本项目在 Node 24 上验证）
- 文件场景：任意平台
- UI 场景：Windows（UIA 驱动），需要 Windows PowerShell 5.1（系统自带）

## 第一次装完，先跑自检

```bash
node bin/deskshell.ts doctor
```

```
PASS node           v24.21.0
PASS platform       win32
PASS driver         28 个窗口，454ms
PASS skills         8 个 skill，0 个不合规
PASS workspace      可写
7 passed, 0 warning, 0 failed
```

它会检查 Node 版本、平台驱动、辅助功能权限（macOS 会明确提示 -1719 与授权路径）、skill 清单合法性、工作目录可写性。

## 30 秒：文件场景

```bash
node bin/deskshell.ts list
node scripts/make-fixture.ts
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
```

预期输出：预览列出 20 步；执行 20 步全部成功，3 个重复文件进 `.trash`；撤销后 13 个文件回到原位。

## 给脚本用：`--json`

```bash
node bin/deskshell.ts run downloads-cleanup --json --mode preview --root .demo/downloads
```

输出一行 JSON：

```json
{"ok":true,"skill":"downloads-cleanup","version":"0.1.0","mode":"preview","root":"...","granted":["fs.read","fs.write"],"steps":[...],"rolledBack":0}
```

退出码：`0` 成功、`1` 有步骤失败、`2` 被权限拒绝或参数错误。

## 一键跑完三个场景

```bash
node bin/deskshell.ts story          # 三个场景 + 整体撤销
node bin/deskshell.ts story --fail   # 故意失败，看自动回滚
```

## 看审计日志

```bash
node bin/deskshell.ts journal --root .demo/journal-test
```

```
1 个任务 / 20 步  (.../journal.jsonl)

task-1793246569535  2026/10/29 12:02:49  20 步  已撤销
  ↩ mkdir .../代码
  ↩ mkdir .../图片
  … 其余 14 步
```

`--json` 可机器读；没加 `--json` 时按任务分组渲染成人能看的时间线。

## 只撤掉某一次

```bash
node bin/deskshell.ts journal --root .demo/cli          # 找到 taskId
node bin/deskshell.ts undo --task task-1793246569535 --root .demo/cli
```

按 action 逆序撤销那一个任务；重复撤销同一条是幂等的（第二次撤 0 步）。

## 用 skill 自带的示例参数

```bash
node bin/deskshell.ts run tile-windows --example grid --root .demo/tile
```

示例放在 skill 目录的 `examples/<name>.json`，只描述参数，`root` 始终由命令行决定。

## 安装外部 skill

```bash
node bin/deskshell.ts add ./my-skill-dir          # 装到 packages/skills/
node bin/deskshell.ts add ./my-skill-dir --force  # 覆盖同名
```

安装时会先把它**会申请哪些能力**打印出来——这是唯一一次让你在"运行之前"看清它想干什么的机会。

## 3 分钟：写出自己的第一个 skill

```bash
node scripts/new-skill.ts --name my-first-skill
node apps/cli-demo/run.ts --skill packages/skills/my-first-skill/index.ts --mode preview
node apps/cli-demo/run.ts --skill packages/skills/my-first-skill/index.ts --mode apply --root .demo/downloads
```

脚手架会生成一个能跑的 skill（把目录里的文件按扩展名统计并写出 `report.md`），你只需要改 `plan()`。

## 30 秒：UI 场景（Windows）

```bash
node apps/cli-demo/ui.ts --root .demo/archive --window Edge --mode preview
node apps/cli-demo/ui.ts --root .demo/archive --window Edge --mode apply
node apps/cli-demo/ui.ts --root .demo/archive --mode undo
```

它会读取 Edge 窗口的标签页标题，写出一份 `tabs-*.md` 归档清单；撤销会把文件删掉。

## 驱动冒烟

```bash
node apps/ui-smoke/main.ts
```

启动记事本 → 通过 UIA `ValuePattern` 写入文本 → 回读校验 → 关闭进程。用于验证输入链路是否可用。

## 权限拒绝长什么样

```bash
node apps/cli-demo/main.ts --mode apply --grant fs.read
```

输出：

```
[拒绝] 权限/策略不通过：
  ✗ 未授予能力 fs.write（在下载文件夹内新建分类目录并移动文件）
```

这就是"最小权限"的默认行为：没批的能力，一步都不会执行。
