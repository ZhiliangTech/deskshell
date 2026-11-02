import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { UNLABELED, buildTimeline, parseSince } from "../packages/ledger/src/timeline.ts";
import type { Action, RunOptions, Skill } from "../packages/core/src/types.ts";

/**
 * 时间轴：账本按"对象"归组，回答"这个东西经历了什么"。
 * 它是"电脑有历史"这个主张的最小可见形态，所以测试盯的是：对象归组对不对、
 * 能不能撤回标得对不对、过滤与时间窗对不对。
 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-timeline-"));
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

function fixture(name: string): { root: string; opts: RunOptions } {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  return { root, opts: { mode: "apply", root, granted: ["fs.write"], journalPath: path.join(root, ".deskshell", "journal.jsonl") } };
}

function skill(actions: Action[]): Skill {
  return {
    manifest: {
      name: "timeline-probe",
      version: "0.0.0",
      description: "timeline regression",
      entry: "./index.ts",
      capabilities: [{ id: "fs.write", reason: "isolated test" }],
    },
    async plan() {
      return actions;
    },
  };
}

await check("按对象归组，并标出可否撤回", async () => {
  const { root, opts } = fixture("group");
  const probe = skill([
    { id: "w1", kind: "fs.write", path: path.join(root, "a.txt"), content: "1", undo: { kind: "fs.restore", path: path.join(root, "a.txt"), content: null } },
    { id: "w2", kind: "fs.write", path: path.join(root, "b.txt"), content: "2", undo: { kind: "fs.restore", path: path.join(root, "b.txt"), content: null } },
    { id: "m1", kind: "fs.move", from: path.join(root, "a.txt"), to: path.join(root, "sub", "a.txt"), undo: { kind: "fs.move", from: path.join(root, "sub", "a.txt"), to: path.join(root, "a.txt") } },
  ]);
  await run(probe, { root }, opts);
  const histories = buildTimeline(load(opts.journalPath));
  const objects = histories.map((h) => h.object).sort();
  assert.deepEqual(objects, ["a.txt", "b.txt", "sub/a.txt"], "对象应归组为相对路径");
  // 已知限制：对象身份暂时等于路径，改名/移动会断成两条历史。
  // 语义身份（同一对象跨路径）是 RFC 0003 里的待办原语，这里把限制写成断言而不是注释。
  assert.equal(histories.find((h) => h.object === "a.txt")!.items.length, 1, "移动前的历史留在旧路径下");
  const moved = histories.find((h) => h.object === "sub/a.txt")!;
  assert.equal(moved.items.length, 1);
  assert.equal(moved.items[0].revertible, true);
  assert.equal(moved.items[0].kind, "fs.move");
});

await check("撤回后同一条记录变成已撤回、不可再撤", async () => {
  const { root, opts } = fixture("rolled-back");
  const target = path.join(root, "x.txt");
  const probe = skill([
    { id: "w", kind: "fs.write", path: target, content: "v", undo: { kind: "fs.restore", path: target, content: null } },
  ]);
  const applied = await run(probe, { root }, opts);
  await undoTask(applied.taskId!, { mode: "undo", root, granted: [], journalPath: opts.journalPath });

  const [history] = buildTimeline(load(opts.journalPath));
  assert.equal(history.object, "x.txt");
  assert.equal(history.items[0].status, "rolled-back");
  assert.equal(history.items[0].revertible, false);
});

await check("失败的动作也进时间轴，且不可撤回", async () => {
  const { root, opts } = fixture("failed");
  const probe = skill([
    {
      id: "bad",
      kind: "fs.write",
      path: path.join(root, "never.txt"),
      content: "x",
      post: [{ kind: "path.exists", path: path.join(root, "nope.txt") }],
      undo: { kind: "fs.restore", path: path.join(root, "never.txt"), content: null },
    },
  ]);
  await run(probe, { root }, opts);
  const [history] = buildTimeline(load(opts.journalPath));
  assert.equal(history.object, "never.txt");
  assert.equal(history.items[0].status, "failed");
  assert.equal(history.items[0].revertible, false);
});

await check("按对象过滤与时间窗过滤", async () => {
  const { root, opts } = fixture("filter");
  const probe = skill([
    { id: "a", kind: "fs.write", path: path.join(root, "a.txt"), content: "1", undo: { kind: "fs.restore", path: path.join(root, "a.txt"), content: null } },
    { id: "b", kind: "fs.write", path: path.join(root, "b.txt"), content: "2", undo: { kind: "fs.restore", path: path.join(root, "b.txt"), content: null } },
  ]);
  await run(probe, { root }, opts);
  const entries = load(opts.journalPath);

  assert.equal(buildTimeline(entries, { object: "a.txt" }).length, 1);
  assert.equal(buildTimeline(entries, { object: "a.txt" })[0].items.length, 1);
  assert.equal(buildTimeline(entries, { sinceMs: Date.now() + 60_000 }).length, 0, "未来时间窗应为空");
  assert.equal(buildTimeline(entries, { sinceMs: Date.now() - 60_000 }).length, 2);
});

await check("旧日志（没有 object 字段）不会崩，归到未标注", async () => {
  const file = path.join(base, "legacy.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ts: Date.now(), taskId: "t", actionId: "a", kind: "fs.write", summary: "写 x", status: "ok" })}\n`,
    "utf8",
  );
  const histories = buildTimeline(load(file));
  assert.equal(histories.length, 1);
  assert.equal(histories[0].object, UNLABELED);
  assert.equal(histories[0].items[0].revertible, false, "没有 undo 的旧记录不能标成可撤回");
});

await check("parseSince 支持 30m / 24h / 7d 与毫秒", async () => {
  const now = 1_700_000_000_000;
  assert.equal(parseSince("30m", now), now - 30 * 60_000);
  assert.equal(parseSince("24h", now), now - 24 * 3_600_000);
  assert.equal(parseSince("7d", now), now - 7 * 86_400_000);
  assert.equal(parseSince("1000", now), now - 1000);
  assert.throws(() => parseSince("abc", now));
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`Timeline checks passed: ${passed}/${results.length}`);
fs.rmSync(base, { recursive: true, force: true });
