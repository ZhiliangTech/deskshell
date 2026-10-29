import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 撤销护栏：
 *   1) 任务写过的文件被外部改过 → 拒绝覆盖，日志不能标成 rolled-back；
 *   2) 文件没被动过 → 正常撤销。
 */
const base = path.resolve(".demo/undo-guard");
const checks: string[] = [];
const check = (name: string, ok: boolean): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

const skill: Skill = {
  manifest: {
    name: "undo-guard-probe",
    version: "0.0.0",
    description: "probe",
    entry: "./index.ts",
    capabilities: [{ id: "fs.write", scope: "{{root}}", reason: "probe" }],
  },
  async plan({ root }) {
    const file = path.join(root, "note.txt");
    return [
      {
        id: "write",
        kind: "fs.write",
        path: file,
        content: "v1",
        post: [{ kind: "path.exists", path: file }],
        undo: { kind: "fs.restore", path: file, content: null },
      },
    ];
  },
};

function fresh(): { root: string; journal: string; granted: CapabilityId[] } {
  const root = path.join(base, `run-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return { root, journal: path.join(root, ".deskshell", "journal.jsonl"), granted: ["fs.write"] };
}

const mod = { manifest: undefined };

// 1) 外部改动后被拒绝
{
  const { root, journal, granted } = fresh();
  const profile = (await import(pathToFileURL(path.resolve("packages/skills/photo-sort/index.ts")).href)) as unknown;
  void profile; // 仅确保动态导入可用（不同模块实例不影响本测试）
  const r = await run(skill, { root }, { mode: "apply", root, granted, journalPath: journal }, {});
  const file = path.join(root, "note.txt");
  fs.writeFileSync(file, "改过了");
  const taskId = load(journal)[0].taskId;
  const undone = await undoTask(taskId, { mode: "undo", root, granted, journalPath: journal }, {});
  const stillThere = fs.existsSync(file) && fs.readFileSync(file, "utf8") === "改过了";
  const refused = undone.steps.some((s) => s.status === "failed" && /拒绝覆盖/.test(s.detail ?? ""));
  const journalHonest = load(journal).every((e) => e.status !== "rolled-back");
  check("文件被外部修改后拒绝覆盖", r.steps.length === 1 && refused && stillThere);
  check("拒绝覆盖时日志不谎报 rolled-back", journalHonest);
}

// 2) 未改动时正常撤销
{
  const { root, journal, granted } = fresh();
  await run(skill, { root }, { mode: "apply", root, granted, journalPath: journal }, {});
  const file = path.join(root, "note.txt");
  const taskId = load(journal)[0].taskId;
  const undone = await undoTask(taskId, { mode: "undo", root, granted, journalPath: journal }, {});
  check("未改动时正常删除并标记 rolled-back", !fs.existsSync(file) && undone.rolledBack === 1);
}

void mod;
console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
