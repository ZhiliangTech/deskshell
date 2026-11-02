import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyError, run, runActions, undoTask } from "../packages/core/src/kernel.ts";
import { append, load } from "../packages/core/src/journal.ts";
import type { Action, CapabilityId, RunOptions, Skill } from "../packages/core/src/types.ts";

/**
 * 撤销完整性回归：这一组盯的是"动作被允许了，但它的撤销动作能跑到 root 外面去"。
 *
 * 每个用例都对应一次独立审计里实测复现过的洞：
 *   1. undo 里的 path/from/to 从来不过 root 检查 —— 写/搬/删都能落到 root 外；
 *   2. 不可逆闸门只认字面量 "noop"，{kind:"NoOp"}、{}、fs.restore+null、fs.rmdir 全部绕过；
 *   3. isInside 的 rel === "" 让 fs.delete <root> 合法，一次 rmSync 清掉整个任务根；
 *   4. 硬链接不是 reparse point，写动作直接改掉 root 外同一 inode；
 *   5. journal 把同目录里名字匹配的目录也当历史读，一次 mkdir 就让 load() 抛 EISDIR；
 *   6. checkAction 与 execute 之间还有一次 await 钩子，钩子里换 junction 就写出 root；
 *   7. 失败动作的自撤对 fs.delete 永远不触发（文件删完就不存在了，守卫直接跳过）。
 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-undo-integrity-"));
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

function fixture(name: string): { root: string; journalPath: string; opts: RunOptions } {
  const dir = path.join(base, name);
  const root = path.join(dir, "root");
  fs.mkdirSync(root, { recursive: true });
  const journalPath = path.join(dir, "journal.jsonl");
  return { root, journalPath, opts: { mode: "apply", root, granted: ["fs.write"], journalPath } };
}

function skill(actions: Action[], capabilities: CapabilityId[] = ["fs.write"]): Skill {
  return {
    manifest: {
      name: "undo-integrity-probe",
      version: "0.0.0",
      description: "undo integrity regression",
      entry: "./index.ts",
      capabilities: capabilities.map((id) => ({ id, reason: "isolated test" })),
    },
    async plan() {
      return actions;
    },
  };
}

const policyRejects = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof PolicyError, `期望 PolicyError，实际 ${String(err)}`);
  assert.match(err.message, pattern);
  return true;
};

// 1) undo 的路径必须和动作路径受同一套约束：写
await check("write 的 undo 指向 root 外被拒绝", async () => {
  const { root, opts } = fixture("undo-write");
  const outside = path.join(path.dirname(root), "outside-planted.txt");
  const inside = path.join(root, "a.txt");
  const probe = skill([
    { id: "w", kind: "fs.write", path: inside, content: "x", undo: { kind: "fs.restore", path: outside, content: null } },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/撤销|越界/));
  assert.equal(fs.existsSync(outside), false, "root 外不应出现文件");
  assert.equal(fs.existsSync(inside), false, "被拒的计划不应写盘");
});

// 2) undo 的路径必须和动作路径受同一套约束：移动
await check("move 的 undo 指向 root 外被拒绝", async () => {
  const { root, opts } = fixture("undo-move");
  const src = path.join(root, "a.txt");
  const dst = path.join(root, "b.txt");
  const outside = path.join(path.dirname(root), "exfil.txt");
  fs.writeFileSync(src, "secret");
  const probe = skill([
    { id: "mv", kind: "fs.move", from: src, to: dst, undo: { kind: "fs.move", from: dst, to: outside } },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/撤销|越界/));
  assert.equal(fs.existsSync(outside), false, "root 外不应出现被搬走的文件");
  assert.equal(fs.readFileSync(src, "utf8"), "secret");
});

// 3) undo 的路径必须和动作路径受同一套约束：建目录
await check("mkdir 的 undo 删 root 外目录被拒绝", async () => {
  const { root, opts } = fixture("undo-mkdir");
  const outsideDir = path.join(path.dirname(root), "victim-dir");
  fs.mkdirSync(outsideDir, { recursive: true });
  const inside = path.join(root, "new-dir");
  const probe = skill([
    { id: "d", kind: "fs.mkdir", path: inside, undo: { kind: "fs.rmdir", path: outsideDir } },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/撤销|越界/));
  assert.equal(fs.existsSync(outsideDir), true, "root 外目录不应被删");
});

// 4) 不可逆闸门认白名单，不认字面量
await check("未知 undo kind 的删除按不可逆拒绝", async () => {
  const { root, opts } = fixture("undo-kind");
  const target = path.join(root, "keep.txt");
  fs.writeFileSync(target, "keep");
  for (const undo of [{ kind: "NoOp" }, { kind: "bogus" }, {}, { kind: "noop " }] as unknown as Action["undo"][]) {
    const probe = skill([{ id: "del", kind: "fs.delete", path: target, undo }]);
    await assert.rejects(run(probe, { root }, opts), policyRejects(/不可撤销/), `undo=${JSON.stringify(undo)} 应被拒`);
    assert.equal(fs.readFileSync(target, "utf8"), "keep");
  }
});

// 5) 撤销动作"看起来有、实际还原不了"也算不可逆
await check("delete + fs.restore content:null 按不可逆拒绝", async () => {
  const { root, opts } = fixture("undo-null");
  const target = path.join(root, "keep.txt");
  fs.writeFileSync(target, "keep");
  const probe = skill([
    { id: "del", kind: "fs.delete", path: target, undo: { kind: "fs.restore", path: target, content: null } },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/不可撤销/));
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

// 6) 整棵目录树的删除：fs.rmdir 还原不了内容
await check("delete + fs.rmdir 按不可逆拒绝", async () => {
  const { root, opts } = fixture("undo-rmdir");
  const target = path.join(root, "keep.txt");
  fs.writeFileSync(target, "keep");
  const probe = skill([{ id: "del", kind: "fs.delete", path: target, undo: { kind: "fs.rmdir", path: target } }]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/不可撤销/));
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});

// 7) 任务根本身不是可操作对象
await check("fs.delete root 被拒绝", async () => {
  const { root, opts } = fixture("root-delete");
  const keep = path.join(root, "keep.txt");
  fs.writeFileSync(keep, "keep");
  const probe = skill([
    { id: "del", kind: "fs.delete", path: root, undo: { kind: "fs.restore", path: root, content: "keep" } },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/任务根/));
  assert.equal(fs.existsSync(keep), true);
});

// 8) 硬链接不是 reparse point：写它等于改 root 外那个文件
await check("写入硬链接穿透被拒绝", async () => {
  const { root, opts } = fixture("hardlink");
  const outside = path.join(path.dirname(root), "outside-target.txt");
  fs.writeFileSync(outside, "ORIGINAL");
  const link = path.join(root, "link.txt");
  fs.linkSync(outside, link);
  const probe = skill([
    { id: "w", kind: "fs.write", path: link, content: "PWNED", undo: { kind: "fs.restore", path: link, content: "ORIGINAL" } },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/硬链接|越界/));
  assert.equal(fs.readFileSync(outside, "utf8"), "ORIGINAL");
});

// 9) 未知动作 kind 不许静默"成功"
await check("未知动作 kind 被拒绝", async () => {
  const { root, opts } = fixture("unknown-kind");
  const probe = skill([{ id: "x", kind: "process.exec", cmd: "whoami" } as unknown as Action]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/未知|不支持/));
});

// 10) 断言路径同样是文件系统探针，必须落在 root 内
await check("root 外的断言路径被拒绝", async () => {
  const { root, opts } = fixture("assert-outside");
  const outside = path.join(path.dirname(root), "outside-target.txt");
  fs.writeFileSync(outside, "ORIGINAL");
  const inside = path.join(root, "a.txt");
  const probe = skill([
    {
      id: "w", kind: "fs.write", path: inside, content: "x",
      pre: [{ kind: "path.exists", path: outside }],
      undo: { kind: "fs.restore", path: inside, content: null },
    },
  ]);
  await assert.rejects(run(probe, { root }, opts), policyRejects(/断言|越界/));
  assert.equal(fs.existsSync(inside), false);
});

// 11) journal 目录里名字匹配的普通目录不能让账本不可读
await check("journal 同目录的非文件条目被忽略", async () => {
  const { root, journalPath } = fixture("journal-dir");
  append(journalPath, {
    ts: Date.now(), taskId: "t1", skill: "s", actionId: "a1", kind: "fs.write",
    summary: "write a.txt", status: "ok",
  });
  fs.mkdirSync(path.join(path.dirname(journalPath), "journal-decoy.jsonl"), { recursive: true });
  const entries = load(journalPath);
  assert.equal(entries.length, 1);
  assert.equal(path.resolve(root).length > 0, true);
});

// 12) 伪造的轮转文件里的 undo 也不能越界
await check("伪造 journal 条目的 undo 越界被拒", async () => {
  const { root, journalPath } = fixture("journal-forge");
  const outside = path.join(path.dirname(root), "forged-planted.txt");
  const inside = path.join(root, "a.txt");
  fs.writeFileSync(path.join(path.dirname(journalPath), "journal-2020-01-01T00-00-00.jsonl"),
    `${JSON.stringify({
      ts: Date.now(), taskId: "forged-task", skill: "s", actionId: "f1", kind: "fs.write",
      summary: "write", status: "ok",
      undo: { kind: "fs.restore", path: outside, content: "OWNED" },
    })}\n`, "utf8");
  const report = await undoTask("forged-task", { root, granted: ["fs.write"], journalPath } as RunOptions);
  assert.equal(report.steps[0]?.status, "failed");
  assert.equal(fs.existsSync(outside), false, "root 外不应被伪造条目写出");
  assert.equal(fs.existsSync(inside), false);
});

// 13) 失败动作的自撤：删除成功了但后置断言失败，文件必须回来
await check("delete 后置断言失败时文件被还原", async () => {
  const { root, opts } = fixture("delete-self-undo");
  const target = path.join(root, "keep.txt");
  fs.writeFileSync(target, "IMPORTANT");
  const report = await runActions(
    { name: "p", version: "0.0.0", capabilities: [{ id: "fs.write", reason: "t" }] } as never,
    [{
      id: "del", kind: "fs.delete", path: target,
      undo: { kind: "fs.restore", path: target, content: "IMPORTANT" },
      post: [{ kind: "path.exists", path: path.join(root, "never.txt") }],
    } as Action],
    opts,
    {},
  );
  assert.equal(report.steps[0]?.status, "failed");
  assert.equal(fs.existsSync(target), true, "删除已被自撤，文件应回来");
  assert.equal(fs.readFileSync(target, "utf8"), "IMPORTANT");
});

// 14) 覆盖已有文件而 undo 只会删除它 = 丢数据，必须显式确认
await check("覆盖已有文件且 undo 只能删除时需要确认", async () => {
  const { root, opts } = fixture("overwrite");
  const target = path.join(root, "existing.txt");
  fs.writeFileSync(target, "USER CONTENT");
  const probe = skill([
    { id: "w", kind: "fs.write", path: target, content: "NEW", undo: { kind: "fs.restore", path: target, content: null } },
  ]);
  await assert.rejects(run(probe, { root }, opts), /不可逆/);
  assert.equal(fs.readFileSync(target, "utf8"), "USER CONTENT");
});

// 15) 逐动作复查之后的 await 窗口不能被用来换 junction
await check("beforeAction 里换 junction 后下一步被拒", async () => {
  const { root, opts } = fixture("toctou");
  const sub = path.join(root, "sub");
  const outside = path.join(path.dirname(root), "outside-dir");
  fs.mkdirSync(sub);
  fs.mkdirSync(outside);
  const report = await runActions(
    { name: "p", version: "0.0.0", capabilities: [{ id: "fs.write", reason: "t" }] } as never,
    [
      { id: "s1", kind: "fs.write", path: path.join(sub, "ok.txt"), content: "1", undo: { kind: "fs.restore", path: path.join(sub, "ok.txt"), content: null } },
      { id: "s2", kind: "fs.write", path: path.join(sub, "pwn.txt"), content: "1", undo: { kind: "fs.restore", path: path.join(sub, "pwn.txt"), content: null } },
    ] as Action[],
    opts,
    {},
    {
      beforeAction: (_action, index) => {
        if (index !== 1) return;
        fs.rmSync(sub, { recursive: true, force: true });
        fs.symlinkSync(outside, sub, "junction");
      },
    },
  );
  assert.equal(report.steps[1]?.status, "failed");
  assert.equal(fs.existsSync(path.join(outside, "pwn.txt")), false, "不能写到 junction 指向的 root 外");
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
