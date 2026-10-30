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

## Running the same matrix on another tool

The point of publishing R0 is that someone else can run it. Any tool can be plugged in by implementing three methods:

```ts
// scripts/my-tool-adapter.ts
import type { R0Adapter } from "./recovery-bench.ts";

export function createAdapter(): R0Adapter {
  return {
    name: "my-tool",
    async apply(root, steps, failAt) {
      // run steps 1..failAt-1 for real, stop at failAt, return counts
      return { executed: failAt - 1, rolledBack: /* how many you undid */ 0 };
    },
    async undo(root) { /* undo the last run */ },
    journalLines(root) { return null; },  // null = no audit log
  };
}
```

```bash
node scripts/recovery-bench.ts --adapter scripts/my-tool-adapter.ts
```

### Proof the harness can fail something

A benchmark that passes everything is advertising, not measurement. `scripts/r0-adapter-naive.ts` is a tool that writes files and has **no undo and no journal**; running it through the same fixtures gives:

```
R0-残渣     0.0%
R0-回滚     0.0%
R0-可追溯   0.0%
正常路径撤销后逐字节还原：0/4
```

and the process exits non-zero. `scripts/r0-negative-test.ts` asserts exactly that (5/5). So when deskshell reports 100%, it is being scored by a harness that has demonstrably failed another implementation.

## The UI side (and where we are not done)

Files can be restored byte for byte. Windows and controls cannot — yet. `scripts/recovery-bench-ui.ts` runs the same injection matrix against a mock window and measures **state** instead of bytes (geometry + control values + enabled flags):

```
| 场景 | 失败注入点 | 状态归零 | 已撤销/已执行 |
| move-window      | 1 | ✅ | 0/0 |
| move-window      | 2 | ✅ | 1/1 |
| type-into-field  | 1 | ❌ | 0/0 |
| type-into-field  | 2 | ❌ | 1/1 |
| invoke-button    | 1 | ❌ | 0/0 |

R0-UI 状态归零   40.0%（5 次注入）
R0-UI 回滚       100.0%
正常路径撤销后一致：1/3
```

The reason is not a bug in the benchmark, it is a gap in the protocol: `window.move` has an undo kind, `ui.type` and `ui.invoke` do not — skills can only write `noop`, which means *typed text and pressed buttons stay*.

We publish the 40% instead of hiding it, because:
- a number that only covers the easy half is advertising;
- the fix has a name: a `ui.value` undo kind plus a `setValue` driver primitive, and it has to be implemented for the real Windows driver too, not only for the mock. Until then the honest claim is **"file actions are undoable; UI actions are not yet"**.

## Limits

- Scenarios are synthetic and file-only. GUI driver failures are not covered yet.
- 13 injections is a start, not a benchmark suite. Adding a scenario should be a 20-line change (`scenarioList` in the script).
- R0 measures *our* kernel. Running other tools through the same harness is the point of publishing it — that has not been done yet.
