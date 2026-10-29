# deskshell

> AI 电脑管家：**协议优先**的内核。每个动作都可预览、可验证、可撤销、可审计。

现状：v0 协议 + 参考实现 + 四个可跑的场景（文件整理 / 标签归档 / 窗口平铺 / 录制回放）。

想先看"成色"而不是功能列表？读 [STATUS.md](STATUS.md)：每条能力配一条可复现命令与当天实测输出。

## 60 秒看完：三个场景，一次撤销

```bash
node bin/deskshell.ts story
```

```
起点：13 个文件在下载目录
[1/3] 整理下载目录：20 步完成
[2/3] 归档浏览器标签：1 个标签页写入清单
[3/3] 平铺窗口：1 个窗口 → 120,100 1000x700
[撤销] 22 步回滚，失败 0 步
       文件 0 → 13（起点 13）
       标签清单 0 份
       窗口 285,285 2880x1538
RESULT: PASS — 三个场景全部可撤销
```

文件、UI 写入、窗口几何，三类副作用走同一个事务：**要么全成，要么全撤**。

## 30 秒跑起来

```bash
node bin/deskshell.ts list                                  # 看有哪些 skill
node scripts/make-fixture.ts                                # 造一个 13 个文件的下载文件夹
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads            # 预览，不动手
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
```

`deskshell run` 默认是预览模式——不加 `--mode apply` 就不会动任何东西。

| 命令 | 用途 |
| --- | --- |
| `deskshell list` | 列出可用 skill |
| `deskshell run <name>` | 预览 / 执行 / 撤销 |
| `deskshell story` | 三场景跑一遍并整体撤销 |
| `deskshell journal` | 审计日志时间线 |
| `deskshell undo --task <id>` | 撤销某一次任务（幂等） |
| `deskshell add <path>` | 安装外部 skill（先打印它要的能力） |
| `deskshell verify` | 检查平台驱动能力 |
| `deskshell doctor` | 环境自检（Node/驱动/权限/清单） |

不需要 API key，不需要联网，不需要模型。

## 30 秒跑一个真实 UI 场景（Windows）

```bash
node apps/cli-demo/ui.ts --root .demo/archive --window Edge --mode preview   # 读浏览器标签，出计划
node apps/cli-demo/ui.ts --root .demo/archive --window Edge --mode apply     # 写出 tabs-*.md
node apps/cli-demo/ui.ts --root .demo/archive --mode undo                    # 撤销，文件消失
node apps/ui-smoke/main.ts                                                   # 驱动冒烟：启动记事本 → 写入 → 回读
```

驱动做的事：`windows()` 枚举顶层窗口、`tree()` 读 UIA 控件树、`invoke/click/type/keys()` 操作控件。
实测：Edge 窗口读到 5 个 TabItem → 生成归档清单 → 撤销后文件被删除；记事本经 `ValuePattern` 写入并回读一致。

## 录制一段操作，生成 skill 草稿

```bash
node apps/recorder/main.ts --seconds 15 --out .demo/recordings/rec.jsonl   # 焦点 + 鼠标点击
node scripts/draft-skill.ts --recording .demo/recordings/rec.jsonl --name my-skill --only "Notepad"
node apps/cli-demo/run.ts --skill packages/skills/my-skill/index.ts --mode preview
```

鼠标点击通过 `WH_MOUSE_LL` 低级钩子捕获，并反查坐标下的 UIA 控件。输入类步骤会自动推断 `ui.value` 断言（"输入框的值必须等于刚才打的字"）；点击类步骤的断言仍需人工补——录制能省掉"从零写到能跑"，但"怎样算成功"必须由人判断。

## 文档

```bash
node scripts/build-docs.ts     # 生成 site/，直接打开 site/index.html
```

## 三个概念

| 概念 | 含义 |
| --- | --- |
| **Capability** | skill 向用户申请的能力（`fs.read` / `fs.write` / `ui.input` …），带作用域和理由 |
| **Action** | 一步操作，必须声明 `pre`/`post` 断言与 `undo` 动作 |
| **Journal** | 审计日志：每一步做了什么、是否成功、怎么撤销 |

## 写一个 skill（约 30 行）

```ts
export const skill = {
  manifest: { name: "my-skill", version: "0.1.0", entry: "./index.ts",
    capabilities: [{ id: "fs.read", scope: "{{root}}", reason: "扫描文件" }] },
  async plan({ root }) {
    return [{
      id: "move:1", kind: "fs.move",
      from: `${root}/a.txt`, to: `${root}/docs/a.txt`,
      post: [{ kind: "path.exists", path: `${root}/docs/a.txt` }],
      undo: { kind: "fs.move", from: `${root}/docs/a.txt`, to: `${root}/a.txt` },
    }];
  },
};
```

内核负责：权限校验 → 预览 → 逐条执行 → 断言 → 失败回滚 → 写审计。

## 目录

```
packages/core/src     # 协议、策略、内核、执行器、审计
packages/drivers/      # windows（已验证）/ macos（实验性）
packages/skills/       # 社区 skill：文件整理、标签归档、窗口平铺、脚手架示例
apps/cli-demo          # 演示：预览 / 执行 / 撤销 / 权限拒绝
apps/recorder          # 录制焦点与点击
scripts/               # 夹具、脚手架、文档构建、回归、驱动自检
docs/                  # 文档源（md），构建后生成 site/
```

## 平台支持

| 平台 | 状态 | 验证命令 |
| --- | --- | --- |
| Windows | 已验证（UIA） | `node scripts/verify-driver.ts` |
| macOS | 真机已验证基础能力（AX 桥） | `node bin/deskshell.ts doctor` |
| Linux | 计划中（AT-SPI2） | — |

## 开发

```bash
node scripts/regress.ts      # 7 项自检
node scripts/build-docs.ts   # 文档站 → site/index.html
node scripts/new-skill.ts --name my-skill
```

贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。许可：MIT。

## 已知限制

- **macOS 未在真机验证**：`doctor` 与 `verify` 是验证入口；按选择器点击 / invoke 尚未实现（需要 AXUIElement）。
- **Linux 驱动未实现**：文件类 skill 不受影响。
- **录制器是轮询采样**（300ms），快速切换可能漏采；只捕获左键。
- **撤销覆盖文件与窗口几何**；网络请求等外部副作用不可撤销（协议层会拒绝 `undo: null` 的动作）。
- 项目处于 `0.x`，协议每次破坏性变更都会走 RFC 并在 CHANGELOG 给迁移说明。

## 版本与路线图

当前 `0.1.0`，见 [CHANGELOG.md](CHANGELOG.md)；后续计划见 [docs/roadmap.md](docs/roadmap.md)（区分"不需要决策"和"需要拍板"两类）。

## 设计红线

1. skill 不准直接调用系统 API，只能产出 `Action`。
2. 每个 `Action` 必须有 `post` 断言；不可撤销的动作必须显式标记，内核会拒绝或要求确认。
3. 能力必须声明、必须带人话理由、必须落在作用域内。
4. 内核不依赖任何模型；模型只允许出现在"理解屏幕"和"拆解任务"两个可替换接口后面。

MIT License.
