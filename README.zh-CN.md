<p align="center">
  <img src="brand/banner.svg" alt="deskshell" width="880">
</p>

<p align="center">
  <b>让 AI 操作电脑，但每一步都能预览、验证、撤销、审计。</b><br>
  不是"会点鼠标的脚本"，是一套带事务语义的协议内核。
</p>

<p align="center">
  <a href="https://github.com/ciceroyang/deskshell/actions/workflows/ci.yml"><img src="https://github.com/ciceroyang/deskshell/actions/workflows/ci.yml/badge.svg?branch=main" alt="ci"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="node">
  <img src="https://img.shields.io/badge/model-zero%20dependency-FF7A59" alt="zero model dependency">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

## 它和别的方案的区别

| | 普通 agent / 自动化脚本 | deskshell |
| --- | --- | --- |
| 动手前 | 直接开干，你不知道它会做什么 | `preview` 先给计划，标出风险与是否可撤销 |
| 动手后 | "应该成功了吧" | 每步执行后跑断言，失败即停 |
| 出错时 | 留下半个烂摊子 | 先撤失败动作自身，再逆序回滚全部已成功步骤 |
| 事后 | 没人知道发生了什么 | JSONL 审计：谁、何时、改了什么、怎么撤 |
| 模型 | 绑死某个厂商 | **内核零模型依赖**，模型只是 skill 内部的可替换件 |

## 实际跑起来是这样

![deskshell demo](docs/assets/hero.gif)

<sub>动图由真实命令输出生成（`scripts/make-assets.py`），不是手绘示意图。</sub>

三个场景，一次撤销——文件移动、UI 写入、窗口几何走同一个事务：

![story](docs/assets/story.png)

```
[撤销] 22 步回滚，失败 0 步
       文件 0 → 13（起点 13）
       标签清单 0 份
       窗口 627,551 2880x1538      ← 逐像素还原
```

## 架构

![architecture](docs/assets/architecture.svg)

- **Skill** 只描述意图（`plan() → Action[]`），不碰系统 API、不写回滚逻辑；
- **Kernel** 负责权限、预览、执行、断言、回滚、审计——接口冻结的那一层；
- **Driver** 按平台实现（Windows UIA / macOS AX / Mock），可整体替换。

## 30 秒跑起来

```bash
node bin/deskshell.ts doctor                        # 环境自检
node scripts/make-fixture.ts                        # 造 13 个文件的下载目录
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads              # 只预览，不动手
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
```

不需要 API key，不需要联网，不需要模型。

想亲眼看失败回滚：

```bash
node bin/deskshell.ts story --fail
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `deskshell list` | 列出可用 skill |
| `deskshell run <name>` | 预览 / 执行 / 撤销（默认预览） |
| `deskshell story` | 三场景跑一遍并整体撤销 |
| `deskshell journal` | 审计日志时间线 |
| `deskshell undo --task <id>` | 撤销某一次任务（幂等） |
| `deskshell add <path>` | 安装外部 skill（先打印它要的能力） |
| `deskshell verify` | 检查平台驱动能力 |
| `deskshell doctor` | 环境自检 |
| `deskshell version` | 版本信息 |

## 平台

| 平台 | 状态 | 验证方式 |
| --- | --- | --- |
| Windows | 已验证（UI Automation） | `deskshell doctor` |
| macOS | 已验证（原生 Swift AX 桥，20 个窗口 36ms） | `deskshell doctor` |
| Linux | 计划中（AT-SPI2） | — |

macOS 需要先编译桥：`packages/drivers/macos/build.sh`（Xcode Command Line Tools），并在「系统设置 → 隐私与安全性 → 辅助功能」给终端授权。

## 写一个 skill

```bash
node scripts/new-skill.ts --name my-skill
node bin/deskshell.ts run my-skill --mode preview
```

三条硬规则：每步都要有 `post` 断言；每步都要有 `undo`；skill 里不准直接调系统 API。

## 更多

- [STATUS.md](STATUS.md)：每条能力配一条可复现命令与实测输出
- [CHANGELOG.md](CHANGELOG.md)：0.1.0 归档与已知限制
- [docs/](docs/)：协议、写 skill、撤销语义、录制器、驱动、版本策略、路线图
- `node scripts/build-docs.ts` → `site/index.html`（本地文档站）

## 已知限制

- **macOS 未实现坐标点击**：只能按 AX 元素点击，点不了空白处或画布。
- **Linux 驱动未实现**：文件类 skill 不受影响。
- **录制器是 300ms 轮询**，快速切换可能漏采；只捕获左键。
- **撤销覆盖文件与窗口几何**；网络请求等外部副作用不可撤销（协议层会拒绝 `undo: null` 的动作）。
- 项目处于 `0.x`，破坏性变更走 RFC 并在 CHANGELOG 给迁移说明。

## 设计红线

1. skill 不准直接调用系统 API，只能产出 `Action`。
2. 每个 `Action` 必须有 `post` 断言；不可撤销的动作必须显式标记，内核会拒绝。
3. 能力必须声明、必须带人话理由、必须落在作用域内。
4. 内核不依赖任何模型；模型只允许出现在"理解屏幕"和"拆解任务"两个可替换接口后面。

MIT License.
