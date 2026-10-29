import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FixtureBackend, RuleBackend, resolveIntent } from "../apps/shell/intent.ts";
import { apply, listShellSkills, preview } from "../apps/shell/core.ts";

/**
 * M08：一句话 → 带参数的计划。
 * 关键不是解析出好看的 JSON，而是**参数真的进了 plan**。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

// ---------- 1) 解析 ----------
const cases: Array<[string, string, (a: Record<string, unknown>) => boolean, string]> = [
  [
    "去重一下下载文件夹里的图片",
    "dedupe-folders",
    (a) => Array.isArray(a.extensions) && (a.extensions as string[]).includes(".jpg"),
    "extensions 含 .jpg",
  ],
  ["把 30 天前的日志归档", "log-archive", (a) => a.maxAgeDays === 30, "maxAgeDays=30"],
  [
    "批量重命名，前缀 trip，只改 jpg",
    "rename-batch",
    (a) => a.prefix === "trip" && JSON.stringify(a.pattern) === '[".jpg"]',
    "prefix=trip pattern=[.jpg]",
  ],
  ["从 src 镜像到 backup", "sync-mirror", (a) => a.source === "src" && a.dest === "backup", "source/dest"],
];

for (const [query, wantSkill, wantArgs, label] of cases) {
  const r = await resolveIntent(query);
  check(`「${query}」→ ${wantSkill}`, r?.skill === wantSkill, r?.skill ?? "null");
  check(`  ${label}`, r ? wantArgs(r.args) : false, JSON.stringify(r?.args));
}

const week = await resolveIntent("归档一周前的日志");
check("「一周前」解析成 7 天", week?.args.maxAgeDays === 7, String(week?.args.maxAgeDays));

const needPrefix = await resolveIntent("批量重命名");
check("缺前缀时明确要你补", needPrefix?.missing.includes("prefix") === true, JSON.stringify(needPrefix?.missing));
check("缺槽位时给出一句追问", Boolean(needPrefix?.question), needPrefix?.question ?? "");
check("缺槽位时置信度下降", (needPrefix?.confidence ?? 1) < 0.9, String(needPrefix?.confidence));

const needPaths = await resolveIntent("镜像一下");
check("镜像缺两个路径时都列为缺失", JSON.stringify(needPaths?.missing) === '["source","dest"]', JSON.stringify(needPaths?.missing));

for (const q of ["整理一下", "给我订一张明天去上海的机票"]) {
  const r = await resolveIntent(q);
  check(`「${q}」不瞎猜`, r === null, JSON.stringify(r));
}

const fixture = new FixtureBackend({
  自定义一句: { skill: "log-archive", args: { maxAgeDays: 90 }, confidence: 1, missing: [], reason: "fixture" },
});
const viaFixture = await resolveIntent("自定义一句", { backend: fixture });
check("FixtureBackend 能替换规则后端", viaFixture?.skill === "log-archive" && viaFixture?.args.maxAgeDays === 90);
const viaRules = await resolveIntent("自定义一句", { backend: new RuleBackend() });
check("同一句话在规则后端下不命中（证明后端真的换了）", viaRules === null);

// ---------- 2) 参数真的改变 plan ----------
const root = path.resolve(".demo/intent");
const skills = listShellSkills();
const logSkill = skills.find((s) => s.name === "log-archive")!;

function fixtureLogs(): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const now = Date.now();
  for (const [name, ageDays] of [
    ["old-60.log", 60],
    ["mid-20.log", 20],
    ["fresh-2.log", 2],
  ] as Array<[string, number]>) {
    const f = path.join(root, name);
    fs.writeFileSync(f, name);
    const t = new Date(now - ageDays * 24 * 3600 * 1000);
    fs.utimesSync(f, t, t);
  }
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (rel.startsWith(".deskshell")) continue;
      if (e.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(abs);
      } else out[rel] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 12);
    }
  };
  walk(dir);
  return out;
}

fixtureLogs();
const beforePreview = snapshot(root);
await preview(logSkill, { root, args: { maxAgeDays: 30 } });
check("预览本身不改文件", JSON.stringify(beforePreview) === JSON.stringify(snapshot(root)));

const strictPlan = await preview(logSkill, { root, args: { maxAgeDays: 30 } });
const loosePlan = await preview(logSkill, { root, args: { maxAgeDays: 90 } });
check(
  "参数真的改变了 plan（30 天 vs 90 天）",
  strictPlan.steps.length > loosePlan.steps.length,
  `30天=${strictPlan.steps.length} 步 / 90天=${loosePlan.steps.length} 步`,
);

const before = snapshot(root);
const applied = await apply(logSkill, { root, args: { maxAgeDays: 30 } });
const after = snapshot(root);
const movedOut = Object.keys(before).filter((k) => !(k in after));
check("执行后 60 天的日志被归档", movedOut.some((k) => k.includes("old-60.log")), movedOut.join(","));
check("2 天的日志没被动", fs.existsSync(path.join(root, "fresh-2.log")));
check("执行步数与预览步数一致", applied.steps === strictPlan.steps.length, `${applied.steps} vs ${strictPlan.steps.length}`);

// 撤销：逐字节回到执行前
const { undoTask } = await import("../packages/core/src/kernel.ts");
const { load } = await import("../packages/core/src/journal.ts");
const journal = path.join(root, ".deskshell", "journal.jsonl");
const taskId = load(journal).find((e) => e.status === "ok")?.taskId;
const undone = await undoTask(taskId!, { mode: "undo", root, granted: [], journalPath: journal }, {});
check("撤销后逐字节回到原状", JSON.stringify(snapshot(root)) === JSON.stringify(before) && undone.rolledBack === applied.steps);

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
