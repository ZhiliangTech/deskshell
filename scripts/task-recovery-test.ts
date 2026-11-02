import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createTaskHost } from "../packages/runtime/src/host.ts";
import { TaskStore } from "../packages/storage/src/task-store.ts";
import { captureTree } from "../packages/runtime/src/file-plan.ts";
import type { PreparedPlan, RecoveryPlan, SkillRegistration } from "../packages/runtime/src/types.ts";

const registration: SkillRegistration = {
  skill: {
    manifest: { name: "recovery-fixture", version: "1", entry: "test", description: "Synthetic recovery fixture", capabilities: [
      { id: "fs.read", scope: "{{root}}", reason: "Check test files" }, { id: "fs.write", scope: "{{root}}", reason: "Modify test files" },
    ] },
    async plan({ root }) { return [
      { id: "directory", kind: "fs.mkdir", path: path.join(root, "archive"), undo: { kind: "fs.rmdir", path: path.join(root, "archive") } },
      { id: "move", kind: "fs.move", from: path.join(root, "source.txt"), to: path.join(root, "archive", "source.txt"), undo: { kind: "fs.move", from: path.join(root, "archive", "source.txt"), to: path.join(root, "source.txt") } },
      { id: "note", kind: "fs.write", path: path.join(root, "archive", "note.txt"), content: "task-created note\n", undo: { kind: "fs.restore", path: path.join(root, "archive", "note.txt"), content: null } },
    ]; },
  },
  revision: () => "recovery-fixture-v1",
  validator: { id: "recovery-fixture-goal", version: "1", verify: ({ root }) => ({
    satisfied: !fs.existsSync(path.join(root, "source.txt")) && fs.readFileSync(path.join(root, "archive", "source.txt"), "utf8") === "original bytes\n"
      && fs.readFileSync(path.join(root, "archive", "note.txt"), "utf8") === "task-created note\n"
      && fs.readFileSync(path.join(root, "keep.txt"), "utf8") === "keep original\n", detail: "Exact original and generated content checked",
  }) },
};
const open = (root: string, dataDir: string) => createTaskHost({ dataDir, allowedRoots: [root], granted: ["fs.read", "fs.write"], skills: [registration] });
type Host = ReturnType<typeof open>;
const request = (host: Host, plan: PreparedPlan) => ({ planId: plan.planId, digest: plan.digest, approvalReceiptId: host.approvals.approve(plan.planId, plan.digest).approvalId, idempotencyKey: "fixture" });
const recoveryRequest = (host: Host, plan: RecoveryPlan) => ({ recoveryId: plan.recoveryId, digest: plan.digest, approvalReceiptId: host.approvals.approveRecovery(plan.recoveryId, plan.digest).approvalId });
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;

if (process.argv[2] === "--child") {
  const [root, state, id, digest, approvalReceiptId, fault] = process.argv.slice(3);
  const parent = path.dirname(path.dirname(root));
  if (path.dirname(parent) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith("deskshell-task-recovery-")) throw new Error("Fault injection requires a unique temporary fixture");
  const host = open(root, state);
  const rename = fs.renameSync; const write = fs.writeFileSync; const rmdir = fs.rmdirSync; const mkdir = fs.mkdirSync;
  fs.mkdirSync = ((directory, options) => {
    const result = mkdir(directory, options);
    if (fault === "forward-after-directory" && String(directory) === path.join(root, "archive")) process.exit(75);
    return result;
  }) as typeof fs.mkdirSync;
  fs.renameSync = ((from, to) => {
    const isForward = String(from) === path.join(root, "source.txt");
    const isRecovery = String(from) === path.join(root, "archive", "source.txt");
    if (fault === "forward-before-move" && isForward || fault === "recovery-before-move" && isRecovery) process.exit(71);
    rename(from, to);
    if (fault === "forward-after-move" && isForward || fault === "recovery-after-move" && isRecovery) process.exit(72);
  }) as typeof fs.renameSync;
  fs.writeFileSync = ((file, contents, options) => {
    write(file, contents, options);
    if (fault === "forward-after-write" && String(file) === path.join(root, "archive", "note.txt")) process.exit(73);
  }) as typeof fs.writeFileSync;
  fs.rmdirSync = ((directory, options) => {
    rmdir(directory, options);
    if (fault === "recovery-after-directory" && String(directory) === path.join(root, "archive")) process.exit(74);
  }) as typeof fs.rmdirSync;
  if (fault.startsWith("forward")) await host.tasks.execute({ planId: id, digest, approvalReceiptId, idempotencyKey: "crash-child" });
  else await host.tasks.recover({ recoveryId: id, digest, approvalReceiptId });
  host.close(); throw new Error("The requested fault was not reached");
}

