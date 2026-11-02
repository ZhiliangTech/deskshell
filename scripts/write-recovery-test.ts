import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import type { Action, Skill } from "../packages/core/src/types.ts";

// 每个场景使用独立临时目录，避免覆盖用户的 .demo 或真实文件。
const work = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-write-recovery-"));
let passed = 0;
let total = 0;

async function check(name: string, test: (root: string, journalPath: string) => Promise<void>): Promise<void> {
  total++;
  const root = path.join(work, String(total), "workspace");
  fs.mkdirSync(root, { recursive: true });
  try {
    await test(root, path.join(work, String(total), "journal.jsonl"));
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function write(file: string): Action {
  return {
    id: "write-nested",
    kind: "fs.write",
    path: file,
    content: "new content",
    post: [{ kind: "path.exists", path: file }],
    undo: { kind: "fs.restore", path: file, content: null },
  };
}

async function apply(root: string, journalPath: string, actions: Action[]) {
  const skill: Skill = {
    manifest: {
      name: "write-recovery", version: "0.0.0", description: "nested write recovery", entry: "./index.ts",
      capabilities: [{ id: "fs.write", scope: "{{root}}", reason: "write test fixture" }],
    },
    async plan() { return actions; },
  };
  return run(skill, { root }, { mode: "apply", root, granted: ["fs.write"], journalPath });
}

async function undo(root: string, journalPath: string, taskId: string) {
  return undoTask(taskId, { mode: "undo", root, granted: [], journalPath });
}

try {
  await check("手动撤销清理自动创建的多层目录", async (root, journalPath) => {
    const report = await apply(root, journalPath, [write(path.join(root, "new", "deep", "note.txt"))]);
    assert.equal(report.steps[0].status, "ok");
    const result = await undo(root, journalPath, report.taskId!);
    assert.equal(result.rolledBack, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(load(journalPath)[0].status, "rolled-back");
    assert.equal((await undo(root, journalPath, report.taskId!)).rolledBack, 0);
  });

  await check("后置断言失败时自撤也清理父目录", async (root, journalPath) => {
    const action = write(path.join(root, "new", "deep", "note.txt"));
    action.post = [{ kind: "path.exists", path: path.join(root, "missing") }];
    const report = await apply(root, journalPath, [action]);
    assert.equal(report.steps[0].status, "failed");
    assert.equal(report.rolledBack, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(load(journalPath)[0].status, "failed");
  });

  await check("后续步骤失败时回滚先前嵌套写入", async (root, journalPath) => {
    const later = write(path.join(root, "later.txt"));
    later.id = "later-failure";
    later.post = [{ kind: "path.exists", path: path.join(root, "missing") }];
    const report = await apply(root, journalPath, [write(path.join(root, "new", "deep", "note.txt")), later]);
    assert.deepEqual(report.steps.map((s) => s.status), ["ok", "failed"]);
    assert.equal(report.rolledBack, 2);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(load(journalPath)[0].status, "rolled-back");
  });

  await check("保留执行前已存在的空目录", async (root, journalPath) => {
    const existing = path.join(root, "existing");
    fs.mkdirSync(existing);
    const report = await apply(root, journalPath, [write(path.join(existing, "new", "note.txt"))]);
    assert.equal((await undo(root, journalPath, report.taskId!)).rolledBack, 1);
    assert.deepEqual(fs.readdirSync(root), ["existing"]);
    assert.deepEqual(fs.readdirSync(existing), []);
  });

  await check("自动创建的目录有外部文件时保留目录和文件", async (root, journalPath) => {
    const parent = path.join(root, "new", "deep");
    const report = await apply(root, journalPath, [write(path.join(parent, "note.txt"))]);
    fs.writeFileSync(path.join(parent, "someone-else.txt"), "keep");
    assert.equal((await undo(root, journalPath, report.taskId!)).rolledBack, 1);
    assert.deepEqual(fs.readdirSync(parent), ["someone-else.txt"]);
    assert.equal(fs.readFileSync(path.join(parent, "someone-else.txt"), "utf8"), "keep");
  });

  await check("文件被外部修改时拒绝撤销并保留目录", async (root, journalPath) => {
    const file = path.join(root, "new", "deep", "note.txt");
    const report = await apply(root, journalPath, [write(file)]);
    fs.writeFileSync(file, "external edit");
    const result = await undo(root, journalPath, report.taskId!);
    assert.equal(result.rolledBack, 0);
    assert.equal(result.steps[0].status, "failed");
    assert.equal(fs.readFileSync(file, "utf8"), "external edit");
    assert.equal(load(journalPath)[0].status, "ok");
  });
} finally {
  // work 只来自 mkdtemp，不接受外部路径；删除前再次确认目录归属。
  assert.equal(path.dirname(work), path.resolve(os.tmpdir()));
  assert.ok(path.basename(work).startsWith("deskshell-write-recovery-"));
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`${passed}/${total} passed`);
