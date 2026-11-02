import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskHost, TaskError } from "../packages/runtime/src/host.ts";
import { TaskStore } from "../packages/storage/src/task-store.ts";
import type { JsonValue, SkillRegistration, TaskHostOptions } from "../packages/runtime/src/types.ts";
import type { Action } from "../packages/core/src/types.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-task-runtime-"));
const workspace = path.join(temp, "work"); fs.mkdirSync(workspace);
let planned = 0; let revision = "fixture-v1";
const registration: SkillRegistration = {
  skill: {
    manifest: { name: "create-files", version: "1", description: "Trusted file fixture", entry: "fixture", capabilities: [{ id: "fs.read", scope: "{{root}}", reason: "Read fixture" }, { id: "fs.write", scope: "{{root}}", reason: "Write fixture" }] },
    async plan(input) {
      planned++;
      return Object.entries(input.files as Record<string, string>).map(([name, content], i): Action => ({
        id: `write-${i}`, kind: "fs.write", path: path.join(input.root, name), content,
        post: [{ kind: "path.exists", path: path.join(input.root, name) }, ...(input.fail === true ? [{ kind: "path.absent" as const, path: path.join(input.root, name) }] : [])], undo: { kind: "fs.restore", path: path.join(input.root, name), content: null },
      }));
    },
  },
  revision: () => revision,
  validator: {
    id: "fixture-file-goal", version: "1",
    verify({ root, criteria }) {
      const expected = criteria as Record<string, string>;
      const satisfied = Object.entries(expected).every(([name, content]) => !path.isAbsolute(name) && !name.includes("..") && fs.existsSync(path.join(root, name)) && fs.readFileSync(path.join(root, name), "utf8") === content);
      return { satisfied, detail: satisfied ? "All expected files match" : "Expected file content is missing" };
    },
  },
};
const options: TaskHostOptions = { dataDir: path.join(temp, "state"), allowedRoots: [workspace], granted: ["fs.read", "fs.write"], skills: [registration] };
let host = createTaskHost(options);
const checks: string[] = [];
const test = async (name: string, action: () => unknown | Promise<unknown>): Promise<void> => {
  await action(); checks.push(name); console.log(`PASS ${name}`);
};
const fixture = (name: string): string => { const root = path.join(workspace, name); fs.mkdirSync(root); return root; };
const prepare = (root: string, files: Record<string, string> = { "result.txt": "hello" }, criteria: JsonValue = files) => host.tasks.prepare({ skillId: "create-files", root, args: { files }, goal: { intent: "Create the approved fixture files", criteria } });
const request = (plan: Awaited<ReturnType<typeof prepare>>) => {
  const receipt = host.approvals.approve(plan.planId, plan.digest);
  return { planId: plan.planId, digest: plan.digest, approvalReceiptId: receipt.approvalId, idempotencyKey: "first" };
};
const code = (expected: string) => (error: unknown) => error instanceof TaskError && error.code === expected;

