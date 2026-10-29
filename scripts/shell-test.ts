import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apply, cancel, listShellSkills, matchSkills, preview } from "../apps/shell/core.ts";

/**
 * 桌面壳的验收测试：
 *   1) 一句话能命中技能；歧义能给出多个候选；胡说八道要明说没有
 *   2) 取消 = 零副作用（文件系统与日志都不变）
 *   3) 执行 = 确有变化，且能撤销回原状
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const root = path.resolve(".demo/shell");
const journal = path.join(root, ".deskshell", "journal.jsonl");

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (rel === ".deskshell" || rel.startsWith(".deskshell/")) continue;
      if (e.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(abs);
      } else if (e.isFile()) {
        out[rel] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
      }
    }
  };
  walk(dir);
  return out;
}

function fixture(): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  fs.writeFileSync(path.join(root, "b.jpg"), "b");
  fs.writeFileSync(path.join(root, "c.jpg"), "c");
}

// ---------- 1) 一句话匹配 ----------
const skills = listShellSkills();
check("能列出公开技能", skills.length >= 10, `${skills.length} 个`);

const hit = matchSkills("清理下载文件夹");
check("中文一句话命中 downloads-cleanup", hit[0]?.skill.name === "downloads-cleanup", hit[0]?.skill.name ?? "无");

const hitByName = matchSkills("photo-sort");
check("直接输名字命中", hitByName[0]?.skill.name === "photo-sort" && hitByName[0].score >= 100);

const ambiguous = matchSkills("整理文件");
check("模糊句子给出多个候选", ambiguous.length >= 2, ambiguous.slice(0, 3).map((m) => m.skill.name).join(","));

const miss = matchSkills("给我订一张明天去上海的机票");
check("完全不相关的句子不瞎猜", miss.length === 0 || miss[0].score < 20, `最高分 ${miss[0]?.score ?? 0}`);

// ---------- 2) 取消 = 零副作用 ----------
{
  fixture();
  const before = snapshot(root);
  const candidates = matchSkills("整理下载", skills);
  const target = candidates[0].skill;
  const p = await preview(target, { root });
  check("预览给出能力申请单", p.capabilities.length >= 1, JSON.stringify(p.capabilities.map((c) => c.id)));
  check("预览给出步骤", p.steps.length > 0, `${p.steps.length} 步`);

  const cancelled = cancel();
  const after = snapshot(root);
  check("取消返回明确信号", cancelled.cancelled === true);
  check("取消后文件系统零变化", JSON.stringify(before) === JSON.stringify(after));
  check("取消后没有产生日志", !fs.existsSync(journal));
}

// ---------- 3) 执行 ----------
{
  fixture();
  const target = matchSkills("清理下载", skills)[0].skill;
  const before = snapshot(root);
  await preview(target, { root });
  check("预览不写日志", !fs.existsSync(journal));

  const result = await apply(target, { root });
  const after = snapshot(root);
  check("执行后确有变化", JSON.stringify(before) !== JSON.stringify(after), `${result.steps} 步`);
  check("执行后写入日志", fs.existsSync(journal));

  // 撤销回原状
  const { run, undoTask } = (await import("../packages/core/src/kernel.ts")) as typeof import("../packages/core/src/kernel.ts");
  const { load } = (await import("../packages/core/src/journal.ts")) as typeof import("../packages/core/src/journal.ts");
  const taskId = load(journal).find((e) => e.status === "ok")?.taskId;
  const undone = await undoTask(taskId!, { mode: "undo", root, granted: [], journalPath: journal }, {});
  const restored = snapshot(root);
  check("撤销后回到原状", undone.rolledBack === result.steps && JSON.stringify(before) === JSON.stringify(restored));
  void run;
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
