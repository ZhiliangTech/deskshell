# STATUS — 这个项目现在到底是什么成色

写这份文件的目的：让任何人（包括三个月后的我们）在**五分钟内**判断这个项目值不值得继续投入。
每条能力都配一条可复现命令，输出是当天真跑出来的，不是设计意图。

- 版本：`deskshell 0.3.0`（协议 v0）
- 环境：Windows 11 / Node 24.21.0 / 2026-10-29
- 规模：TypeScript + PowerShell 共 4,254 行，45 个 TS 文件，11 个 skill（7 公开 / 4 内部），12 页文档（中英各 12）

---

## 五分钟验证

```bash
node bin/deskshell.ts version    # 版本与平台
node bin/deskshell.ts doctor     # 环境自检（Node/驱动/权限/清单/可写）
node scripts/regress.ts          # 24 项回归
node bin/deskshell.ts story      # 三场景 + 整体撤销
```

四条命令全绿 = 这台机器上项目是健康的。

---

## 能力 ↔ 证据

| 能力 | 命令 | 实测输出 |
| --- | --- | --- |
| 版本与平台 | `deskshell version` | `deskshell 0.1.0 (protocol v0, node 24.21.0, win32)` |
| 环境自检 | `deskshell doctor` | `7 passed, 0 warning, 0 failed` |
| 驱动自检 | `scripts/verify-driver.ts` | `4 passed, 0 failed`（windows/tree/focus/keys） |
| 驱动契约（内存驱动） | `scripts/contract-test.ts` | `11/11 passed` |
| 全量回归 | `scripts/regress.ts` | `22/22 passed` |
| 文件事务 | `deskshell run downloads-cleanup --mode apply` | 20 步执行，3 个重复文件进 `.trash` |
| 撤销 | `--mode undo` | 20 步回滚，13 个文件回到原位 |
| 指定任务撤销 | `deskshell undo --task <id>` | 幂等：第二次撤 0 步 |
| 三场景 + 整体撤销 | `deskshell story` | `22 步回滚，失败 0 步`；文件 0→13；标签清单 0 份；窗口矩形逐像素还原 |
| 失败即回滚 | `deskshell story --fail` | `回滚 3 步（含失败动作自身副作用），残留 0 项` |
| 失败进审计 | `deskshell journal --root .demo/fail-story` | `4 步 失败 1 步`，失败条目带 detail |
| 录制 → 草稿 | `apps/recorder/main.ts` + `scripts/draft-skill.ts` | 焦点/点击/新窗口三类事件 → 自动推断断言 |
| 安装外部 skill | `deskshell add <path>` | 先打印能力申请单；同名默认拒绝 |
| 预览快照 | `scripts/snapshot-test.ts` | `2/2 snapshots match` |

---

## 关键设计决定（以及为什么）

1. **能力声明是硬校验，不是装饰**：动作必须被声明的能力覆盖，`ui.read` 的 skill 点不了鼠标。
2. **失败也要进日志**：否则"出过什么事"只留在终端里，审计就是假的。
3. **失败动作自身的副作用必须回滚**：这是 0.1.0 修掉的真 bug——写完文件才断言失败，会留下孤儿文件并连带让上层目录删不掉。
4. **内核零模型依赖**：模型只能出现在 `see()` / `plan()` 两个可替换接口后面；断网可用。
5. **预览是默认模式**：`run` 不加 `--mode apply` 绝不动手。

---

## 没做到的（如实写）

| 缺口 | 影响 | 现在能做什么 |
| --- | --- | --- |
| macOS 驱动 | `node bin/deskshell.ts doctor`（在 Mac 上） | `8 passed, 0 failed`；20 窗口 36ms、181 节点、TextEdit 输入回读、计算器 7×8=56、窗口移动逐像素还原 |
| macOS 未实现坐标点击 | 只能按 AX 元素点击，不能点空白处或画布 | 桥里 `click --x --y` 已有，驱动层未接 |
| Linux 驱动未实现 | Linux 只能用文件类 skill | 协议已平台无关，补 AT-SPI2 即可 |
| 录制器是 300ms 轮询 | 快速切换可能漏采；只抓左键 | 事件钩子是下一步 |
| 没有桌面壳 | 用户仍要自己敲命令 | 产品范围待定（见 roadmap） |
| 未公开 | 无外部贡献者、无真实用户反馈 | 待拍板 |

---

## 需要拍板的五件事

见 [docs/roadmap.md](docs/roadmap.md) 末尾：公开仓库、跨平台投入、产品范围、安全策略、模型接入。

在没有这些决定之前，继续加功能的边际收益已经很低——这一点本身也是本轮停止的理由。

---

## 怎么判断这份文件没在吹牛

每条命令都能自己跑；每个数字都能用 `scripts/regress.ts` 复现；每个"已完成"背后都有一条测试。
macOS 的结论已在一台真机（macOS 26.6 / arm64）上跑过，命令与输出都在上面；仍未验证的是点击与 invoke。
