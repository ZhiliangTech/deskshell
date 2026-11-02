import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyError, run, undoTask } from "../packages/core/src/kernel.ts";
import { append, load, markRolledBack } from "../packages/core/src/journal.ts";
import type { Action, CapabilityId, RunOptions, Skill } from "../packages/core/src/types.ts";

/**
 * 撤销诚实度回归：这一组专门盯"撤不掉却报告撤掉了"的路径。
 *
 * 每个用例都对应一个真实踩过的洞：
 *   1. fs.delete + noop 占位绕过"硬删必须可还原"的闸；
 *   2. fs.move + noop 被算成可撤销；
 *   3. 撤销时目标位已被别人占用，却被无条件删掉；
 *   4. delete 的撤销不看内容指纹，同名新文件被静默覆盖；
 *   5. 同批计划里前一步改变目录拓扑，后一步越出 task root；
 *   6. 日志里出现半行 JSON，整份账本不可读、原始错误被顶掉；
 *   7. 自定义日志名的轮转文件读不回来；
 *   8. 嵌套 mkdir 撤销后留下空壳父目录。
 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-undo-honesty-"));
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

function fixture(name: string, journalName = `${name}.jsonl`): { root: string; opts: RunOptions } {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  const journalPath = path.join(base, journalName);
  fs.rmSync(journalPath, { force: true });
  return { root, opts: { mode: "apply", root, granted: ["fs.write"], journalPath } };
}

function skill(actions: Action[], capabilities: CapabilityId[] = ["fs.write"]): Skill {
  return {
    manifest: {
      name: "undo-honesty-probe",
      version: "0.0.0",
      description: "undo honesty regression",
      entry: "./index.ts",
      capabilities: capabilities.map((id) => ({ id, reason: "isolated test" })),
    },
    async plan() {
      return actions;
    },
  };
}

// 1) 硬删 + noop：策略层直接拒绝，文件一个字节都不动
await check("fs.delete 的 noop 占位被拒绝", async () => {
  const { root, opts } = fixture("delete-noop");
  const target = path.join(root, "keep.txt");
  fs.writeFileSync(target, "keep");
  const probe = skill([{ id: "del", kind: "fs.delete", path: target, undo: { kind: "noop" } }]);
  await assert.rejects(run(probe, { root }, opts), (err: unknown) => {
    assert.ok(err instanceof PolicyError);
    assert.match(err.message, /不可撤销的删除被拒绝/);
    return true;
  });
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

// 2) move + noop：算不可逆，没有确认就整单拒绝；确认后执行，日志里不留假 undo
await check("fs.move 的 noop 占位算不可逆", async () => {
  const { root, opts } = fixture("move-noop");
  const from = path.join(root, "a.txt");
  const to = path.join(root, "b.txt");
  fs.writeFileSync(from, "v1");
  const probe = skill([{ id: "mv", kind: "fs.move", from, to, undo: { kind: "noop" } }]);

  const preview = await run(probe, { root }, { ...opts, mode: "preview" });
  assert.equal(preview.summary?.undoable, 0);
  assert.equal(preview.summary?.irreversible, 1);

  await assert.rejects(run(probe, { root }, opts), /不可逆/);
  assert.equal(fs.existsSync(from), true, "被拒绝时不能搬走文件");

  const applied = await run(probe, { root }, { ...opts, allowIrreversible: true });
  assert.equal(applied.steps[0].status, "ok");
  assert.equal(load(opts.journalPath)[0].undo, undefined, "noop 不能作为撤销动作写进日志");

  const undone = await undoTask(applied.taskId!, { ...opts, mode: "undo" });
  assert.equal(undone.rolledBack, 0);
  assert.equal(undone.steps[0].status, "failed");
  assert.equal(fs.existsSync(to), true, "没有真 undo 时文件应留在原地");
});

// 3) move 的撤销：目标位已经有别人新建的文件，不能静默删掉
await check("move 撤销不覆盖别人新建的同名文件", async () => {
  const { root, opts } = fixture("move-conflict");
  const from = path.join(root, "a.txt");
  const to = path.join(root, "b.txt");
  fs.writeFileSync(from, "v1");
  const probe = skill([
    { id: "mv", kind: "fs.move", from, to, undo: { kind: "fs.move", from: to, to: from } },
  ]);
  const applied = await run(probe, { root }, opts);
  assert.equal(applied.steps[0].status, "ok");

  fs.writeFileSync(from, "someone-else"); // 用户又建了一个同名文件
  const undone = await undoTask(applied.taskId!, { ...opts, mode: "undo" });
  assert.equal(undone.rolledBack, 0);
  assert.equal(undone.steps[0].status, "failed");
  assert.match(undone.steps[0].detail ?? "", /拒绝覆盖/);
  assert.equal(fs.readFileSync(from, "utf8"), "someone-else", "别人的内容必须原样保留");
  assert.equal(load(opts.journalPath)[0].status, "ok", "撤销失败不能标成 rolled-back");
});

// 4) delete 的撤销：同名位置被写成别的内容时拒绝覆盖
await check("delete 撤销不覆盖他人重建的内容", async () => {
  const { root, opts } = fixture("delete-conflict");
  const target = path.join(root, "gone.txt");
  fs.writeFileSync(target, "original");
  const probe = skill([
    {
      id: "del",
      kind: "fs.delete",
      path: target,
      undo: { kind: "fs.restore", path: target, content: "original" },
    },
  ]);
  const applied = await run(probe, { root }, opts);
  assert.equal(applied.steps[0].status, "ok");
  assert.equal(fs.existsSync(target), false);

  fs.writeFileSync(target, "recreated-by-user");
  const undone = await undoTask(applied.taskId!, { ...opts, mode: "undo" });
  assert.equal(undone.rolledBack, 0);
  assert.equal(undone.steps[0].status, "failed");
  assert.equal(fs.readFileSync(target, "utf8"), "recreated-by-user");
});

// 5) 同批两步越界：第一步把 junction 挪走，第二步往它的位置写
await check("同批计划内改变拓扑后仍然逐动作复查路径", async () => {
  const { root, opts } = fixture("topology");
  const outside = path.join(base, "topology-outside");
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(root, "j");
  fs.symlinkSync(outside, link, "junction");

  const probe = skill([
    {
      id: "mv",
      kind: "fs.move",
      from: link,
      to: path.join(root, "k"),
      undo: { kind: "fs.move", from: path.join(root, "k"), to: link },
    },
    {
      id: "write",
      kind: "fs.write",
      path: path.join(root, "k", "escaped.txt"),
      content: "pwn",
      undo: { kind: "fs.restore", path: path.join(root, "k", "escaped.txt"), content: null },
    },
  ]);

  // 批次开头看不出问题（那时 root/k 还不存在），只能在动作执行前发现。
  // 发现之后按失败处理：这一步标 failed，前面已完成的动作回滚，绝不写到 root 外面。
  const report = await run(probe, { root }, { ...opts, allowIrreversible: true });
  const failed = report.steps.find((s) => s.actionId === "write");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.detail ?? "", /符号链接逃逸|路径越界/);
  assert.equal(fs.existsSync(path.join(outside, "escaped.txt")), false, "不能写到 root 之外");
  assert.equal(report.rolledBack, 1, "前面那一步要被回滚");
  assert.equal(fs.existsSync(link), true, "junction 应当被还原");
});

// 6) 账本里出现半行：好行照常可读，坏行不连累撤销，也不被重写抹掉
await check("日志坏行不影响撤销，也不会被回写抹掉", async () => {
  const { root, opts } = fixture("journal-corrupt");
  const target = path.join(root, "x.txt");
  const probe = skill([
    { id: "w", kind: "fs.write", path: target, content: "hello", undo: { kind: "fs.restore", path: target, content: null } },
  ]);
  const applied = await run(probe, { root }, opts);
  assert.equal(applied.steps[0].status, "ok");

  fs.appendFileSync(opts.journalPath, '{"ts":1,"taskId":"broken"', "utf8"); // 半行
  assert.equal(load(opts.journalPath).length, 1, "坏行应被跳过，好行仍然读得到");

  const undone = await undoTask(applied.taskId!, { ...opts, mode: "undo" });
  assert.equal(undone.rolledBack, 1);
  assert.equal(fs.existsSync(target), false);
  assert.match(fs.readFileSync(opts.journalPath, "utf8"), /"taskId":"broken"/, "坏行原样保留，便于排查");
});

// 7) 自定义日志名的轮转文件必须能被读回来
await check("自定义日志名的轮转历史可读", async () => {
  const { root } = fixture("rotate");
  const journalPath = path.join(base, "rotate-audit.jsonl");
  fs.rmSync(journalPath, { force: true });
  const previous = process.env.DESKSHELL_JOURNAL_MAX_BYTES;
  process.env.DESKSHELL_JOURNAL_MAX_BYTES = "200";
  try {
    for (let i = 0; i < 6; i++) {
      append(journalPath, {
        ts: Date.now() + i,
        taskId: "rotate-task",
        actionId: `a${i}`,
        kind: "fs.write",
        summary: `写 ${i}`,
        status: "ok",
      });
    }
    const rotated = fs.readdirSync(base).filter((f) => f.startsWith("rotate-audit-") && f.endsWith(".jsonl"));
    assert.ok(rotated.length > 0, "应当发生轮转");
    assert.equal(load(journalPath).length, 6, "轮转前的记录也要读得到");
  } finally {
    if (previous === undefined) delete process.env.DESKSHELL_JOURNAL_MAX_BYTES;
    else process.env.DESKSHELL_JOURNAL_MAX_BYTES = previous;
  }
  assert.equal(fs.existsSync(root), true);
});

// 8) 嵌套 mkdir：撤销后不留空壳父目录
await check("嵌套 mkdir 撤销后不留空目录", async () => {
  const { root, opts } = fixture("nested-mkdir");
  const deep = path.join(root, "a", "b", "c");
  const probe = skill([{ id: "mk", kind: "fs.mkdir", path: deep, undo: { kind: "fs.rmdir", path: deep } }]);
  const applied = await run(probe, { root }, opts);
  assert.equal(applied.steps[0].status, "ok");
  assert.equal(fs.existsSync(deep), true);

  const undone = await undoTask(applied.taskId!, { ...opts, mode: "undo" });
  assert.equal(undone.rolledBack, 1);
  assert.equal(fs.existsSync(path.join(root, "a")), false, "顺带建的父目录也要清掉");
});

// 9) markRolledBack 只改状态，不搬走坏行
await check("markRolledBack 保留坏行", async () => {
  const { opts } = fixture("mark-rolled-back");
  append(opts.journalPath, {
    ts: 1,
    taskId: "t1",
    actionId: "a1",
    kind: "fs.write",
    summary: "写",
    status: "ok",
  });
  fs.appendFileSync(opts.journalPath, "not-json-at-all\n", "utf8");
  const entries = load(opts.journalPath);
  assert.equal(entries.length, 1);
  markRolledBack(opts.journalPath, entries.map((e) => ({ ...e, status: "rolled-back" as const })));
  const raw = fs.readFileSync(opts.journalPath, "utf8");
  assert.match(raw, /not-json-at-all/);
  assert.match(raw, /"status":"rolled-back"/);
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`Undo honesty checks passed: ${passed}/${results.length}`);
fs.rmSync(base, { recursive: true, force: true });
