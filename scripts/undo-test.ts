import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const root = path.resolve(".demo/undo-test");
fs.rmSync(root, { recursive: true, force: true });
execFileSync(process.execPath, ["scripts/make-fixture.ts", root], { stdio: "ignore" });

const mod = (await import(pathToFileURL(path.resolve("packages/skills/downloads-cleanup/index.ts")).href)) as {
  skill: Skill;
};
const skill = mod.skill;
const journal = path.join(root, ".deskshell", "journal.jsonl");

const before = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;
const apply = await run(
  skill,
  { root },
  { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id) as CapabilityId[], journalPath: journal },
  {},
);
const taskId = JSON.parse(fs.readFileSync(journal, "utf8").split("\n").filter(Boolean)[0]).taskId as string;
const mid = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;

const undo = await undoTask(taskId, { mode: "undo", root, granted: [], journalPath: journal });
const after = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;

const second = await undoTask(taskId, { mode: "undo", root, granted: [], journalPath: journal });

const ok =
  apply.steps.every((s) => s.status === "ok") &&
  mid === 0 &&
  undo.rolledBack === apply.steps.length &&
  after === before &&
  second.rolledBack === 0;

console.log(`taskId=${taskId}`);
console.log(`文件 ${before} → ${mid} → ${after}`);
console.log(`撤销 ${undo.rolledBack} 步；重复撤销 ${second.rolledBack} 步（应为 0）`);
console.log(ok ? "\nPASS 指定任务撤销可用且幂等" : "\nFAIL 指定任务撤销异常");
process.exitCode = ok ? 0 : 1;