const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-task-recovery-"));
let passed = 0;
const fixture = () => {
  const base = fs.mkdtempSync(path.join(parent, "case-")); const root = path.join(base, "files"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "source.txt"), "original bytes\n"); fs.writeFileSync(path.join(root, "keep.txt"), "keep original\n");
  return { root, state: path.join(base, "state"), original: captureTree(root) };
};
const prepare = (host: Host, root: string) => host.tasks.prepare({ skillId: "recovery-fixture", root, goal: { intent: "Create a deterministic recovery fixture", criteria: {} } });
async function test(name: string, action: () => Promise<void>): Promise<void> { await action(); passed++; console.log(`PASS ${name}`); }
function crash(root: string, state: string, id: string, digest: string, approvalReceiptId: string, fault: string): void {
  const result = spawnSync(process.execPath, [import.meta.filename, "--child", root, state, id, digest, approvalReceiptId, fault], { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.error, undefined);
  assert.ok([71, 72, 73, 74, 75].includes(result.status ?? -1), `Expected a deliberate process termination, received ${result.status}: ${result.stderr}`);
}

try {
  await test("verified apply can be undone only after exact recovery approval and restores original identities", async () => {
    const f = fixture(); let host = open(f.root, f.state);
    try {
      const plan = await prepare(host, f.root); const applied = await host.tasks.execute(request(host, plan));
      assert.equal(applied.status, "succeeded"); assert.equal(host.tasks.list().length, 1);
      const recovery = await host.tasks.prepareRecovery(plan.taskId);
      assert.equal(recovery.mode, "undo"); assert.deepEqual(recovery.steps.map((step) => step.kind), ["remove-file", "move", "remove-directory"]);
      assert.equal("approveRecovery" in host.tasks, false);
      await assert.rejects(host.tasks.recover({ recoveryId: recovery.recoveryId, digest: recovery.digest, approvalReceiptId: "forged" }), hasCode("APPROVAL_REQUIRED"));
      assert.throws(() => host.approvals.approveRecovery(recovery.recoveryId, "wrong"), hasCode("DIGEST_MISMATCH"));
      const input = recoveryRequest(host, recovery);
      const restored = await host.tasks.recover(input);
      assert.equal(restored.status, "undone"); assert.equal(restored.rolledBack, 3); assert.equal(restored.recovery?.status, "completed");
      assert.equal(captureTree(f.root).digest, f.original.digest);
      host.close(); host = open(f.root, f.state);
      assert.deepEqual(await host.tasks.recover(input), restored);
      assert.deepEqual(await host.tasks.recover(recoveryRequest(host, recovery)), restored);
      assert.equal(captureTree(f.root).digest, f.original.digest);
      await assert.rejects(host.tasks.prepareRecovery(plan.taskId), hasCode("TASK_ALREADY_RESTORED"));
    } finally { host.close(); }
  });
  await test("cancellation after a move restores only the verified partial prefix", async () => {
    const f = fixture(); const host = open(f.root, f.state); let timer: NodeJS.Immediate | undefined;
    try {
      const plan = await prepare(host, f.root);
      const observe = (): void => {
        if (fs.existsSync(path.join(f.root, "archive", "source.txt"))) host.tasks.cancel(plan.taskId);
        else timer = setImmediate(observe);
      };
      timer = setImmediate(observe);
      const partial = await host.tasks.execute(request(host, plan));
      assert.equal(partial.status, "partial"); assert.equal(partial.journal.length, 2);
      const recovery = await host.tasks.prepareRecovery(plan.taskId); assert.equal(recovery.mode, "restore"); assert.equal(recovery.steps.length, 2);
      const result = await host.tasks.recover(recoveryRequest(host, recovery));
      assert.equal(result.status, "restored"); assert.equal(result.rolledBack, 2); assert.equal(captureTree(f.root).digest, f.original.digest);
    } finally { if (timer) clearImmediate(timer); host.close(); }
  });
  await test("manual modification, an occupied source, or unrelated new files block whole-tree undo", async () => {
    for (const conflict of ["modify", "occupy", "extra"]) {
      const f = fixture(); const host = open(f.root, f.state);
      try {
        const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan));
        const target = conflict === "modify" ? path.join(f.root, "archive", "source.txt") : conflict === "occupy" ? path.join(f.root, "source.txt") : path.join(f.root, "human.txt");
        fs.writeFileSync(target, "human work"); const changed = captureTree(f.root);
        await assert.rejects(host.tasks.prepareRecovery(plan.taskId), hasCode("RECOVERY_CONFLICT"));
        assert.equal(captureTree(f.root).digest, changed.digest); assert.equal(fs.readFileSync(target, "utf8"), "human work");
      } finally { host.close(); }
    }
  });
  await test("changes after recovery approval invalidate it without deleting user work", async () => {
    const f = fixture(); const host = open(f.root, f.state);
    try {
      const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan));
      const recovery = await host.tasks.prepareRecovery(plan.taskId); const input = recoveryRequest(host, recovery);
      fs.writeFileSync(path.join(f.root, "human.txt"), "keep me"); const changed = captureTree(f.root);
      await assert.rejects(host.tasks.recover(input), hasCode("STALE_PLAN"));
      assert.equal(captureTree(f.root).digest, changed.digest); assert.equal(host.tasks.get(plan.taskId).status, "succeeded");
    } finally { host.close(); }
  });
  await test("manual targets inserted during recovery intent commit are never overwritten or removed", async () => {
    for (const conflict of ["move", "remove-file"] as const) {
      const f = fixture(); const host = open(f.root, f.state); const putEffect = TaskStore.prototype.putEffect;
      try {
        const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan));
        const recovery = await host.tasks.prepareRecovery(plan.taskId); const input = recoveryRequest(host, recovery);
        let injected = false;
        TaskStore.prototype.putEffect = function (...args) {
          putEffect.apply(this, args);
          const payload = args[3]; const action = payload.action as { kind: string; path?: string };
          if (!injected && args[0] === recovery.recoveryId && payload.phase === "intent" && action.kind === conflict) {
            injected = true;
            if (conflict === "move") fs.writeFileSync(path.join(f.root, "source.txt"), "manual occupied source", { flag: "wx" });
            else { fs.unlinkSync(action.path!); fs.writeFileSync(action.path!, "manual replacement", { flag: "wx" }); }
          }
        };
        const result = await host.tasks.recover(input);
        assert.equal(injected, true); assert.equal(result.status, "needs_attention");
        if (conflict === "move") {
          assert.equal(fs.readFileSync(path.join(f.root, "source.txt"), "utf8"), "manual occupied source");
          assert.equal(fs.readFileSync(path.join(f.root, "archive", "source.txt"), "utf8"), "original bytes\n");
        } else assert.equal(fs.readFileSync(path.join(f.root, "archive", "note.txt"), "utf8"), "manual replacement");
      } finally { TaskStore.prototype.putEffect = putEffect; host.close(); }
    }
  });
  await test("manual destinations inserted during forward intent commit are preserved", async () => {
    for (const conflict of ["fs.move", "fs.write"] as const) {
      const f = fixture(); const host = open(f.root, f.state); const putEffect = TaskStore.prototype.putEffect;
      try {
        const plan = await prepare(host, f.root); const input = request(host, plan); let injected = false;
        TaskStore.prototype.putEffect = function (...args) {
          putEffect.apply(this, args);
          const payload = args[3]; const action = payload.action as { kind: string; to?: string; path?: string };
          if (!injected && args[0] === `forward:${plan.taskId}` && payload.phase === "intent" && action.kind === conflict) {
            injected = true; fs.writeFileSync(action.to ?? action.path!, "manual destination", { flag: "wx" });
          }
        };
        const result = await host.tasks.execute(input);
        assert.equal(injected, true); assert.equal(result.status, "needs_attention");
        const target = path.join(f.root, "archive", conflict === "fs.move" ? "source.txt" : "note.txt");
        assert.equal(fs.readFileSync(target, "utf8"), "manual destination");
        if (conflict === "fs.move") assert.equal(fs.readFileSync(path.join(f.root, "source.txt"), "utf8"), "original bytes\n");
      } finally { TaskStore.prototype.putEffect = putEffect; host.close(); }
    }
  });
  await test("real process crashes before and after a move are inspected and restored without replay", async () => {
    for (const fault of ["forward-before-move", "forward-after-move"]) {
      const f = fixture(); let host = open(f.root, f.state);
      try {
        const plan = await prepare(host, f.root); const input = request(host, plan); host.close();
        crash(f.root, f.state, plan.planId, plan.digest, input.approvalReceiptId, fault);
        host = open(f.root, f.state); assert.equal(host.tasks.get(plan.taskId).status, "needs_attention");
        const interrupted = captureTree(f.root); await host.tasks.execute(input); assert.equal(captureTree(f.root).digest, interrupted.digest);
        const recovery = await host.tasks.prepareRecovery(plan.taskId);
        assert.equal(recovery.steps.length, fault === "forward-before-move" ? 1 : 2);
        const result = await host.tasks.recover(recoveryRequest(host, recovery));
        assert.equal(result.status, "restored"); assert.equal(captureTree(f.root).digest, f.original.digest);
      } finally { host.close(); }
    }
  });
  await test("new files and directories without durable verified identities are unknown and never guessed away", async () => {
    for (const fault of ["forward-after-write", "forward-after-directory"]) {
      const f = fixture(); let host = open(f.root, f.state);
      try {
        const plan = await prepare(host, f.root); const input = request(host, plan); host.close();
        crash(f.root, f.state, plan.planId, plan.digest, input.approvalReceiptId, fault);
        host = open(f.root, f.state); const interrupted = captureTree(f.root);
        await assert.rejects(host.tasks.prepareRecovery(plan.taskId), hasCode("RECOVERY_EFFECT_UNKNOWN"));
        assert.equal(captureTree(f.root).digest, interrupted.digest);
        assert.equal(fs.existsSync(path.join(f.root, "archive")), true);
        if (fault === "forward-after-write") assert.equal(fs.readFileSync(path.join(f.root, "archive", "note.txt"), "utf8"), "task-created note\n");
        assert.equal(host.tasks.get(plan.taskId).status, "needs_attention");
      } finally { host.close(); }
    }
  });
  await test("recovery interrupted before or after a reverse move or final removal requires a fresh plan", async () => {
    for (const fault of ["recovery-before-move", "recovery-after-move", "recovery-after-directory"]) {
      const f = fixture(); let host = open(f.root, f.state);
      try {
        const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan));
        const first = await host.tasks.prepareRecovery(plan.taskId); const input = recoveryRequest(host, first); host.close();
        crash(f.root, f.state, first.recoveryId, first.digest, input.approvalReceiptId, fault);
        host = open(f.root, f.state); const interrupted = captureTree(f.root);
        assert.equal(host.tasks.get(plan.taskId).status, "needs_attention");
        assert.equal((await host.tasks.recover(input)).status, "needs_attention");
        assert.equal(captureTree(f.root).digest, interrupted.digest);
        const second = await host.tasks.prepareRecovery(plan.taskId);
        assert.notEqual(second.recoveryId, first.recoveryId); assert.equal(second.mode, "undo");
        assert.equal(second.steps.length, fault === "recovery-before-move" ? 2 : fault === "recovery-after-move" ? 1 : 0);
        const result = await host.tasks.recover(recoveryRequest(host, second));
        assert.equal(result.status, "undone"); assert.equal(result.rolledBack, 3); assert.equal(captureTree(f.root).digest, f.original.digest);
      } finally { host.close(); }
    }
  });
  await test("cancel during recovery preserves remaining effects and can be inspected for another recovery", async () => {
    const f = fixture(); const host = open(f.root, f.state); let timer: NodeJS.Immediate | undefined;
    try {
      const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan));
      const recovery = await host.tasks.prepareRecovery(plan.taskId); const input = recoveryRequest(host, recovery);
      const observe = (): void => {
        if (!fs.existsSync(path.join(f.root, "archive", "note.txt"))) host.tasks.cancel(plan.taskId);
        else timer = setImmediate(observe);
      };
      timer = setImmediate(observe);
      const cancelled = await host.tasks.recover(input);
      assert.equal(cancelled.status, "needs_attention"); assert.equal(cancelled.error?.code, "RECOVERY_CANCELLED");
      assert.equal(cancelled.recovery?.completedSteps, 1); assert.equal(fs.existsSync(path.join(f.root, "archive", "source.txt")), true);
      const next = await host.tasks.prepareRecovery(plan.taskId); assert.equal(next.steps.length, 2);
      assert.equal((await host.tasks.recover(recoveryRequest(host, next))).status, "undone");
      assert.equal(captureTree(f.root).digest, f.original.digest);
    } finally { if (timer) clearImmediate(timer); host.close(); }
  });
  await test("old approval cannot authorize another recovery and a second preview becomes stale", async () => {
    const f = fixture(); const host = open(f.root, f.state);
    try {
      const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan));
      const first = await host.tasks.prepareRecovery(plan.taskId); const second = await host.tasks.prepareRecovery(plan.taskId);
      const firstInput = recoveryRequest(host, first);
      await assert.rejects(host.tasks.recover({ ...firstInput, recoveryId: second.recoveryId, digest: second.digest }), hasCode("APPROVAL_REQUIRED"));
      const secondInput = recoveryRequest(host, second);
      await host.tasks.recover(firstInput);
      await assert.rejects(host.tasks.recover(secondInput), hasCode("STALE_RECOVERY"));
      assert.equal(captureTree(f.root).digest, f.original.digest);
    } finally { host.close(); }
  });
  await test("shrinking host permissions blocks recovery and read-only history omits unauthorized roots", async () => {
    const f = fixture(); let host = open(f.root, f.state);
    try {
      const plan = await prepare(host, f.root); await host.tasks.execute(request(host, plan)); host.close();
      const other = path.join(path.dirname(f.root), "other"); fs.mkdirSync(other);
      host = open(other, f.state); assert.deepEqual(host.tasks.list(), []);
      await assert.rejects(host.tasks.prepareRecovery(plan.taskId), hasCode("PERMISSION_DENIED"));
      assert.equal(fs.existsSync(path.join(f.root, "archive", "note.txt")), true);
    } finally { host.close(); }
  });
  await test("version-one stores migrate without dropping task records and unknown checkpoints fail closed", async () => {
    const f = fixture(); let host = open(f.root, f.state);
    try {
      const plan = await prepare(host, f.root); host.close();
      const db = new DatabaseSync(path.join(f.state, "tasks.sqlite"));
      db.exec("DROP TABLE recovery_claims; DROP TABLE recovery_approvals; DROP TABLE recovery_plans; DROP TABLE effects; PRAGMA user_version=1;"); db.close();
      host = open(f.root, f.state); assert.equal(host.tasks.get(plan.taskId).status, "awaiting_approval");
      await host.tasks.execute(request(host, plan));
      const corrupt = new DatabaseSync(path.join(f.state, "tasks.sqlite"));
      corrupt.prepare("UPDATE effects SET checksum='corrupted' WHERE operation_id=? AND step_index=0").run(`forward:${plan.taskId}`); corrupt.close();
      await assert.rejects(host.tasks.prepareRecovery(plan.taskId), hasCode("CORRUPT_STORE"));
      assert.equal(fs.existsSync(path.join(f.root, "archive", "note.txt")), true);
    } finally { host.close(); }
  });
  console.log(`Task recovery checks passed: ${passed}`);
} finally {
  if (path.dirname(path.resolve(parent)) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith("deskshell-task-recovery-")) throw new Error("Unsafe recovery fixture cleanup");
  fs.rmSync(parent, { recursive: true, force: true });
}
