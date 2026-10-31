import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { R0Adapter } from "./recovery-bench.ts";

/**
 * 对照跑别人的工具：把这个文件复制成 `r0-adapter-<tool>.ts`，只改 4 个 TODO。
 *
 * 约定（非常重要）：
 *   apply(scenario)   —— 用**被测工具**执行这批动作
 *   undo(scenario)    —— 用**被测工具自己的**撤销/回滚能力
 *   journalLines()    —— 它留下了多少可审计记录（没有就返回 0，别编）
 *   snapshot()        —— 状态快照，用来判断"归零"（文件内容 + 目标是否存在）
 *
 * 作弊的三种常见方式，这个模板故意让你没法作弊：
 *   1. 在 undo 里自己 rm -rf 重建目录 —— 那不是它的撤销，是你的
 *   2. 把 journalLines 写成动作条数 —— 那是日志条数，不是审计能力
 *   3. 只跑成功场景 —— R0 量的就是失败之后
 */
export function createAdapter(): R0Adapter {
  // TODO 1：被测工具的根目录（它自己的沙箱/工作区）
  const root = process.env.R0_TOOL_ROOT ?? path.join(os.tmpdir(), "r0-tool");

  return {
    apply(scenario) {
      // TODO 2：用被测工具跑一遍 scenario.actions
      // 例如：调用它的 HTTP API / CLI；每个动作对应一次调用。
      // 这一步**必须真的动文件**，否则后面的"归零"没有意义。
      throw new Error(`还没实现：把 ${scenario.id} 的 ${scenario.actions.length} 个动作交给被测工具执行`);
    },
    undo(scenario) {
      // TODO 3：调用它自己的撤销/回滚
      // 它没有这个能力？那就返回 0 并让基准判它不及格——这才是对照的意义。
      throw new Error(`还没实现：让被测工具回滚 ${scenario.id}`);
    },
    journalLines() {
      // TODO 4：它能导出多少条可审计记录
      return 0;
    },
    // 状态快照：文件内容 + 目标是否存在。默认实现够用，除非你的工具不落盘。
    snapshot() {
      const files: Record<string, string | null> = {};
      const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else files[path.relative(root, full)] = fs.readFileSync(full, "utf8");
        }
      };
      walk(root);
      return JSON.stringify(files);
    },
  };
}
