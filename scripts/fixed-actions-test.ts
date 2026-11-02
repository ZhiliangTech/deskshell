import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTION_CANCELLED_DETAIL, PolicyError, run, runActions } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import type { Action, RunOptions, Skill, SkillManifest, UiSelector, WindowInfo, WindowRef } from "../packages/core/src/types.ts";

const tempRoot = path.resolve(os.tmpdir());
const base = fs.mkdtempSync(path.join(tempRoot, "deskshell-fixed-actions-"));
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const manifest = (): SkillManifest => ({
  name: "fixed-actions", version: "0.0.0", description: "isolated fixed plan test", entry: "./index.ts",
  capabilities: [{ id: "fs.write", reason: "fixture files" }, { id: "ui.input", reason: "mock only" }],
});

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

function fixture(name: string): { root: string; opts: RunOptions } {
  const root = path.join(base, name);
  fs.mkdirSync(root);
  return { root, opts: { mode: "apply", root, granted: ["fs.write", "ui.input"], journalPath: path.join(base, `${name}.jsonl`) } };
}

function write(root: string, id: string, content = id): Action {
  const target = path.join(root, `${id}.txt`);
  return {
    id, kind: "fs.write", path: target, content,
    post: [{ kind: "path.exists", path: target }],
    undo: { kind: "fs.restore", path: target, content: null },
  };
}

