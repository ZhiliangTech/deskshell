# INBOUND — 谁来过、要什么、回没回

> 这张表只记**别人主动发来的**东西（issue 评论、PR、discussion、私信）。
> 规则：48 小时内必须有人回；回完填 `answered` 时间；问钱的按"没有现金"回，不绕弯。
> 每轮运营先看这张表，再看 `TRACKER.csv`（那是我们发出去的）。
>
> **一个问题只回一次。** 回之前先翻该 issue 的最新评论时间：已经有本账号的回复就不要再补一条，补重复比不补更难看。第二轮只处理"还没有人答过"的，或者上一轮答错的。
> 并发跑两轮时尤其如此（2026-10-30T18:12Z 那轮就重复答了一遍编号问题，已删重）。

| 时间 (UTC) | 在哪 | 谁 | 要什么 | 类型 | 已回 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-29T16:56 | #3 | michaelwoolum50-cmyk | 提了个 docs 搜索补丁 + 附 USDC 收款地址 | 要钱 / 路径不存在 | 2026-10-29T17:16 | 无现金；`website/docusaurus.config.js` 不存在，站点是 `site/` + `scripts/build-docs.ts`；GFI-07 明令禁止第三方搜索库/CDN。未合并 |
| 2026-10-29T17:00 | #3 | soundcake | 有没有现金？任务编号和 GOOD-FIRST-ISSUES.md 对不上，哪个是准的？ | 问钱 + 真问题 | 2026-10-29T17:16 | 无现金，`bounty` 标签已删；GOOD-FIRST-ISSUES.md 为准，已在 #3 顶部加 `GFI-NN` 映射 |
| 2026-10-29T17:05 | #8 | Kevin-coder0212 | 有 bounty 吗？走哪个平台付？还有人在做吗？ | 问钱 | 2026-10-29T17:16 | 无现金、无平台；目前无人开 PR；给了 GFI-09 验收命令 |
| 2026-10-29T16:59 | #8 | calproencrip | 提议新建 `packages/integrations/mcp/server.ts`，三个工具 + smoke | 认领意向 | 2026-10-29T17:16 | 方向对（内核不依赖模型、不加依赖）；要求拆三个 commit，先 `preview` |
| 2026-10-29T17:02 | #4 | calproencrip | 实现 AT-SPI2 `tree()` / `click()` / `invoke` | 认领意向 | 2026-10-29T17:16 | 方向对；纠正两点：不许绕权限检查（`verify-driver.ts` 断言拒绝路径）、fixture 用 `linux-driver-smoke.ts` |
| 2026-10-29T17:01 | #5 | calproencrip | 录右键/中键/滚轮 + `window.rect` 断言 | 认领意向 | 2026-10-29T17:16 | 确认 `recorder.ps1` 确实零覆盖；要求扩 `recorder-mode-test.ts`、零新依赖 |
| 2026-10-29T17:00 | #6 | calproencrip | 给 `run` 加 `--diff` 统一 diff | 认领意向 | 2026-10-29T17:16 | 确认无 `--diff`；两条硬要求：不写文件/不写 journal、diff 走 driver 读路径 |

## 这一轮学到的（下一轮直接用）

1. **`bounty` 标签是招黑源。** 它招来的不是贡献者，是要钱的和发 USDC 地址的。标签已从 #3 移除并从仓库删除。以后"可认领"一律写成 `help wanted` + 文档里一句"没有报酬"。
2. **编号漂移会被抓。** issue 表格和 `GOOD-FIRST-ISSUES.md` 各一套编号，第一个人就发现了。以后对外只用 `GFI-NN`。
3. **AI 生成的"补丁"会瞎猜路径。** 判据很简单：引用的文件是否存在。`grep` 一下就知道，不用争论。
4. **搭便车平台（Algora/Opire）不存在。** 被问就直说没有，不要含糊成"以后可能有"。