try {
  await test("prepare is read-only and executes the saved plan once", async () => {
    const root = fixture("once"); const before = planned; const plan = await prepare(root);
    assert.equal(planned, before + 1); assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
    assert.equal(host.tasks.get(plan.taskId).status, "awaiting_approval");
    const input = request(plan);
    plan.actions.length = 0; // A returned view is not the stored plan.
    const [a, b] = await Promise.all([host.tasks.execute(input), host.tasks.execute({ ...input, idempotencyKey: "other" })]);
    assert.equal(a.status, "succeeded"); assert.deepEqual(b, a); assert.equal(planned, before + 1);
    assert.equal(a.taskId, plan.taskId); assert.ok(a.journal.every((entry) => entry.taskId === plan.taskId));
    assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "hello");
    host.close(); host = createTaskHost(options);
    assert.deepEqual(await host.tasks.execute({ ...input, idempotencyKey: "after-restart" }), a);
  });
  await test("the task service has no approval route", () => {
    assert.equal("approve" in host.tasks, false);
  });
  await test("forged receipt and changed digest cannot execute", async () => {
    const root = fixture("approval"); const plan = await prepare(root);
    await assert.rejects(host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: "forged", idempotencyKey: "x" }), code("APPROVAL_REQUIRED"));
    assert.throws(() => host.approvals.approve(plan.planId, "wrong"), code("DIGEST_MISMATCH"));
    const input = request(plan);
    await assert.rejects(host.tasks.execute({ ...input, digest: "wrong" }), code("DIGEST_MISMATCH"));
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
  });
  await test("approval cannot be replayed for another plan", async () => {
    const one = await prepare(fixture("one")); const input = request(one);
    const two = await prepare(fixture("two"));
    await assert.rejects(host.tasks.execute({ ...input, planId: two.planId, digest: two.digest }), code("APPROVAL_REQUIRED"));
  });
  await test("external file changes invalidate an approved plan", async () => {
    const root = fixture("stale"); const plan = await prepare(root); const input = request(plan);
    fs.writeFileSync(path.join(root, "human.txt"), "human");
    await assert.rejects(host.tasks.execute(input), code("STALE_PLAN"));
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
  });
  await test("skill revision changes invalidate approval", async () => {
    const root = fixture("revision"); const plan = await prepare(root); const input = request(plan);
    revision = "fixture-v2";
    await assert.rejects(host.tasks.execute(input), code("STALE_PLAN")); revision = "fixture-v1";
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
  });
  await test("cancel before execution survives restart without effects", async () => {
    const root = fixture("cancel-before"); const plan = await prepare(root); const input = request(plan);
    assert.equal(host.tasks.cancel(plan.taskId).status, "cancelled");
    host.close(); host = createTaskHost(options);
    assert.equal((await host.tasks.execute(input)).status, "cancelled");
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
  });
  await test("event-loop cancellation between actions reports preserved partial effects", async () => {
    const root = fixture("cancel-between"); const plan = await prepare(root, { "first.txt": "one", "second.txt": "two" }); const input = request(plan);
    let polls = 0;
    let timer: NodeJS.Immediate | undefined;
    const cancelled = new Promise<void>((resolve, reject) => {
      const observe = (): void => {
        if (fs.existsSync(path.join(root, "first.txt"))) {
          assert.equal(host.tasks.cancel(plan.taskId).status, "cancelling"); resolve();
        } else if (++polls < 1000) timer = setImmediate(observe);
        else reject(new Error("First effect never became observable"));
      };
      timer = setImmediate(observe);
    });
    let result;
    try { [result] = await Promise.all([host.tasks.execute(input), cancelled]); }
    finally { if (timer) clearImmediate(timer); }
    assert.equal(result.status, "partial"); assert.equal(result.rolledBack, 0);
    assert.equal(fs.existsSync(path.join(root, "first.txt")), true);
    assert.equal(fs.existsSync(path.join(root, "second.txt")), false);
    assert.deepEqual(result.steps.map((step) => step.status), ["ok", "skipped"]);
    assert.equal(result.journal.length, 1); assert.equal(result.journal[0].status, "ok");
    host.close(); host = createTaskHost(options);
    assert.deepEqual(host.tasks.get(plan.taskId), result);
    assert.deepEqual(await host.tasks.execute(input), result);
  });
  await test("event-loop cancellation before the first effect leaves no files or journal entries", async () => {
    const root = fixture("cancel-first-boundary"); const plan = await prepare(root); const input = request(plan);
    const stopped = new Promise<void>((resolve) => setImmediate(() => {
      assert.equal(host.tasks.get(plan.taskId).status, "running");
      assert.equal(host.tasks.cancel(plan.taskId).status, "cancelling"); resolve();
    }));
    const [result] = await Promise.all([host.tasks.execute(input), stopped]);
    assert.equal(result.status, "cancelled"); assert.equal(result.rolledBack, 0);
    assert.deepEqual(result.journal, []); assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(result.steps[0].status, "skipped");
  });
  await test("a change during the event-loop yield is rejected before the next effect", async () => {
    const root = fixture("yield-conflict"); const plan = await prepare(root); const input = request(plan);
    const changed = new Promise<void>((resolve) => setImmediate(() => {
      fs.writeFileSync(path.join(root, "human.txt"), "external change"); resolve();
    }));
    const [result] = await Promise.all([host.tasks.execute(input), changed]);
    assert.equal(result.status, "needs_attention"); assert.equal(result.rolledBack, 0);
    assert.equal(result.steps[0].status, "failed");
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
    assert.equal(fs.readFileSync(path.join(root, "human.txt"), "utf8"), "external change");
  });
  await test("successful actions do not replace goal verification", async () => {
    const plan = await prepare(fixture("goal"), { "result.txt": "hello" }, { "result.txt": "different" });
    const result = await host.tasks.execute(request(plan));
    assert.equal(result.status, "partial"); assert.equal(result.error?.code, "GOAL_NOT_MET");
    assert.equal(result.steps[0].status, "ok");
  });
  await test("create-only MVP refuses overwrite", async () => {
    const root = fixture("overwrite"); fs.writeFileSync(path.join(root, "result.txt"), "human");
    await assert.rejects(prepare(root)); assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "human");
  });
  await test("failed postcondition preserves effects and reports attention", async () => {
    const root = fixture("failure");
    const plan = await host.tasks.prepare({ skillId: "create-files", root, args: { files: { "result.txt": "keep evidence" }, fail: true }, goal: { intent: "Test failure", criteria: {} } });
    const result = await host.tasks.execute(request(plan));
    assert.equal(result.status, "needs_attention"); assert.equal(result.rolledBack, 0);
    assert.equal(result.steps[0].status, "failed"); assert.equal(result.journal[0].status, "failed");
    assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "keep evidence");
    assert.deepEqual(host.tasks.cancel(plan.taskId), result);
  });
  await test("cancelling a completed task preserves its verified success", async () => {
    const root = fixture("cancel-complete"); const plan = await prepare(root);
    const result = await host.tasks.execute(request(plan));
    assert.equal(result.status, "succeeded"); assert.equal(result.goal?.satisfied, true);
    assert.deepEqual(host.tasks.cancel(plan.taskId), result);
  });
  await test("shrinking host root permissions invalidates previous approval", async () => {
    const root = fixture("old-scope"); const plan = await prepare(root); const input = request(plan);
    const other = fixture("new-scope"); host.close();
    host = createTaskHost({ ...options, allowedRoots: [other] });
    await assert.rejects(host.tasks.execute(input), code("PERMISSION_DENIED"));
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
    host.close(); host = createTaskHost(options);
  });
  await test("interrupted durable claim becomes attention and never replays", async () => {
    const root = fixture("interrupted"); const plan = await prepare(root); const input = request(plan);
    const task = host.tasks.get(plan.taskId); host.close();
    const store = new TaskStore(options.dataDir);
    store.claim(plan.planId, plan.digest, input.approvalReceiptId, plan.taskId, { ...task, status: "running" });
    store.close(); host = createTaskHost(options);
    assert.equal(host.tasks.get(plan.taskId).status, "needs_attention");
    assert.equal((await host.tasks.execute(input)).status, "needs_attention");
    assert.equal(fs.existsSync(path.join(root, "result.txt")), false);
  });
  await test("caller data cannot change the queued goal or root", async () => {
    const root = fixture("copy"); const args = { files: { "result.txt": "original" } };
    const pending = host.tasks.prepare({ skillId: "create-files", root, args, goal: { intent: "Write original", criteria: { "result.txt": "original" } } });
    args.files["result.txt"] = "mutated";
    const plan = await pending; const result = await host.tasks.execute(request(plan));
    assert.equal(result.status, "succeeded"); assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8"), "original");
    assert.throws(() => host.tasks.prepare({ skillId: "create-files", root, args: { root: temp }, goal: { intent: "bad", criteria: {} } }), code("INVALID_REQUEST"));
  });
  await test("host scope and storage are separate", async () => {
    await assert.rejects(prepare(temp), code("PERMISSION_DENIED"));
    assert.throws(() => createTaskHost({ ...options, dataDir: path.join(workspace, "bad-state") }), code("INVALID_CONFIG"));
    assert.equal(fs.existsSync(path.join(workspace, "bad-state")), false);
    assert.throws(() => createTaskHost(options), code("HOST_BUSY"));
  });
  await test("directory creation and file move preserve content", async () => {
    host.close();
    const moveRegistration: SkillRegistration = { ...registration, skill: { ...registration.skill, manifest: { ...registration.skill.manifest, name: "move-file" }, async plan({ root }) {
      return [
        { id: "mkdir", kind: "fs.mkdir", path: path.join(root, "archive"), undo: { kind: "fs.rmdir", path: path.join(root, "archive") } },
        { id: "move", kind: "fs.move", from: path.join(root, "source.txt"), to: path.join(root, "archive", "source.txt"), undo: { kind: "fs.move", from: path.join(root, "archive", "source.txt"), to: path.join(root, "source.txt") } },
      ];
    } }, validator: { id: "moved-file", version: "1", verify: ({root}) => ({ satisfied: !fs.existsSync(path.join(root, "source.txt")) && fs.readFileSync(path.join(root, "archive", "source.txt"), "utf8") === "payload", detail: "move content checked" }) } };
    host = createTaskHost({ ...options, skills: [registration, moveRegistration] });
    const root = fixture("move"); fs.writeFileSync(path.join(root, "source.txt"), "payload");
    const plan = await host.tasks.prepare({ skillId: "move-file", root, goal: { intent: "Archive source", criteria: {} } });
    assert.equal((await host.tasks.execute(request(plan))).status, "succeeded");
  });
  console.log(`\n${checks.length}/${checks.length} passed`);
} finally {
  host.close();
  // Delete only the unique fixture directory created by this test.
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe cleanup path");
  fs.rmSync(temp, { recursive: true, force: true });
}