function type(id = "type"): Action {
  return {
    id, kind: "ui.type", window: "Mock Window", selector: { automationId: "editor" }, text: "written",
    post: [{ kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, equals: "written" }],
    undo: { kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, value: "" },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class GatedDriver extends MockDriver {
  entered = gate();
  resume = gate();
  override async type(ref: WindowRef, selector: UiSelector, text: string): Promise<void> {
    this.entered.release();
    await this.resume.promise;
    await super.type(ref, selector, text);
  }
}

try {
  await check("legacy run checks capabilities before planning and plans once", async () => {
    const { root, opts } = fixture("legacy");
    let calls = 0;
    const skill: Skill = { manifest: manifest(), async plan() { calls++; return [write(root, "legacy")]; } };
    await assert.rejects(run(skill, { root }, { ...opts, granted: [] }), PolicyError);
    assert.equal(calls, 0);
    const preview = await run(skill, { root }, { ...opts, mode: "preview" });
    assert.equal(calls, 1);
    assert.equal(preview.summary?.total, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    const applied = await run(skill, { root }, opts);
    assert.equal(calls, 2);
    assert.equal(applied.steps[0].status, "ok");
    const undone = await run(skill, { root }, { ...opts, mode: "undo", granted: [] });
    assert.equal(calls, 2);
    assert.equal(undone.rolledBack, 1);
    assert.equal(fs.existsSync(path.join(root, "legacy.txt")), false);
  });

  await check("fixed preview/apply never replan; host taskId is preserved in journal", async () => {
    const { root, opts } = fixture("fixed");
    let calls = 0;
    const skill: Skill = { manifest: manifest(), async plan() { calls++; return [write(root, "prepared", `plan-${calls}`)]; } };
    const actions = Object.freeze(await skill.plan({ root }, {}));
    const preview = await runActions(skill.manifest, actions, { ...opts, mode: "preview" }, {}, { taskId: "host-fixed" });
    assert.equal(calls, 1);
    assert.equal(preview.mode, "preview");
    assert.equal(preview.summary?.total, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
    const report = await runActions(skill.manifest, actions, opts, {}, { taskId: "host-fixed" });
    assert.equal(calls, 1);
    assert.equal(report.taskId, "host-fixed");
    assert.equal(fs.readFileSync(path.join(root, "prepared.txt"), "utf8"), "plan-1");
    assert.deepEqual(load(opts.journalPath).map((entry) => entry.taskId), ["host-fixed"]);
    const undone = await runActions(skill.manifest, [], { ...opts, mode: "undo", granted: [] });
    assert.equal(undone.rolledBack, 1);
    assert.equal(fs.existsSync(path.join(root, "prepared.txt")), false);
  });

  await check("fixed batch is unaffected by caller mutation while a driver is awaited", async () => {
    const { root, opts } = fixture("snapshot");
    const driver = new GatedDriver();
    const sourceManifest = manifest();
    const originalJournal = opts.journalPath;
    const actions = [type(), write(root, "saved", "original")];
    const pending = runActions(sourceManifest, actions, opts, { driver }, { taskId: "host-snapshot" });
    await driver.entered.promise;
    try {
      sourceManifest.name = "changed";
      opts.journalPath = path.join(base, "not-used.jsonl");
      if (actions[1].kind === "fs.write") actions[1].content = "changed";
      actions[0].post = [{ kind: "path.exists", path: path.join(root, "never") }];
      actions.push(write(root, "not-in-plan"));
    } finally {
      driver.resume.release();
    }
    const report = await pending;
    assert.equal(report.steps.length, 2);
    assert.ok(report.steps.every((step) => step.status === "ok"));
    assert.equal(fs.readFileSync(path.join(root, "saved.txt"), "utf8"), "original");
    assert.equal(fs.existsSync(path.join(root, "not-in-plan.txt")), false);
    assert.ok(load(originalJournal).every((entry) => entry.skill === "fixed-actions"));
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  await check("fixed actions keep capability, path and irreversible policy checks", async () => {
    const { root, opts } = fixture("policy");
    const actions = [write(root, "denied")];
    await assert.rejects(runActions(manifest(), actions, { ...opts, granted: [] }), PolicyError);
    await assert.rejects(runActions({ ...manifest(), capabilities: [] }, actions, opts), PolicyError);
    await assert.rejects(runActions(manifest(), [write(base, "outside")], opts), /路径越界/);
    delete actions[0].undo;
    await assert.rejects(runActions(manifest(), actions, opts), /不可逆/);
    const preview = await runActions(manifest(), actions, { ...opts, mode: "preview" });
    assert.equal(preview.summary?.irreversible, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  await check("invalid host taskId is rejected before effects", async () => {
    const { root, opts } = fixture("invalid-id");
    for (const taskId of ["", "  ", null, 1]) {
      await assert.rejects(runActions(manifest(), [write(root, "denied")], opts, {}, { taskId: taskId as string }), /taskId must be a non-empty string/);
    }
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  await check("abort before the first action reports skipped without writes or rollback", async () => {
    const { root, opts } = fixture("abort-before");
    const controller = new AbortController();
    controller.abort();
    const report = await runActions(manifest(), [write(root, "first"), write(root, "second")], opts, {}, { taskId: "host-cancel", signal: controller.signal });
    assert.equal(report.taskId, "host-cancel");
    assert.deepEqual(report.steps, [{ actionId: "first", status: "skipped", detail: "Execution cancelled before action" }]);
    assert.equal(ACTION_CANCELLED_DETAIL, "Execution cancelled before action");
    assert.equal(report.rolledBack, 0);
    assert.deepEqual(report.journal, []);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  await check("abort during an action waits for its result and preserves the completed effect", async () => {
    const { root, opts } = fixture("abort-during");
    const driver = new GatedDriver();
    const controller = new AbortController();
    const pending = runActions(manifest(), [type(), write(root, "next")], opts, { driver }, { taskId: "host-partial", signal: controller.signal });
    await driver.entered.promise;
    controller.abort();
    driver.resume.release();
    const report = await pending;
    assert.deepEqual(report.steps.map((step) => step.status), ["ok", "skipped"]);
    assert.equal(report.steps[1].detail, ACTION_CANCELLED_DETAIL);
    assert.equal(report.rolledBack, 0);
    assert.equal(driver.treeData.children[0].value, "written");
    assert.equal(driver.calls.some((call) => call.startsWith("setValue:")), false);
    assert.equal(fs.existsSync(path.join(root, "next.txt")), false);
    assert.deepEqual(load(opts.journalPath).map(({ actionId, status, taskId }) => ({ actionId, status, taskId })), [
      { actionId: "type", status: "ok", taskId: "host-partial" },
    ]);
    const undone = await runActions(manifest(), [], { ...opts, mode: "undo" }, { driver });
    assert.equal(undone.rolledBack, 1);
    assert.equal(driver.treeData.children[0].value, "");
  });

  await check("abort during a precondition does not start the action effect", async () => {
    const { root, opts } = fixture("abort-precondition");
    class ObservingDriver extends MockDriver {
      entered = gate();
      resume = gate();
      override async windows(): Promise<WindowInfo[]> {
        this.entered.release();
        await this.resume.promise;
        return super.windows();
      }
    }
    const driver = new ObservingDriver();
    const controller = new AbortController();
    const action = write(root, "never-started");
    action.pre = [{ kind: "window.exists", window: "Mock" }];
    const pending = runActions(manifest(), [action], opts, { driver }, { signal: controller.signal });
    await driver.entered.promise;
    controller.abort();
    driver.resume.release();
    const report = await pending;
    assert.equal(report.steps[0].status, "skipped");
    assert.equal(report.steps[0].detail, ACTION_CANCELLED_DETAIL);
    assert.equal(report.rolledBack, 0);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  await check("a completed last action remains complete when abort arrives during it", async () => {
    const { opts } = fixture("abort-last");
    const driver = new GatedDriver();
    const controller = new AbortController();
    const pending = runActions(manifest(), [type()], opts, { driver }, { signal: controller.signal });
    await driver.entered.promise;
    controller.abort();
    driver.resume.release();
    const report = await pending;
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(report.steps, [{ actionId: "type", status: "ok" }]);
    assert.equal(report.rolledBack, 0);
    assert.equal(load(opts.journalPath)[0].status, "ok");
  });

  await check("abort does not hide an in-flight assertion failure or its real rollback", async () => {
    const { opts } = fixture("abort-failure");
    const driver = new GatedDriver();
    const controller = new AbortController();
    const action = type();
    action.post = [{ kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, equals: "never" }];
    const pending = runActions(manifest(), [action], opts, { driver }, { taskId: "host-failure", signal: controller.signal });
    await driver.entered.promise;
    controller.abort();
    driver.resume.release();
    const report = await pending;
    assert.equal(report.steps[0].status, "failed");
    assert.match(report.steps[0].detail ?? "", /后置断言失败/);
    assert.equal(report.rolledBack, 1);
    assert.equal(driver.treeData.children[0].value, "");
    assert.equal(load(opts.journalPath)[0].status, "failed");
    assert.equal(load(opts.journalPath)[0].taskId, "host-failure");
  });

  await check("fixed failure preserves existing reverse rollback and audit semantics", async () => {
    const { root, opts } = fixture("rollback");
    const failing = write(root, "second");
    failing.post = [{ kind: "path.exists", path: path.join(root, "never") }];
    const report = await runActions(manifest(), [write(root, "first"), failing], opts, {}, { taskId: "host-rollback" });
    assert.equal(report.rolledBack, 2);
    assert.deepEqual(report.steps.map((step) => step.status), ["ok", "failed"]);
    assert.deepEqual(fs.readdirSync(root), []);
    const entries = load(opts.journalPath);
    assert.deepEqual(entries.map((entry) => entry.status), ["rolled-back", "failed"]);
    assert.ok(entries.every((entry) => entry.taskId === "host-rollback"));
  });

  await check("host can disable self-undo and automatic rollback while keeping failure audit", async () => {
    const { root, opts } = fixture("no-rollback");
    const failing = write(root, "second");
    failing.post = [{ kind: "path.exists", path: path.join(root, "never") }];
    const report = await runActions(manifest(), [write(root, "first"), failing], opts, {}, {
      taskId: "host-preserve", rollbackOnFailure: false,
    });
    assert.equal(report.rolledBack, 0);
    assert.deepEqual(report.steps.map((step) => step.status), ["ok", "failed"]);
    assert.equal(fs.readFileSync(path.join(root, "first.txt"), "utf8"), "first");
    assert.equal(fs.readFileSync(path.join(root, "second.txt"), "utf8"), "second");
    assert.deepEqual(load(opts.journalPath).map((entry) => entry.status), ["ok", "failed"]);
  });

  await check("host hooks bracket effects and journaling, without mutating the fixed actions", async () => {
    const { root, opts } = fixture("hooks");
    const events: string[] = [];
    const report = await runActions(manifest(), [write(root, "first"), write(root, "second")], opts, {}, {
      beforeAction(action, index) {
        events.push(`before:${index}`);
        if (action.kind !== "fs.write") throw new Error("unexpected action");
        assert.equal(fs.existsSync(action.path), false);
        assert.equal(load(opts.journalPath).length, index);
        action.content = "mutated-hook-copy";
      },
      afterAction(action, index) {
        events.push(`after:${index}`);
        if (action.kind !== "fs.write") throw new Error("unexpected action");
        assert.equal(fs.readFileSync(action.path, "utf8"), action.id);
        const entries = load(opts.journalPath);
        assert.equal(entries.length, index + 1);
        assert.equal(entries[index].status, "ok");
      },
    });
    assert.deepEqual(events, ["before:0", "after:0", "before:1", "after:1"]);
    assert.ok(report.steps.every((step) => step.status === "ok"));
  });

  await check("beforeAction refusal stops before effects and honors host recovery policy", async () => {
    const { root, opts } = fixture("before-refusal");
    const completed: number[] = [];
    const report = await runActions(manifest(), [write(root, "first"), write(root, "second")], opts, {}, {
      rollbackOnFailure: false,
      beforeAction(_action, index) { if (index === 1) throw new Error("host observed a conflict"); },
      afterAction(_action, index) { completed.push(index); },
    });
    assert.deepEqual(completed, [0]);
    assert.equal(report.steps[1].status, "failed");
    assert.equal(report.steps[1].detail, "host observed a conflict");
    assert.equal(report.rolledBack, 0);
    assert.equal(fs.existsSync(path.join(root, "first.txt")), true);
    assert.equal(fs.existsSync(path.join(root, "second.txt")), false);
    assert.deepEqual(load(opts.journalPath).map((entry) => entry.status), ["ok", "failed"]);
  });

  await check("failed preconditions do not invoke the host beforeAction hook", async () => {
    const { root, opts } = fixture("precondition-refusal");
    const action = write(root, "denied");
    action.pre = [{ kind: "path.exists", path: path.join(root, "never") }];
    let hooks = 0;
    const report = await runActions(manifest(), [action], opts, {}, {
      beforeAction() { hooks++; }, afterAction() { hooks++; },
    });
    assert.equal(hooks, 0);
    assert.equal(report.steps[0].status, "failed");
    assert.equal(report.rolledBack, 0);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  await check("afterAction errors propagate without rewriting or compensating a completed effect", async () => {
    const { root, opts } = fixture("after-error");
    await assert.rejects(runActions(manifest(), [write(root, "first"), write(root, "second")], opts, {}, {
      taskId: "host-refresh-error",
      afterAction() { throw new Error("host refresh failed"); },
    }), /host refresh failed/);
    assert.equal(fs.readFileSync(path.join(root, "first.txt"), "utf8"), "first");
    assert.equal(fs.existsSync(path.join(root, "second.txt")), false);
    const entries = load(opts.journalPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].taskId, "host-refresh-error");
    assert.equal(entries[0].status, "ok");
  });

  await check("abort while awaiting beforeAction still prevents the next effect", async () => {
    const { root, opts } = fixture("abort-before-hook");
    const entered = gate();
    const resume = gate();
    const controller = new AbortController();
    let afterCalls = 0;
    const pending = runActions(manifest(), [write(root, "denied")], opts, {}, {
      signal: controller.signal,
      async beforeAction() { entered.release(); await resume.promise; },
      afterAction() { afterCalls++; },
    });
    await entered.promise;
    controller.abort();
    resume.release();
    const report = await pending;
    assert.equal(report.steps[0].detail, ACTION_CANCELLED_DETAIL);
    assert.equal(report.steps[0].status, "skipped");
    assert.equal(afterCalls, 0);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });

  await check("an empty fixed plan has no remaining action to cancel", async () => {
    const { opts } = fixture("empty");
    const controller = new AbortController();
    controller.abort();
    const report = await runActions(manifest(), [], opts, {}, { signal: controller.signal });
    assert.deepEqual(report.steps, []);
    assert.equal(report.rolledBack, 0);
    assert.match(report.taskId ?? "", /^task-/);
    assert.equal(fs.existsSync(opts.journalPath), false);
  });
} finally {
  if (path.dirname(base) !== tempRoot || !path.basename(base).startsWith("deskshell-fixed-actions-")) {
    throw new Error(`拒绝清理非测试目录：${base}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  ${result.detail}` : ""}`);
console.log(`${results.filter((result) => result.ok).length}/${results.length} passed`);
