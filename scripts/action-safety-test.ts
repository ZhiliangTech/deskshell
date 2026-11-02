import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyError, run, undoAll, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import type { Action, CapabilityId, RunOptions, Skill } from "../packages/core/src/types.ts";

// 每次运行只写自己的临时目录；不依赖现有 .demo，也不操作真实桌面。
const tempRoot = path.resolve(os.tmpdir());
const base = fs.mkdtempSync(path.join(tempRoot, "deskshell-action-safety-"));
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
  fs.mkdirSync(root);
  return {
    root,
    opts: { mode: "apply", root, granted: ["fs.write", "ui.input"], journalPath: path.join(base, `${name}.jsonl`) },
  };
}

function skill(actions: Action[], capabilities: CapabilityId[] = ["fs.write"]): Skill {
  return {
    manifest: {
      name: "action-safety-probe",
      version: "0.0.0",
      description: "isolated safety regression",
      entry: "./index.ts",
      capabilities: capabilities.map((id) => ({ id, reason: "isolated test" })),
    },
    async plan() { return actions; },
  };
}

function write(root: string, id: string): Action {
  const target = path.join(root, `${id}.txt`);
  return {
    id, kind: "fs.write", path: target, content: id,
    undo: { kind: "fs.restore", path: target, content: null },
  };
}

