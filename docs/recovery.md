# R0 — recovery rate at zero residue

Every computer-use project reports a success rate. Nobody reports what a failure leaves behind. R0 is that second number.

```
node scripts/recovery-bench.ts          # table
node scripts/recovery-bench.ts --json   # same numbers, machine-readable
```

Three scenarios (nested writes, overwrite + move, folder taxonomy) are run twice:

1. **happy path**, then `undo` — the directory must come back byte for byte;
2. **failure injection** at step k, for every k — the kernel must roll back and leave nothing.

## What is measured

| Metric | Definition |
| --- | --- |
| **R0-residue** | after an injected failure, is the directory byte-identical to before? |
| **R0-rollback** | were all steps executed before the failure actually undone? |
| **R0-traceable** | does every step in the journal carry `taskId` + `actionId` + timestamp + status? |

## Current result

```
| 场景 | 计划步数 | 失败注入点 | 残渣归零 | 已撤销/已执行 | 可追溯 |
| nested-writes       | 3 | 1..3 | ✅ | 0/0 1/1 2/2 | ✅ |
| move-and-overwrite  | 3 | 1..3 | ✅ | 0/0 1/1 2/2 | ✅ |
| folder-taxonomy     | 7 | 1..7 | ✅ | 0/0 … 6/6   | ✅ |

R0-残渣     100.0%（13 次失败注入）
R0-回滚     100.0%
R0-可追溯   100.0%
正常路径撤销后逐字节还原：3/3
```

## What this metric already caught

The first run reported **R0-traceable = 76.9%**. Cause: when a step fails, the kernel wrote a `failed` entry to the journal file, but `RunReport.journal` only collected successful entries and the report carried **no `taskId`** — so a failing run could not be cited afterwards. Both are fixed (`RunReport.taskId`, failure entries included), and the metric is now 100%.

A metric that never finds anything is decoration. This one found a hole in the audit trail on day one.

## Limits

- Scenarios are synthetic and file-only. GUI driver failures are not covered yet.
- 13 injections is a start, not a benchmark suite. Adding a scenario should be a 20-line change (`scenarioList` in the script).
- R0 measures *our* kernel. Running other tools through the same harness is the point of publishing it — that has not been done yet.
