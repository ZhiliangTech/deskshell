import fs from "node:fs";
import path from "node:path";
import { run } from "../../packages/core/src/kernel.ts";
import type { Action, Skill } from "../../packages/core/src/types.ts";

const failAtArg = process.argv.indexOf("--fail-at");
const failAt = failAtArg > -1 ? Number(process.argv[failAtArg + 1]) : 3;

const root = path.resolve(".demo/fail-story");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const journal = path.join(root, ".deskshell", "journal.jsonl");

/** 把第 index 步的断言换成一定失败的断言，用来演示"失败注入" */
function withFailure(index: number, action: Action): Action {
  if (index !== failAt) return action;
  return {
    ...action,
    post: [{ kind: "path.exists", path: path.join(root, `never-created-${index}.txt`) }],
  };
}

const a = path.join(root, "a.txt");
const dir = path.join(root, "sub");
const b = path.join(dir, "b.txt");
const c = path.join(root, "c.txt");

const skill: Skill = {
  manifest: {
    name: "fail-story",
    version: "0.0.0",
    description: "在第 N 步注入失败，用来演示自动回滚",
    entry: "./index.ts",
    capabilities: [
      { id: "fs.write", scope: "{{root}}", reason: "演示写入" },
      { id: "fs.read", scope: "{{root}}", reason: "演示读取" },
    ],
  },
  async plan(): Promise<Action[]> {
    return [
      withFailure(1, {
        id: "1-write-a",
        kind: "fs.write",
        path: a,
        content: "A",
        post: [{ kind: "path.exists", path: a }],
        undo: { kind: "fs.restore", path: a, content: null },
      }),
      withFailure(2, {
        id: "2-mkdir-sub",
        kind: "fs.mkdir",
        path: dir,
        post: [{ kind: "path.absent", path: path.join(root, "sub-impossible") }],
        undo: { kind: "fs.rmdir", path: dir },
      }),
      withFailure(3, {
        id: "3-write-b",
        kind: "fs.write",
        path: b,
        content: "B",
        post: [{ kind: "path.exists", path: b }],
        undo: { kind: "fs.restore", path: b, content: null },
      }),
      withFailure(4, {
        id: "4-write-c",
        kind: "fs.write",
        path: c,
        content: "C",
        post: [{ kind: "path.exists", path: c }],
        undo: { kind: "fs.restore", path: c, content: null },
      }),
    ];
  },
};

const report = await run(
  skill,
  { root },
  { mode: "apply", root, granted: ["fs.write", "fs.read"], journalPath: journal },
  {},
);

for (const s of report.steps) {
  const mark = s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : "✗";
  console.log(`  ${mark} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
}

const leftovers = fs.readdirSync(root).filter((f) => !f.startsWith("."));
const failed = report.steps.filter((s) => s.status === "failed").length;
const expectedRollback = Math.min(failAt, 4);

const journalEntries = fs
  .readFileSync(journal, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { status: string });

console.log(
  `\n回滚 ${report.rolledBack} 步（含失败动作自身的副作用）；工作目录残留：${leftovers.length} 项 ${leftovers.join(",") || "（空）"}`,
);
console.log(`审计日志：${journalEntries.length} 条，其中失败 ${journalEntries.filter((e) => e.status === "failed").length} 条`);

const ok =
  failed === 1 &&
  report.rolledBack === expectedRollback &&
  leftovers.length === 0 &&
  journalEntries.some((e) => e.status === "failed");
console.log(ok ? `PASS 第 ${failAt} 步失败 → 全量回滚，且失败被写进审计日志` : "FAIL 回滚或日志不完整");
process.exitCode = ok ? 0 : 1;
