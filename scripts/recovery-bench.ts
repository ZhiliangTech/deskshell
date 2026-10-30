import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import type { Action, CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * R0 = recovery rate at zero residue（失败后副作用归零率）
 *
 * 别的 computer-use 项目比"成功率"；这里比"失败之后留下了什么"。
 * 做法：给同一组任务，在第 k 步注入必然失败的断言，跑完整套，
 * 然后逐字节比对目录。三类指标：
 *
 *   R0-残渣    失败后目录是否与执行前逐字节一致
 *   R0-回滚    失败前已完成的步骤是否全部被撤销
 *   R0-可追溯  日志里每一步是否都带 taskId / actionId / 时间戳 / 状态
 *
 * 用法：
 *   node scripts/recovery-bench.ts            # 人看的表
 *   node scripts/recovery-bench.ts --json     # 机器读
 */

const here = path.resolve(".demo/recovery-bench");

interface Scenario {
  name: string;
  fixture: (root: string) => void;
  plan: (root: string) => Action[];
  capabilities: CapabilityId[];
}

const scenarioList: Scenario[] = [
  {
    name: "nested-writes",
    fixture: () => undefined,
    capabilities: ["fs.write", "fs.read"],
    plan: (root) => [
      {
        id: "mkdir:a",
        kind: "fs.mkdir",
        path: path.join(root, "a"),
        post: [{ kind: "path.exists", path: path.join(root, "a") }],
        undo: { kind: "fs.rmdir", path: path.join(root, "a") },
      },
      {
        id: "write:a/1",
        kind: "fs.write",
        path: path.join(root, "a", "1.txt"),
        content: "1",
        post: [{ kind: "path.exists", path: path.join(root, "a", "1.txt") }],
        undo: { kind: "fs.restore", path: path.join(root, "a", "1.txt"), content: null },
      },
      {
        id: "write:a/2",
        kind: "fs.write",
        path: path.join(root, "a", "2.txt"),
        content: "2",
        post: [{ kind: "path.exists", path: path.join(root, "a", "2.txt") }],
        undo: { kind: "fs.restore", path: path.join(root, "a", "2.txt"), content: null },
      },
    ],
  },
  {
    name: "move-and-overwrite",
    fixture: (root) => {
      fs.writeFileSync(path.join(root, "old.txt"), "OLD");
      fs.mkdirSync(path.join(root, "bucket"), { recursive: true });
    },
    capabilities: ["fs.write", "fs.read"],
    plan: (root) => [
      {
        id: "write:old.txt",
        kind: "fs.write",
        path: path.join(root, "old.txt"),
        content: "NEW",
        post: [{ kind: "path.exists", path: path.join(root, "old.txt") }],
        undo: { kind: "fs.restore", path: path.join(root, "old.txt"), content: "OLD" },
      },
      {
        id: "move:old->bucket",
        kind: "fs.move",
        from: path.join(root, "old.txt"),
        to: path.join(root, "bucket", "old.txt"),
        post: [{ kind: "path.exists", path: path.join(root, "bucket", "old.txt") }],
        undo: { kind: "fs.move", from: path.join(root, "bucket", "old.txt"), to: path.join(root, "old.txt") },
      },
      {
        id: "write:new.txt",
        kind: "fs.write",
        path: path.join(root, "new.txt"),
        content: "NEWFILE",
        post: [{ kind: "path.exists", path: path.join(root, "new.txt") }],
        undo: { kind: "fs.restore", path: path.join(root, "new.txt"), content: null },
      },
    ],
  },
  {
    name: "folder-taxonomy",
    fixture: (root) => {
      for (const f of ["a.jpg", "b.jpg", "c.zip", "d.txt"]) fs.writeFileSync(path.join(root, f), f);
    },
    capabilities: ["fs.write", "fs.read"],
    plan: (root) => {
      const actions: Action[] = [];
      const groups: Record<string, string[]> = { 图片: ["a.jpg", "b.jpg"], 压缩包: ["c.zip"], 文档: ["d.txt"] };
      for (const [dir, files] of Object.entries(groups)) {
        actions.push({
          id: `mkdir:${dir}`,
          kind: "fs.mkdir",
          path: path.join(root, dir),
          post: [{ kind: "path.exists", path: path.join(root, dir) }],
          undo: { kind: "fs.rmdir", path: path.join(root, dir) },
        });
        for (const f of files) {
          actions.push({
            id: `move:${f}`,
            kind: "fs.move",
            from: path.join(root, f),
            to: path.join(root, dir, f),
            post: [{ kind: "path.exists", path: path.join(root, dir, f) }],
            undo: { kind: "fs.move", from: path.join(root, dir, f), to: path.join(root, f) },
          });
        }
      }
      return actions;
    },
  },
];

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
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

const same = (a: Record<string, string>, b: Record<string, string>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function freshRoot(name: string, fixture: (root: string) => void): string {
  const root = path.join(here, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fixture(root);
  return root;
}

/** 把第 k 步的 post 换成必然失败的断言 */
function inject(actions: Action[], k: number, root: string): Action[] {
  return actions.map((a, i) =>
    i + 1 === k
      ? { ...a, post: [{ kind: "path.exists", path: path.join(root, `__never_${k}__.marker`) }] }
      : a,
  );
}

function makeSkill(sc: Scenario, root: string, failAt?: number): Skill {
  return {
    manifest: {
      name: `bench-${sc.name}`,
      version: "0.0.0",
      description: "恢复力基准用的合成任务",
      entry: "./index.ts",
      capabilities: sc.capabilities.map((id) => ({ id, scope: "{{root}}", reason: "bench" })),
    },
    async plan() {
      const actions = sc.plan(root);
      return failAt ? inject(actions, failAt, root) : actions;
    },
  };
}

interface Row {
  scenario: string;
  steps: number;
  failAt: number;
  residue: boolean;
  rolledBack: number;
  completed: number;
  traceable: boolean;
}

const rows: Row[] = [];
const happy: Array<{ scenario: string; steps: number; byteIdentical: boolean }> = [];

for (const sc of scenarioList) {
  // ① 正常路径 + 撤销：逐字节还原
  const rootOk = freshRoot(sc.name, sc.fixture);
  const beforeOk = snapshot(rootOk);
  const journalOk = path.join(rootOk, ".deskshell", "journal.jsonl");
  const skillOk = makeSkill(sc, rootOk);
  const applied = await run(
    skillOk,
    { root: rootOk },
    { mode: "apply", root: rootOk, granted: sc.capabilities, journalPath: journalOk },
    {},
  );
  const taskId = load(journalOk).find((e) => e.status === "ok")?.taskId;
  if (taskId) await undoTask(taskId, { mode: "undo", root: rootOk, granted: [], journalPath: journalOk }, {});
  happy.push({
    scenario: sc.name,
    steps: applied.steps.length,
    byteIdentical: same(beforeOk, snapshot(rootOk)),
  });

  // ② 逐步注入失败
  const total = sc.plan(freshRoot(`${sc.name}-probe`, sc.fixture)).length;
  for (let k = 1; k <= total; k++) {
    const root = freshRoot(`${sc.name}-f${k}`, sc.fixture);
    const before = snapshot(root);
    const journal = path.join(root, ".deskshell", "journal.jsonl");
    const report = await run(
      makeSkill(sc, root, k),
      { root },
      { mode: "apply", root, granted: sc.capabilities, journalPath: journal },
      {},
    );

    const after = snapshot(root);
    // 从日志文件按 taskId 取账：失败项写在文件里，但不在 report.journal（那个只装成功的）
    const entries = load(journal).filter((e) => e.taskId === report.taskId);
    const rolledBack = entries.filter((e) => e.status === "rolled-back").length;
    // 失败前"已经动过手"的步数 = 本次尝试的步数 - 1（最后一步是失败那步）
    const executed = Math.max(0, report.steps.length - 1);
    const traceable =
      entries.length > 0 &&
      entries.every((e) => Boolean(e.taskId) && Boolean(e.actionId) && Number.isFinite(e.ts));

    rows.push({
      scenario: sc.name,
      steps: total,
      failAt: k,
      residue: same(before, after),
      rolledBack,
      completed: executed,
      traceable,
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const r0Residue = rows.filter((r) => r.residue).length / rows.length;
const r0Rollback = rows.filter((r) => r.rolledBack >= r.completed).length / rows.length;
const r0Trace = rows.filter((r) => r.traceable).length / rows.length;
const happyOk = happy.filter((h) => h.byteIdentical).length;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        r0: { residue: r0Residue, rollback: r0Rollback, traceable: r0Trace },
        runs: rows.length,
        happyPath: { total: happy.length, byteIdentical: happyOk },
        detail: rows,
      },
      null,
      2,
    ),
  );
} else {
  console.log("R0 — 失败后副作用归零率\n");
  console.log("| 场景 | 计划步数 | 失败注入点 | 残渣归零 | 已撤销/已执行 | 可追溯 |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(
      `| ${r.scenario} | ${r.steps} | ${r.failAt} | ${r.residue ? "✅" : "❌"} | ${r.rolledBack}/${r.completed} | ${r.traceable ? "✅" : "❌"} |`,
    );
  }
  console.log("");
  console.log(`R0-残渣     ${pct(r0Residue)}  （${rows.length} 次失败注入）`);
  console.log(`R0-回滚     ${pct(r0Rollback)}`);
  console.log(`R0-可追溯   ${pct(r0Trace)}`);
  console.log(`正常路径撤销后逐字节还原：${happyOk}/${happy.length}`);
  console.log("");
  console.log("复现： node scripts/recovery-bench.ts");
}

fs.rmSync(here, { recursive: true, force: true });
if (r0Residue < 1 || r0Rollback < 1 || r0Trace < 1 || happyOk !== happy.length) process.exitCode = 1;
