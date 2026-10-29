# awesome-list 投稿清单（真实仓库、真实规则）

> 这份清单只做一件事：把 deskshell 放进**别人会来搜的地方**，并且不因为一次低质量 PR 把作者账号信誉用掉。
> 规则来自各仓库的 CONTRIBUTING / README，抓取时间 2026-10-30；投稿前再确认一次规则有没有变。

## 现在就能投（规则宽松、定位匹配）

| 仓库 | star | 最后提交 | 规则要点 | 投到哪一节 | 成功概率 |
| --- | --- | --- | --- | --- | --- |
| `ZoranPandovski/awesome-testing-tools` | 377 | 2026-10-21 | 一个 PR 只加一条、先搜重、选对分类、拼写检查、PR 标题要能说明用途 | Desktop / UI Automation（先看现有分类，没有就提议新分类） | 高 |
| `lukeslp/awesome-accessibility` | 95 | 2026-10-19 | 可以先开 issue 再 PR；要求"高质量、准确、在维护"，写清 1-2 句简介、分类、为什么对无障碍社区有价值 | Tools / Automation | 中高 |
| `ranpox/awesome-computer-use` | 待查 | 活跃 | 明确"欢迎贡献"，按 Videos / Blogs / Papers / Projects 分类 | Projects | 中（先看 Projects 里现有条目的口径） |
| `e2b-dev/awesome-ai-agents` | 30.7k | 2026-08-21 | 列表体量大、维护慢（1200+ open issue），合并周期可能数周 | Agents 列表 | 低-中（投了别等） |

## 先别投（会被拒或伤信誉）

| 仓库 | 为什么不投 |
| --- | --- |
| `rpabotsworld/awesome-rpa` | CONTRIBUTING 明文写"自我推广不受欢迎"，要求"在社区里被广泛推荐/知名"，1 star 的新项目必然被关；等有 3 个外部使用者再回来 |
| `punkpeye/awesome-mcp-servers` | 只收 MCP server；我们现在不是 MCP server。等 MCP adapter 任务合并后再投，届时是完美匹配（97k star，量最大） |
| `yzfly/Awesome-MCP-ZH` | 同上，中文 MCP 生态，等 adapter |
| `WenyuChiou/awesome-agentic-ai-zh` | 是学习路线图，不是工具表 |
| `sickn33/agentic-awesome-skills` | 收的是 agent skill 目录（Claude Code / Codex），我们的 skill 是自家协议包，语义不同，容易被认为是蹭 |

## 统一条目文案（三行以内，别加形容词）

```markdown
- [deskshell](https://github.com/ciceroyang/deskshell) - Protocol-first desktop automation kernel: every action declares a post-assertion and an undo, preview is the default, and every step lands in a JSONL audit journal. No model in the kernel. MIT, TypeScript.
```

中文版（用于中文列表）：

```markdown
- [deskshell](https://github.com/ciceroyang/deskshell) - 协议优先的桌面操作内核：每个动作必须声明后置断言与撤销，默认只预览，全过程写入 JSONL 审计日志，内核不依赖任何模型。MIT，TypeScript。
```

## 提交流程（每个仓库都这么做）

1. **先搜重**：在仓库里搜 `deskshell`，确认没有；顺手看最近 30 个合并的 PR 长什么样（标题、正文长度、有没有 CI）。
2. **Fork + 新建分支**：`add/deskshell`，只改 README 一行（或对应分节）。
3. **PR 正文**（英文，5 行以内）：

```
Adds deskshell, a protocol-first desktop automation kernel.

- Every action declares a post-assertion and an undo; a failed assertion rolls the task back.
- Preview is the default mode; every step is written to a JSONL audit journal.
- Kernel has no model dependency (models live behind see()/plan() inside skills).
- MIT, TypeScript, Node >= 22.18. Windows (UIA) and macOS (AX) drivers verified; Linux has window-level support via xdotool/wmctrl.

Real output, not a mockup: https://github.com/ciceroyang/deskshell#what-it-looks-like
```

4. **等**：7 天没动静就礼貌 ping 一次（"happy to adjust the wording or drop it if it does not fit"），然后不再追。
5. **记录**：把仓库名、PR 链接、日期写进 TRACKER.csv，渠道列写 `awesome:<repo>`。

## 判断标准（写给未来的自己）

- 列表的**筛选逻辑**是"读者会来找工具"，不是"作者想被看到"。我们的条目必须回答"读者为什么要用它"，不是"我们做了什么"。
- 一个列表被拒不是失败；**同一周向 3 个不匹配的列表投稿**才是失败——那会让维护者记住这个账号在刷。
- 每次投稿前问一句：如果我是这个列表的维护者，我会合吗？答案不是"会"，就别投。
