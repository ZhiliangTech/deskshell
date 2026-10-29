import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import { makePhotoFixture } from "./make-photo-fixture.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const root = path.resolve(".demo/photo");
const total = makePhotoFixture(root);
const journal = path.join(root, ".deskshell", "journal.jsonl");

const mod = (await import(pathToFileURL(path.resolve("packages/skills/photo-sort/index.ts")).href)) as {
  skill: Skill;
};
const skill = mod.skill;
const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];

const before = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;

const apply = await run(skill, { root }, { mode: "apply", root, granted, journalPath: journal }, {});
const months = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}$/.test(d));
const after = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;

const undo = await run(skill, { root }, { mode: "undo", root, granted, journalPath: journal }, {});
const restored = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;
const monthsLeft = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}$/.test(d)).length;

const ok =
  before === total &&
  months.length === 3 &&
  after === 2 && // 只剩 notes.txt / manual.pdf
  undo.rolledBack === apply.steps.length &&
  restored === total &&
  monthsLeft === 0;

console.log(`files ${before} → ${after} → ${restored}（原始 ${total}）`);
console.log(`月份目录: ${months.join(", ")}；撤销后剩余 ${monthsLeft} 个`);
console.log(`步骤: apply ${apply.steps.length}，undo ${undo.rolledBack}`);
console.log(ok ? "PASS photo-sort：按月份归档且完全可撤销" : "FAIL photo-sort");
process.exitCode = ok ? 0 : 1;
