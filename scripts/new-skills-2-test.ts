import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 三个新 skill 的端到端测试：行为 + 撤销逐字节一致。
 * dedupe-folders / screenshot-organize / sync-mirror
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};
const base = path.resolve(".demo/new-skills-2");

function load_skill(slug: string): Promise<Skill> {
  return import(pathToFileURL(path.resolve(`packages/skills/${slug}/index.ts`)).href).then(
    (m) => (m as { skill: Skill }).skill,
  );
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (rel === ".deskshell" || rel.startsWith(".deskshell/")) continue;
      if (e.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(abs);
      } else if (e.isFile()) {
        out[rel] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
      }
    }
  };
  walk(root);
  return out;
}

async function applyAndUndo(
  skill: Skill,
  root: string,
  input: Record<string, unknown> = {},
  checkAfterApply?: (snap: Record<string, string>) => void,
) {
  const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
  const journal = path.join(root, ".deskshell", "journal.jsonl");
  const before = snapshot(root);
  const applied = await run(skill, { root, ...input }, { mode: "apply", root, granted, journalPath: journal }, {});
  const afterApply = snapshot(root);
  checkAfterApply?.(afterApply);
  const taskId = load(journal).find((e) => e.status === "ok")?.taskId;
  const undone = taskId
    ? await undoTask(taskId, { mode: "undo", root, granted, journalPath: journal }, {})
    : { rolledBack: 0 };
  const afterUndo = snapshot(root);
  return { applied, undone, before, afterApply, afterUndo };
}

// ---------- dedupe-folders ----------
{
  const root = path.join(base, "dedupe");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "one.txt"), "same content");
  fs.writeFileSync(path.join(root, "b", "one-copy.txt"), "same content");
  fs.writeFileSync(path.join(root, "b", "two-copy.txt"), "same content");
  fs.writeFileSync(path.join(root, "unique.txt"), "different");
  // 固定 mtime，让"保留最早的"可预期
  const t0 = new Date("2026-01-01T00:00:00Z").getTime();
  fs.utimesSync(path.join(root, "a", "one.txt"), t0 / 1000, t0 / 1000);
  fs.utimesSync(path.join(root, "b", "one-copy.txt"), (t0 + 1000) / 1000, (t0 + 1000) / 1000);
  fs.utimesSync(path.join(root, "b", "two-copy.txt"), (t0 + 2000) / 1000, (t0 + 2000) / 1000);

  const skill = await load_skill("dedupe-folders");
  let keptEarliest = false;
  const { applied, undone, afterApply, afterUndo, before } = await applyAndUndo(skill, root, {}, () => {
    keptEarliest =
      fs.existsSync(path.join(root, "a", "one.txt")) && !fs.existsSync(path.join(root, "b", "one-copy.txt"));
  });
  const trashed = Object.keys(afterApply).filter((k) => k.startsWith(".trash/") && k !== ".trash/");
  check("dedupe 只留一份、把 2 个副本挪走", trashed.length === 2 && applied.steps.length === 3, trashed.join(","));
  check("dedupe 保留最早的那份", keptEarliest);
  check("dedupe 不碰唯一文件", fs.existsSync(path.join(root, "unique.txt")));
  check(
    "dedupe 撤销后逐字节一致",
    undone.rolledBack === applied.steps.length && JSON.stringify(before) === JSON.stringify(afterUndo),
  );
}

// ---------- screenshot-organize ----------
{
  const root = path.join(base, "shots");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const made: Array<[string, string]> = [
    ["Screenshot 2026-03-04 at 10.11.12.png", "2026-03-04T10:11:12Z"],
    ["截图 2026-04-05 09.08.07.png", "2026-04-05T09:08:07Z"],
    ["notes.txt", "2026-04-05T09:08:07Z"],
  ];
  for (const [name, iso] of made) {
    const f = path.join(root, name);
    fs.writeFileSync(f, name);
    const d = new Date(iso);
    fs.utimesSync(f, d, d);
  }

  const skill = await load_skill("screenshot-organize");
  let dirs: string[] = [];
  let moved: string[] = [];
  const { applied, undone, afterApply, afterUndo, before } = await applyAndUndo(skill, root, {}, (snap) => {
    dirs = Object.keys(snap).filter((k) => /^\d{4}\/\d{2}\/$/.test(k)).sort();
    moved = Object.keys(snap).filter((k) => /^\d{4}\/\d{2}\/\d{8}-\d{4}-/.test(k));
  });
  check("截图归档到 YYYY/MM 两个目录", dirs.join(",") === "2026/03/,2026/04/", dirs.join(","));
  check("截图加上时间前缀", moved.length === 2, moved.join(","));
  check("非截图文件不动", fs.existsSync(path.join(root, "notes.txt")));
  check(
    "截图归档撤销后逐字节一致",
    undone.rolledBack === applied.steps.length && JSON.stringify(before) === JSON.stringify(afterUndo),
  );
}

// ---------- sync-mirror ----------
{
  const root = path.join(base, "mirror");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "src", "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "mirror", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.md"), "A");
  fs.writeFileSync(path.join(root, "src", "docs", "b.md"), "B");
  fs.writeFileSync(path.join(root, "mirror", "a.md"), "OLD");
  fs.writeFileSync(path.join(root, "mirror", "stale.md"), "remove me");
  fs.writeFileSync(path.join(root, "src", "bin.dat"), Buffer.from([0, 1, 2, 3]));

  const skill = await load_skill("sync-mirror");
  let wrote = false;
  let trashedExtras = false;
  const { applied, undone, afterApply, afterUndo, before } = await applyAndUndo(skill, root, {}, (snap) => {
    wrote =
      fs.readFileSync(path.join(root, "mirror", "a.md"), "utf8") === "A" &&
      fs.existsSync(path.join(root, "mirror", "docs", "b.md"));
    trashedExtras =
      !fs.existsSync(path.join(root, "mirror", "stale.md")) &&
      Object.keys(snap).some((k) => k.startsWith(".trash/") && k !== ".trash/");
  });
  check("镜像写入缺失/变更的文件", wrote);
  check("镜像把多余文件移进 .trash", trashedExtras);
  check("二进制文件被跳过（不做文本写入）", fs.existsSync(path.join(root, "src", "bin.dat")) && !fs.existsSync(path.join(root, "mirror", "bin.dat")));
  check(
    "镜像撤销后逐字节一致",
    undone.rolledBack === applied.steps.length && JSON.stringify(before) === JSON.stringify(afterUndo),
  );
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
