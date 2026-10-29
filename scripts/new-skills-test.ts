import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const base = path.resolve(".demo/new-skills");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T00:00:00Z").getTime();

async function load(slug: string): Promise<Skill> {
  const mod = (await import(pathToFileURL(path.resolve(`packages/skills/${slug}/index.ts`)).href)) as {
    skill: Skill;
  };
  return mod.skill;
}

function plan(root: string, files: Array<[string, number]>): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [name, ageDays] of files) {
    const file = path.join(root, name);
    fs.writeFileSync(file, name);
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(file, t, t);
  }
}

const results: string[] = [];
const check = (name: string, ok: boolean): void => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

// ---------- log-archive ----------
{
  const root = path.join(base, "logs");
  plan(root, [
    ["app-01.log", 60],
    ["app-02.log", 45],
    ["worker.log", 35],
    ["old.log", 31],
    ["today.log", 1],
    ["recent.log", 5],
    ["notes.txt", 90],
  ]);
  const skill = await load("log-archive");
  const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
  const journal = path.join(root, ".deskshell", "journal.jsonl");

  const apply = await run(skill, { root, now: NOW }, { mode: "apply", root, granted, journalPath: journal }, {});
  const buckets = fs.existsSync(path.join(root, "archive"))
    ? fs.readdirSync(path.join(root, "archive")).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort()
    : [];
  const archived = buckets.reduce(
    (n, b) => n + fs.readdirSync(path.join(root, "archive", b)).length,
    0,
  );
  const remaining = fs.readdirSync(root).filter((f) => f.endsWith(".log"));

  check("log-archive 归档 4 个过期日志", archived === 4 && apply.steps.length === 7);
  check("log-archive 保留未过期日志", remaining.includes("today.log") && remaining.includes("recent.log"));
  check("log-archive 不碰非日志文件", fs.existsSync(path.join(root, "notes.txt")));

  const undo = await run(skill, { root, now: NOW }, { mode: "undo", root, granted, journalPath: journal }, {});
  const back = fs.readdirSync(root).filter((f) => f.endsWith(".log")).length;
  check("log-archive 撤销后完全还原", undo.rolledBack === apply.steps.length && back === 6);
}

// ---------- rename-batch ----------
{
  const root = path.join(base, "photos");
  plan(root, [
    ["IMG_9.jpg", 0],
    ["IMG_10.jpg", 0],
    ["IMG_2.jpg", 0],
    ["IMG_1.jpg", 0],
    ["IMG_3.jpg", 0],
    ["keep.png", 0],
  ]);
  const skill = await load("rename-batch");
  const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
  const journal = path.join(root, ".deskshell", "journal.jsonl");
  const input = { root, pattern: "IMG_*.jpg", prefix: "trip", pad: 3 };

  const apply = await run(skill, input, { mode: "apply", root, granted, journalPath: journal }, {});
  const names = fs.readdirSync(root).filter((f) => f.startsWith("trip-")).sort();
  check(
    "rename-batch 按序编号且不覆盖",
    names.join(",") === "trip-001.jpg,trip-002.jpg,trip-003.jpg,trip-004.jpg,trip-005.jpg",
  );
  check("rename-batch 不碰不匹配的文件", fs.existsSync(path.join(root, "keep.png")));

  const undo = await run(skill, input, { mode: "undo", root, granted, journalPath: journal }, {});
  const restored = fs.readdirSync(root).filter((f) => f.startsWith("IMG_")).length;
  check("rename-batch 撤销后完全还原", undo.rolledBack === apply.steps.length && restored === 5);
}

// ---------- 冲突必须失败并回滚 ----------
{
  const root = path.join(base, "collision");
  plan(root, [
    ["a.jpg", 0],
    ["b.jpg", 0],
  ]);
  fs.writeFileSync(path.join(root, "photo-002.jpg"), "occupied"); // 目标已被占
  const skill = await load("rename-batch");
  const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
  const journal = path.join(root, ".deskshell", "journal.jsonl");

  // 内核的约定是"返回报告而不是抛异常"：失败步在 steps 里标记 failed
  const report = await run(
    skill,
    { root, pattern: "*.jpg", prefix: "photo", pad: 3 },
    { mode: "apply", root, granted, journalPath: journal },
    {},
  );
  const failed = report.steps.some((s) => s.status === "failed");
  const intact =
    fs.existsSync(path.join(root, "a.jpg")) &&
    fs.existsSync(path.join(root, "b.jpg")) &&
    fs.readFileSync(path.join(root, "photo-002.jpg"), "utf8") === "occupied";
  check("rename-batch 目标冲突时失败并回滚", failed && intact && report.rolledBack >= 1);
}

for (const line of results) console.log(line);
console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
