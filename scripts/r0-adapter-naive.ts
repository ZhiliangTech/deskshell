import fs from "node:fs";
import path from "node:path";
import type { R0Adapter } from "./recovery-bench.ts";

/**
 * 一个"没有撤销能力"的对照适配器：把同样的夹具跑一遍，但失败后什么都不回滚。
 *
 * 它存在的意义只有一个——**证明这套基准真的能判别人失败**。
 * 如果 R0 对谁都报 100%，那这个指标就是自欺。
 *
 *   node scripts/recovery-bench.ts --adapter scripts/r0-adapter-naive.ts
 */
export function createAdapter(): R0Adapter {
  return {
    name: "naive (no undo)",
    async apply(root, steps, failAt) {
      let executed = 0;
      for (let i = 1; i <= steps; i++) {
        if (i === failAt) break; // 失败就停手，但不回滚
        const dir = path.join(root, `step-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "out.txt"), `step ${i}`);
        executed++;
      }
      return { executed, rolledBack: 0 };
    },
    async undo() {
      // 这个工具没有撤销能力
    },
    journalLines() {
      return null; // 也没有日志
    },
  };
}
