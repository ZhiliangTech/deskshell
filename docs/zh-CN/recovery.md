# R0 —— 失败后副作用归零率

所有 computer-use 项目都在报成功率，没有人报"失败之后留下了什么"。R0 就是第二个数。

```
node scripts/recovery-bench.ts          # 表
node scripts/recovery-bench.ts --json   # 同一组数，机器可读
```

三个场景（嵌套写入、覆盖+移动、按类型归档）各跑两遍：

1. **正常路径** + `undo` —— 目录必须逐字节回到原样；
2. **失败注入**：对每一步 k 都注入一次失败 —— 内核必须回滚干净，什么都不留。

## 量的是什么

| 指标 | 定义 |
| --- | --- |
| **R0-残渣** | 注入失败后，目录是否与执行前逐字节一致 |
| **R0-回滚** | 失败前已执行的步骤是否全部被撤销 |
| **R0-可追溯** | 日志里每一步是否都带 `taskId` + `actionId` + 时间戳 + 状态 |

## 当前结果

```
R0-残渣     100.0%（13 次失败注入）
R0-回滚     100.0%
R0-可追溯   100.0%
正常路径撤销后逐字节还原：3/3
```

## 这个指标已经抓到了什么

第一次跑出来 **R0-可追溯 = 76.9%**。原因：某一步失败时，内核对**日志文件**写了 `failed` 记录，但 `RunReport.journal` 只收集成功的条目，而且报告里**根本没有 `taskId`**——失败的那一单事后无法被指认。两处都已修（`RunReport.taskId`、失败条目入账），现在是 100%。

一个从不发现问题的指标只是装饰。这个指标上线第一天就在审计链上找到个洞。

## 用同一套夹具量别的工具

发布 R0 的意义就在于别人能跑。任何工具只要实现三个方法就能接进来：

```ts
// scripts/my-tool-adapter.ts
import type { R0Adapter } from "./recovery-bench.ts";

export function createAdapter(): R0Adapter {
  return {
    name: "my-tool",
    async apply(root, steps, failAt) {
      // 真实执行 1..failAt-1，在 failAt 停手，返回计数
      return { executed: failAt - 1, rolledBack: /* 你撤回了多少 */ 0 };
    },
    async undo(root) { /* 撤销最近一次 */ },
    journalLines(root) { return null; },  // null = 没有审计日志
  };
}
```

```bash
node scripts/recovery-bench.ts --adapter scripts/my-tool-adapter.ts
```

### 证明这套基准真的会判人失败

一个永远都过的基准是广告，不是测量。`scripts/r0-adapter-naive.ts` 是一个"只写不回滚、也没有日志"的工具，用同一套夹具跑出来是：

```
R0-残渣     0.0%
R0-回滚     0.0%
R0-可追溯   0.0%
正常路径撤销后逐字节还原：0/4
```

进程退出码非零。`scripts/r0-negative-test.ts` 就是断言这件事（5/5）。所以当 deskshell 报 100% 时，它是由一套**已经证明能把别人判失败**的夹具量出来的。

## 边界

- 场景是合成的，只覆盖文件操作。GUI 驱动的失败还没纳入。
- 13 次注入是起点，不是基准套件。加一个场景只需改脚本里的 `scenarioList`（约 20 行）。
- R0 量的是**我们自己的内核**。用同一套夹具去跑别的工具才是发布它的意义——这一步还没做。
