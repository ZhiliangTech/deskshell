// GFI-10 起步包：screenshot-dedupe 的验收测试。
//
// 用法（20 分钟路径）：
//   1) node scripts/new-skill.ts --name screenshot-dedupe
//   2) 把本文件复制成 scripts/screenshot-dedupe-test.ts
//   3) 实现 plan()，直到 node scripts/screenshot-dedupe-test.ts 打印 4/4 passed
//   4) 在 scripts/regress.ts 里加一行，跑 node scripts/regress.ts
//
// 这份文件故意放在 outreach/starter/ 而不是 scripts/：没实现之前它是红的，
// 放在 scripts/ 会让 CI 变红。复制过去就说明你已经开始做了。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const root = path.resolve(".demo/starter/screenshot-dedupe");
const results: string[] = [];
const check = (name: string, ok: boolean): void => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

// 两个内容完全相同的 png（不同文件名）+ 一个独有文件 + 一个无关文件
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "shot-a.png"), PNG);
fs.writeFileSync(path.join(root, "shot-b.png"), PNG);
fs.writeFileSync(path.join(root, "shot-unique.png"), Buffer.from("deadbeef", "hex"));
fs.writeFileSync(path.join(root, "notes.txt"), "not an image");

const mod = (await import(pathToFileURL(path.resolve("packages/skills/screenshot-dedupe/index.ts")).href)) as {
  skill: Skill;
};
const skill = mod.skill;
const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
const journal = path.join(root, ".deskshell", "journal.jsonl");
const opts = { mode: "preview" as const, root, granted, journalPath: journal };

// 1) 预览：必须正好指出一个重复（b 是 a 的副本，保留旧的那个）
const preview = await run(skill, { root }, opts, {});
const planText = JSON.stringify(preview);
const dupHits = (planText.match(/shot-[ab]\.png/g) ?? []).length;
check("preview 只点名一个重复", dupHits >= 1 && !planText.includes("shot-unique.png"));

// 2) 预览不改盘
check("preview 不动文件", fs.existsSync(path.join(root, "shot-b.png")) && fs.existsSync(path.join(root, "shot-a.png")));

// 3) apply：重复文件进 .trash，原文件一个不少
await run(skill, { root }, { ...opts, mode: "apply" }, {});
const trashed = fs.existsSync(path.join(root, ".trash")) ? fs.readdirSync(path.join(root, ".trash")) : [];
check("apply 把重复移进 .trash", trashed.length === 1);
check("无关文件未被碰", fs.existsSync(path.join(root, "notes.txt")) && fs.existsSync(path.join(root, "shot-unique.png")));

// 4) undo：内容逐字节恢复
await run(skill, { root }, { ...opts, mode: "undo" }, {});
const back = fs.readFileSync(path.join(root, "shot-b.png"));
check("undo 后内容逐字节一致", back.equals(PNG));

console.log(results.join("\n"));
console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
