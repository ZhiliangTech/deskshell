import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const base = path.resolve(".demo/parallel");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T00:00:00Z").getTime();
const checks: string[] = [];
const check = (name: string, ok: boolean): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

async function loadSkill(slug: string): Promise<Skill> {
  const mod = (await import(pathToFileURL(path.resolve(`packages/skills/${slug}/index.ts`)).href)) as {
    skill: Skill;
  };
  return mod.skill;
}

// 夹具：图片 + 旧日志 + 一个新日志
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
// 图片时间固定到三个月，保证 photo-sort 分成 3 个目录
for (const [name, iso] of [
  ["IMG_0001.jpg", "2026-03-04T10:00:00Z"],
  ["IMG_0002.png", "2026-04-11T10:00:00Z"],
  ["IMG_0003.heic", "2026-05-17T10:00:00Z"],
] as Array<[string, string]>) {
  const f = path.join(base, name);
  fs.writeFileSync(f, name);
  const t = new Date(iso);
  fs.utimesSync(f, t, t);
}
for (const [name, ageDays] of [
  ["old-a.log", 60],
  ["old-b.log", 45],
  ["fresh.log", 2],
] as Array<[string, number]>) {
  const f = path.join(base, name);
  fs.writeFileSync(f, name);
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(f, t, t);
}

const journal = path.join(base, ".deskshell", "journal.jsonl");
const photo = await loadSkill("photo-sort");
const logs = await loadSkill("log-archive");
const grants = (s: Skill): CapabilityId[] => s.manifest.capabilities.map((c) => c.id) as CapabilityId[];

// 1) 真并发：两个 skill 同时跑，各自独立
const [a, b] = await Promise.all([
  run(photo, { root: base }, { mode: "apply", root: base, granted: grants(photo), journalPath: journal }, {}),
  run(logs, { root: base, now: NOW }, { mode: "apply", root: base, granted: grants(logs), journalPath: journal }, {}),
]);

check("photo-sort 全部成功", a.steps.length > 0 && a.steps.every((s) => s.status === "ok"));
check("log-archive 全部成功", b.steps.length > 0 && b.steps.every((s) => s.status === "ok"));
check(
  "两份任务写进同一份日志",
  new Set(load(journal).map((e) => e.taskId)).size === 2,
);

const months = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}$/.test(d));
const archived = fs.readdirSync(path.join(base, "archive")).filter((d) => /^\d{4}-\d{2}$/.test(d));
check("照片进月份目录、日志进 archive", months.length === 3 && archived.length === 2);

// 2) 按任务撤销只影响自己
const photoTask = load(journal).find((e) => e.summary.includes("IMG_0001"))?.taskId;
if (photoTask) {
  const undone = await undoTask(photoTask, { mode: "undo", root: base, granted: grants(photo), journalPath: journal }, {});
  const imagesBack = fs.readdirSync(base).filter((f) => f.startsWith("IMG_")).length;
  const logsStillArchived = fs.existsSync(path.join(base, "archive"));
  check("撤销照片任务只回滚照片", undone.rolledBack === a.steps.length && imagesBack === 3 && logsStillArchived);
} else {
  check("撤销照片任务只回滚照片", false);
}

// 3) 失败隔离：一个 skill 失败，另一个照样完成（CLI 层）
const fixture = path.join(base, "isolation");
fs.rmSync(fixture, { recursive: true, force: true });
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, "IMG_0001.jpg"), "x");

let exitCode = 0;
let out = "";
try {
  out = execFileSync(
    process.execPath,
    ["bin/deskshell.ts", "run", "assertion-fail", "photo-sort", "--parallel", "--mode", "apply", "--root", fixture],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  const e = err as { status?: number; stdout?: string; stderr?: string };
  exitCode = e.status ?? 1;
  out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
}

const photoOk = fs.readdirSync(fixture, { recursive: true, encoding: "utf8" }).some((f) => /2026-\d{2}/.test(f));
check("一个 skill 失败不影响另一个", photoOk && /exit [12]/.test(out));
check("整体退出码为非零", exitCode !== 0);

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
