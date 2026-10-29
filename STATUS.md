# STATUS — 这个项目现在到底是什么成色

写这份文件的目的：让任何人（包括三个月后的我们）在**五分钟内**判断这个项目值不值得继续投入。
每条能力都配一条可复现命令，下面的输出全部由 `node scripts/status-evidence.ts --write` 当场跑出来，不是设计意图。

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

## 没做到的（如实写）

| 缺口 | 影响 | 现在能做什么 |
| --- | --- | --- |
| Linux 驱动未实现 | Linux 只能用文件类 skill | 补 AT-SPI2 即可，驱动接口已经冻结 |
| 录制器是 300ms 轮询 | 快速切换可能漏采；只抓左键 | 事件钩子是下一步 |
| macOS 无拖拽/右键菜单 | 只能点击、输入、移动窗口 | AX 桥已经能按坐标点击，扩展动作类型即可 |
| 没有桌面壳 | 用户仍要自己敲命令 | 产品范围待定（见 roadmap） |
| 公共 npm registry 未发 | `npm i -g deskshell` 装不到 | GitHub Packages + Release tarball 两条通道可用 |
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
