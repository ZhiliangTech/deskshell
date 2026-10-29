import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 日志轮转：
 *   - 超过阈值自动归档成 journal-<时间>.jsonl
 *   - load() 跨文件按时间顺序读
 *   - 撤销旧任务时只改它所在的那个文件，不产生重复条目
 */
const root = path.resolve(".demo/journal-rotate");
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
process.env.DESKSHELL_JOURNAL_MAX_BYTES = "600";

const kernelPath = path.resolve("packages/core/src/kernel.ts");
const journalPathResolved = path.resolve("packages/core/src/journal.ts");
const { run, undoTask } = (await import(pathToFileURL(kernelPath).href)) as {
  run: typeof import("../packages/core/src/kernel.ts").run;
  undoTask: typeof import("../packages/core/src/kernel.ts").undoTask;
};
const { load } = (await import(pathToFileURL(journalPathResolved).href)) as typeof import("../packages/core/src/journal.ts");

const journal = path.join(root, ".deskshell", "journal.jsonl");
const granted: CapabilityId[] = ["fs.write"];

const make = (n: number): Skill => ({
  manifest: {
    name: `rotate-probe-${n}`,
    version: "0.0.0",
    description: "probe",
    entry: "./index.ts",
    capabilities: [{ id: "fs.write", scope: "{{root}}", reason: "probe" }],
  },
  async plan({ root: r }) {
    const file = path.join(r, `payload-${n}.txt`);
    return [
      {
        id: `write-${n}`,
        kind: "fs.write",
        path: file,
        content: "x".repeat(80), // 让单条日志足够大，几次就触发轮转
        post: [{ kind: "path.exists", path: file }],
        undo: { kind: "fs.restore", path: file, content: null },
      },
    ];
  },
});

const taskIds: string[] = [];
for (let i = 1; i <= 12; i++) {
  const before = load(journal).length;
  await run(make(i), { root }, { mode: "apply", root, granted, journalPath: journal }, {});
  const after = load(journal);
  taskIds.push(after[after.length - 1].taskId);
  if (after.length !== before + 1) check(`第 ${i} 次追加后条目数正确`, false, `${before} → ${after.length}`);
}

const dir = path.dirname(journal);
const rotated = fs.readdirSync(dir).filter((f) => /^journal-.*\.jsonl$/.test(f)).sort();
check("触发了日志轮转", rotated.length >= 1, rotated.join(", "));

const all = load(journal);
check("跨文件读回全部 12 条", all.length === 12, `实际 ${all.length}`);
check(
  "条目按时间升序",
  all.every((e, i) => i === 0 || all[i - 1].ts <= e.ts),
);

// 撤销最早的那个任务：它大概率已经在轮转文件里
const oldest = taskIds[0];
const report = await undoTask(oldest, { mode: "undo", root, granted, journalPath: journal }, {});
const afterUndo = load(journal);
const oldestRows = afterUndo.filter((e) => e.taskId === oldest);
check("撤销轮转文件里的任务成功", report.rolledBack === 1);
check("该任务被标记 rolled-back", oldestRows.every((e) => e.status === "rolled-back"));
check("没有产生重复条目", afterUndo.length === 12, `实际 ${afterUndo.length}`);
check(
  "其它任务状态未受影响",
  afterUndo.filter((e) => e.taskId !== oldest).every((e) => e.status === "ok"),
);

// 清理环境变量，避免污染后续进程
delete process.env.DESKSHELL_JOURNAL_MAX_BYTES;

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