try {
  await check("空能力声明在 preview/apply 都被拒绝，显式确认不能绕过授权", async () => {
    const { root, opts } = fixture("empty-capabilities");
    const probe = skill([write(root, "denied")], []);
    for (const mode of ["preview", "apply"] as const) {
      await assert.rejects(
        run(probe, { root }, { ...opts, mode, granted: [], allowIrreversible: true }),
        (error: unknown) => error instanceof PolicyError && error.reasons.some((reason) => reason.includes("fs.write")),
      );
    }
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  for (const missing of ["omitted", "null"] as const) {
    await check(`${missing} undo 在预览中不可撤销，未确认时整单拒绝`, async () => {
      const { root, opts } = fixture(`preflight-${missing}`);
      const action = write(root, "unsafe");
      if (missing === "omitted") delete action.undo;
      else action.undo = null;
      const probe = skill([write(root, "safe-first"), action]);
      const preview = await run(probe, { root }, { ...opts, mode: "preview" });
      assert.equal(preview.summary?.undoable, 1);
      assert.equal(preview.summary?.notUndoable, 1);
      assert.equal(preview.summary?.irreversible, 1);
      assert.match(preview.steps[1].detail ?? "", /undoable=false/);
      await assert.rejects(run(probe, { root }, opts), /不可逆/);
      assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(fs.existsSync(opts.journalPath), false);
    });

    for (const method of ["task", "last", "all"] as const) {
      await check(`${missing} undo 显式执行后，${method} 不谎报撤销成功`, async () => {
        const { root, opts } = fixture(`undo-${missing}-${method}`);
        const action = write(root, "kept");
        if (missing === "omitted") delete action.undo;
        else action.undo = null;
        const probe = skill([action]);
        const applied = await run(probe, { root }, { ...opts, allowIrreversible: true });
        assert.equal(applied.steps[0].status, "ok");
        const undoOpts = { ...opts, mode: "undo" as const };
        const undone = method === "task"
          ? await undoTask(applied.taskId!, undoOpts)
          : method === "last"
            ? await run(probe, { root }, undoOpts)
            : await undoAll(undoOpts);
        assert.equal(undone.rolledBack, 0);
        assert.equal(undone.steps[0].status, "failed");
        assert.match(undone.steps[0].detail ?? "", /不可撤销/);
        assert.equal(fs.readFileSync(path.join(root, "kept.txt"), "utf8"), "kept");
        assert.equal(load(opts.journalPath)[0].status, "ok");
      });
    }
  }

  await check("显式 irreversible 的 noop 占位不能被统计成可撤销", async () => {
    const { root, opts } = fixture("explicit-irreversible");
    const action = write(root, "kept");
    action.irreversible = true;
    action.undo = { kind: "noop" };
    const probe = skill([action]);
    const preview = await run(probe, { root }, { ...opts, mode: "preview" });
    assert.equal(preview.summary?.undoable, 0);
    assert.equal(preview.summary?.notUndoable, 1);
    assert.equal(preview.summary?.irreversible, 1);
    await assert.rejects(run(probe, { root }, opts), /不可逆/);
    const applied = await run(probe, { root }, { ...opts, allowIrreversible: true });
    assert.equal(load(opts.journalPath)[0].undo, undefined);
    const undone = await undoTask(applied.taskId!, { ...opts, mode: "undo" });
    assert.equal(undone.rolledBack, 0);
    assert.equal(undone.steps[0].status, "failed");
    assert.equal(fs.existsSync(path.join(root, "kept.txt")), true);
  });

  await check("保留 v0 可选 post 和未标记 noop 的兼容行为", async () => {
    const { root, opts } = fixture("legacy-noop");
    const driver = new MockDriver();
    const probe = skill([{
      id: "click", kind: "ui.click", window: "Mock Window", selector: { automationId: "ok" }, undo: { kind: "noop" },
    }], ["ui.input"]);
    const applied = await run(probe, { root }, opts, { driver });
    assert.equal(applied.steps[0].status, "ok");
    assert.equal((await undoTask(applied.taskId!, { ...opts, mode: "undo" }, { driver })).rolledBack, 1);
  });

  await check("无 undo 的硬删除仍被策略拒绝，遗漏字段不能绕过", async () => {
    const { root, opts } = fixture("hard-delete");
    const target = path.join(root, "original.txt");
    fs.writeFileSync(target, "original");
    for (const undo of [undefined, null]) {
      const probe = skill([{ id: "delete", kind: "fs.delete", path: target, undo }]);
      await assert.rejects(run(probe, { root }, { ...opts, allowIrreversible: true }), /不可撤销的删除/);
    }
    assert.equal(fs.readFileSync(target, "utf8"), "original");
  });

  await check("自动回滚遇到不可撤销动作和驱动失败仍继续，计数和日志如实保留", async () => {
    const { root, opts } = fixture("partial-rollback");
    class FailingUndoDriver extends MockDriver {
      override async setValue(): Promise<void> { throw new Error("injected undo failure"); }
    }
    const driver = new FailingUndoDriver();
    const unsafe = write(root, "irreversible");
    unsafe.undo = null;
    const selector = { automationId: "editor" };
    const probe = skill([
      write(root, "safe"),
      unsafe,
      {
        id: "ui-ok", kind: "ui.type", window: "Mock Window", selector, text: "first",
        undo: { kind: "ui.value", window: "Mock Window", selector, value: "" },
      },
      {
        id: "ui-fail", kind: "ui.type", window: "Mock Window", selector, text: "second",
        post: [{ kind: "ui.value", window: "Mock Window", selector, equals: "never" }],
        undo: { kind: "ui.value", window: "Mock Window", selector, value: "first" },
      },
      write(root, "must-not-run"),
    ], ["fs.write", "ui.input"]);
    const report = await run(probe, { root }, { ...opts, allowIrreversible: true }, { driver });
    assert.equal(report.rolledBack, 1);
    assert.equal(fs.existsSync(path.join(root, "safe.txt")), false);
    assert.equal(fs.existsSync(path.join(root, "irreversible.txt")), true);
    assert.equal(fs.existsSync(path.join(root, "must-not-run.txt")), false);
    assert.equal(report.steps.find((step) => step.actionId === "irreversible")?.status, "failed");
    assert.equal(report.steps.find((step) => step.actionId === "ui-ok")?.status, "failed");
    const entries = load(opts.journalPath);
    assert.deepEqual(entries.map(({ actionId, status }) => ({ actionId, status })), [
      { actionId: "safe", status: "rolled-back" },
      { actionId: "irreversible", status: "ok" },
      { actionId: "ui-ok", status: "ok" },
      { actionId: "ui-fail", status: "failed" },
    ]);
    assert.match(entries[3].detail ?? "", /后置断言失败/);
    const failureDetail = report.steps.find((step) => step.actionId === "ui-fail")?.detail ?? "";
    assert.match(failureDetail, /自撤失败 ui-fail.*injected undo failure/);
    assert.match(failureDetail, /回滚失败 ui-ok.*injected undo failure/);
    assert.match(failureDetail, /回滚失败 irreversible.*不可撤销/);
  });
} finally {
  if (path.dirname(base) !== tempRoot || !path.basename(base).startsWith("deskshell-action-safety-")) {
    throw new Error(`拒绝清理非测试目录：${base}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  ${result.detail}` : ""}`);
console.log(`${results.filter((result) => result.ok).length}/${results.length} passed`);
