# 桌面壳（MVP）

壳是"一个框、一句话"的入口。它不新增能力——跑的是 CLI 跑的那个 kernel，只是把**动手前的账单**摆在你面前。

## 启动

```powershell
# 在仓库根目录执行；需要桌面会话（Windows）
$env:DESKSHELL_NODE = "C:\path\to\node.exe"   # 可选，默认用 PATH 里的 node
powershell -ExecutionPolicy Bypass -File apps/shell/ui.ps1 -Root "C:\Users\me\Downloads"
```

任何地方按 **Ctrl+Alt+Space** 唤起。

## 一句话之后发生什么

1. 你输入类似 `清理下载文件夹`。
2. 壳**在本地**把它跟已装技能匹配——不接模型、不联网。分数接近的会列成候选；完全不像的会直接说没有，而不是硬猜：

   ```
   没有匹配的技能。
   当前可用：dedupe-folders、downloads-cleanup、first-skill、…
   ```

3. 面板展示**能力申请单**、步骤列表和汇总——全部来自 `kernel.preview`，只读。
4. **执行** 调 `kernel.apply`；**取消** 调 `cancel()`，别的什么都不做。

## "取消零副作用"是被测出来的，不是承诺

`scripts/shell-test.ts`：

```
PASS  取消返回明确信号
PASS  取消后文件系统零变化
PASS  取消后没有产生日志
PASS  预览不写日志
```

UI 自检（`scripts/shell-ui-selftest.ts`）更进一步：真的把窗口开起来、真的注册热键、跑一次预览、取消，然后检查夹具目录里仍然只有原来那两个文件，且没有 `.deskshell` 日志。

## 这一版故意没有的东西

- **没有模型。** 匹配是对技能名和描述的关键词打分。说"把上周的截图按项目分一下"它不会变成计划——那是 M08 的事。
- **没有常驻服务。** 面板就是个普通进程，进程退出热键就没了。
- **只有 Windows。** `ui.ps1` 是 WinForms。核心（`apps/shell/core.ts`）与平台无关且已有测试，GTK/Qt 的壳可以直接复用。

## 不开界面也能用同一套逻辑

```bash
node apps/shell/cli.ts skills
node apps/shell/cli.ts match "清理下载"
node apps/shell/cli.ts preview downloads-cleanup --root .
node apps/shell/cli.ts apply downloads-cleanup --root .
node apps/shell/cli.ts cancel
```

每条命令输出一行 JSON——PowerShell 界面就是解析它。
