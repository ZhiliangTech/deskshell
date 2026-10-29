import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 性能基准：1000 个文件的 plan / apply / undo。
 * 关注三件事：内核本身的开销、审计日志的体积、撤销是否随步骤线性增长。
 */
const N = Number(process.argv[2] ?? 1000);
const root = path.resolve(".demo/bench");
const EXT = [".jpg", ".png", ".pdf", ".txt", ".zip", ".md", ".mp4", ".docx"];

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
for (let i = 0; i < N; i++) {
  fs.writeFileSync(path.join(root, `file-${String(i).padStart(5, "0")}${EXT[i % EXT.length]}`), "x");
}

const mod = (await import(pathToFileURL(path.resolve("packages/skills/downloads-cleanup/index.ts")).href)) as {
  skill: Skill;
};
const skill = mod.skill;
const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
const journal = path.join(root, ".deskshell", "journal.jsonl");

const heap = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

const t0 = performance.now();
const planned = await skill.plan({ root });
const tPlan = performance.now() - t0;

const m0 = heap();
const t1 = performance.now();
const applied = await run(skill, { root }, { mode: "apply", root, granted, journalPath: journal }, {});
const tApply = performance.now() - t1;
const mApply = heap() - m0;

const t2 = performance.now();
const undone = await run(skill, { root }, { mode: "undo", root, granted, journalPath: journal }, {});
const tUndo = performance.now() - t2;

const journalKB = fs.existsSync(journal) ? fs.statSync(journal).size / 1024 : 0;
const left = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;

const fmt = (n: number): string => `${n.toFixed(0)} ms`;
console.log(`文件数            ${N}`);
console.log(`plan              ${fmt(tPlan)}  (${planned.length} 步)`);
console.log(`apply             ${fmt(tApply)}  (耗时/步 ${(tApply / Math.max(applied.steps.length, 1)).toFixed(1)} ms)`);
console.log(`undo              ${fmt(tUndo)}  (回滚 ${undone.rolledBack} 步)`);
console.log(`日志体积          ${journalKB.toFixed(0)} KB  (${(journalKB * 1024 / Math.max(applied.steps.length, 1)).toFixed(0)} B/步)`);
console.log(`堆增长            ${mApply} MB`);
console.log(`撤销后剩余文件    ${left}`);

const ok =
  applied.steps.every((s) => s.status === "ok") &&
  undone.rolledBack === applied.steps.length &&
  left === N;
console.log(ok ? "PASS bench" : "FAIL bench");
process.exitCode = ok ? 0 : 1;
