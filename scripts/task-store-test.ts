import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { TaskStore, TaskStoreError, type JsonObject } from "../packages/storage/src/task-store.ts";

function payload(taskId: string, planId: string, status = "awaiting_approval"): JsonObject {
  return { taskId, planId, status, steps: [], journal: [], rolledBack: 0, createdAt: 100, updatedAt: 100,
    extra: { text: "中文 payload", values: [null, true, 3, { nested: "kept" }] } };
}

function prepare(store: TaskStore, suffix: string, status = "awaiting_approval") {
  const planId = `plan-${suffix}`;
  const taskId = `task-${suffix}`;
  const digest = `digest-${suffix}`;
  const approvalId = `approval-${suffix}`;
  store.putPlan(planId, digest, { taskId, actions: [{ kind: "fixture", text: "原始内容" }] },
    { taskId, payload: payload(taskId, planId, status) });
  store.approve(approvalId, planId, digest, { planId, digest, expiresAt: 9999999999999, source: { channel: "test" } });
  return { planId, taskId, digest, approvalId };
}

function expectCode(code: string) {
  return (error: unknown) => error instanceof TaskStoreError && error.code === code;
}

// Workers are connections in the same owning process, so they can contend for one claim.
if (!isMainThread) {
  const store = new TaskStore(workerData.dir as string);
  parentPort!.postMessage({ ready: true });
  parentPort!.once("message", () => {
    try {
      const { planId, taskId, digest, approvalId } = workerData;
      const result = store.claim(planId, digest, approvalId, taskId, payload(taskId, planId, "running"));
      parentPort!.postMessage({ claimed: result.claimed, taskId: result.task.taskId });
    } catch (error) {
      parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
      parentPort!.close();
    }
  });
} else if (process.argv[2] === "--probe-owner") {
  try {
    const store = new TaskStore(process.argv[3]);
    store.close();
    console.log(JSON.stringify({ opened: true }));
  } catch (error) {
    console.log(JSON.stringify({ code: error instanceof TaskStoreError ? error.code : "unexpected" }));
  }
} else if (process.argv[2] === "--crash-owner") {
  const store = new TaskStore(process.argv[3]);
  prepare(store, "running", "running");
  prepare(store, "cancelling", "cancelling");
  prepare(store, "ready", "ready");
  console.log("persisted");
  // Deliberately leave ownership rows behind, as an abruptly terminated process does.
  process.exit(0);
} else {
  const parent = path.resolve(os.tmpdir());
  const base = fs.mkdtempSync(path.join(parent, "deskshell-task-store-"));
  const results: string[] = [];
  const dir = (name: string) => path.join(base, name);
  async function check(name: string, work: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await work();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  try {
    await check("plan 与初始 task 同事务完整保存 JSON，计划不可变", () => {
      const store = new TaskStore(dir("plan"));
      try {
        const ids = prepare(store, "one");
        assert.deepEqual(store.getTask(ids.taskId)?.payload, payload(ids.taskId, ids.planId));
        assert.deepEqual(store.getPlan(ids.planId)?.payload.actions, [{ kind: "fixture", text: "原始内容" }]);
        assert.throws(() => store.putPlan(ids.planId, "changed", {}), expectCode("PLAN_IMMUTABLE"));
        assert.throws(() => store.putPlan("new-plan", "digest", {}, { taskId: ids.taskId, payload: { status: "ready" } }), expectCode("TASK_CONFLICT"));
        assert.equal(store.getPlan("new-plan"), undefined, "failed initial task must roll back the plan too");
      } finally { store.close(); }
    });

    await check("JSON 不可序列化内容被拒绝且不丢字段", () => {
      const store = new TaskStore(dir("json"));
      try {
        for (const invalid of [{ value: undefined }, { value: NaN }, { value: new Date() }, { value: 1n }]) {
          assert.throws(() => store.putPlan("bad", "d", invalid), expectCode("INVALID_JSON"));
        }
        const cycle: JsonObject = {};
        cycle.self = cycle;
        assert.throws(() => store.putPlan("bad", "d", cycle), expectCode("INVALID_JSON"));
        const sparse = new Array(1) as unknown[] & { extra?: string };
        sparse.extra = "must not disappear";
        const extended = ["value"];
        Object.defineProperty(extended, Symbol("hidden"), { value: "must not disappear" });
        for (const value of [sparse, extended]) {
          assert.throws(() => store.putPlan("bad", "d", { value }), expectCode("INVALID_JSON"));
        }
        assert.equal(store.getPlan("bad"), undefined);
      } finally { store.close(); }
    });

    await check("claim 原子消费批准并升级已有 task，重复请求不重置状态", () => {
      const store = new TaskStore(dir("claim"));
      try {
        const ids = prepare(store, "one");
        const first = store.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, payload(ids.taskId, ids.planId, "running"));
        assert.equal(first.claimed, true);
        assert.equal(store.getApproval(ids.approvalId)?.consumedByTaskId, ids.taskId);
        store.updateTask(ids.taskId, { ...first.task.payload, status: "succeeded", result: "kept" }, ["running"]);
        const repeated = store.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, payload(ids.taskId, ids.planId, "running"));
        assert.equal(repeated.claimed, false);
        assert.equal(repeated.task.payload.status, "succeeded");
        assert.equal(repeated.task.payload.result, "kept");
        store.approve("another-approval", ids.planId, ids.digest, { approved: true });
        assert.equal(store.claim(ids.planId, ids.digest, "another-approval", "another-task", payload("another-task", ids.planId, "running")).claimed, false);
        assert.equal(store.getApproval("another-approval")?.consumedByTaskId, undefined);
      } finally { store.close(); }
    });

    await check("不匹配 digest 或批准不能认领，取消任务不消费批准", () => {
      const store = new TaskStore(dir("reject"));
      try {
        const ids = prepare(store, "one");
        const other = prepare(store, "other");
        const running = payload(ids.taskId, ids.planId, "running");
        assert.throws(() => store.claim(ids.planId, "wrong", ids.approvalId, ids.taskId, running), expectCode("DIGEST_MISMATCH"));
        assert.throws(() => store.claim(ids.planId, ids.digest, other.approvalId, ids.taskId, running), expectCode("APPROVAL_MISMATCH"));
        store.updateTask(ids.taskId, payload(ids.taskId, ids.planId, "cancelled"), ["awaiting_approval"]);
        assert.throws(() => store.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, running), expectCode("TASK_NOT_EXECUTABLE"));
        assert.equal(store.getApproval(ids.approvalId)?.consumedByTaskId, undefined);
        assert.equal(store.getTask(ids.taskId)?.payload.status, "cancelled");
      } finally { store.close(); }
    });

    await check("task 更新支持状态 CAS，create 重试不重置进度", () => {
      const store = new TaskStore(dir("cas"));
      try {
        const ids = prepare(store, "one");
        store.updateTask(ids.taskId, payload(ids.taskId, ids.planId, "ready"), ["awaiting_approval"]);
        assert.throws(() => store.updateTask(ids.taskId, payload(ids.taskId, ids.planId, "cancelled"), ["awaiting_approval"]), expectCode("TASK_STATE_CONFLICT"));
        assert.equal(store.createTask(ids.taskId, ids.planId, payload(ids.taskId, ids.planId)).payload.status, "ready");
        assert.equal(store.getTask(ids.taskId)?.payload.status, "ready");
      } finally { store.close(); }
    });

    await check("两个并发 SQLite 连接只认领一次", async () => {
      const store = new TaskStore(dir("parallel"));
      const workers: Worker[] = [];
      try {
        const ids = prepare(store, "one");
        const ready: Array<Promise<void>> = [];
        const outcomes: Array<Promise<{ claimed: boolean; taskId: string }>> = [];
        const exits: Array<Promise<void>> = [];
        for (let i = 0; i < 2; i++) {
          const worker = new Worker(new URL(import.meta.url), { workerData: { dir: dir("parallel"), ...ids } });
          workers.push(worker);
          exits.push(new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
          }));
          ready.push(new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.once("message", (message) => message.ready ? resolve() : reject(new Error("worker did not open")));
          }));
          outcomes.push(new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.on("message", (message) => {
              if (message.error) reject(new Error(message.error));
              else if (typeof message.claimed === "boolean") resolve(message);
            });
          }));
        }
        await Promise.all(ready);
        workers.forEach((worker) => worker.postMessage("claim"));
        const claims = await Promise.all(outcomes);
        assert.equal(claims.filter((r) => r.claimed).length, 1);
        assert.ok(claims.every((r) => r.taskId === ids.taskId));
        assert.equal(store.getApproval(ids.approvalId)?.consumedByTaskId, ids.taskId);
        await Promise.all(exits);
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        store.close();
      }
    });

    await check("关闭并重开后 claim 与批准消费仍然唯一", () => {
      let store = new TaskStore(dir("reopen"));
      try {
        const ids = prepare(store, "one");
        store.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, payload(ids.taskId, ids.planId, "running"));
        store.close();
        store = new TaskStore(dir("reopen"));
        assert.equal(store.getTask(ids.taskId)?.payload.status, "running", "constructor must not recover automatically");
        const interrupted = store.recoverInterrupted();
        assert.equal(interrupted.length, 1);
        assert.equal(interrupted[0].payload.status, "needs_attention");
        assert.equal((interrupted[0].payload.error as JsonObject).code, "INTERRUPTED");
        assert.equal(store.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, payload(ids.taskId, ids.planId, "running")).claimed, false);
        assert.equal(store.getTask(ids.taskId)?.payload.status, "needs_attention");
        assert.equal(store.recoverInterrupted().length, 0);
      } finally { store.close(); }
    });

    await check("同进程多连接不自动恢复，关闭一条连接仍阻止第二宿主", () => {
      const first = new TaskStore(dir("host"));
      const second = new TaskStore(dir("host"));
      try {
        const ids = prepare(first, "one");
        first.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, payload(ids.taskId, ids.planId, "running"));
        assert.equal(second.getTask(ids.taskId)?.payload.status, "running");
        first.close();
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--probe-owner", dir("host")],
          { encoding: "utf8", timeout: 30_000, windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout.trim()).code, "HOST_IN_USE");
        assert.equal(second.getTask(ids.taskId)?.payload.status, "running");
      } finally { first.close(); second.close(); }
    });

    await check("死亡宿主锁可收回，running/cancelling 标需核查但不重放", () => {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash-owner", dir("crash")],
        { encoding: "utf8", timeout: 30_000, windowsHide: true });
      assert.equal(child.status, 0, child.stderr);
      const store = new TaskStore(dir("crash"));
      try {
        assert.equal(store.getTask("task-running")?.payload.status, "running");
        const recovered = store.recoverInterrupted();
        assert.equal(recovered.length, 2);
        for (const task of recovered) {
          assert.equal(task.payload.status, "needs_attention");
          assert.equal((task.payload.error as JsonObject).code, "INTERRUPTED");
          assert.deepEqual(task.payload.extra, payload(task.taskId, task.planId).extra);
          assert.deepEqual(task.payload.steps, []);
        }
        assert.equal(store.getTask("task-ready")?.payload.status, "ready");
        assert.equal(store.listTasks().length, 3);
      } finally { store.close(); }
    });

    await check("PID 相同但 OS 启动身份不同的历史锁不会误判成当前宿主", () => {
      const location = dir("pid-reuse");
      const old = new TaskStore(location);
      const database = old.databasePath;
      old.close();
      const db = new DatabaseSync(database);
      try {
        db.prepare("INSERT INTO host_lock(singleton,pid,identity,acquired_at) VALUES(1,?,?,?)").run(process.pid, "different-os-start-identity", 1);
        db.prepare("INSERT INTO host_connections(connection_id,identity) VALUES(?,?)").run("old", "different-os-start-identity");
      } finally { db.close(); }
      const store = new TaskStore(location);
      store.close();
    });

    await check("损坏数据库或未知 schema 拒绝打开，不删除或重建", () => {
      const broken = dir("broken");
      fs.mkdirSync(broken);
      const database = path.join(broken, "tasks.sqlite");
      const bytes = Buffer.from("not a sqlite database\n");
      fs.writeFileSync(database, bytes);
      assert.throws(() => new TaskStore(broken));
      assert.deepEqual(fs.readFileSync(database), bytes);

      const future = dir("future");
      const store = new TaskStore(future);
      store.close();
      const db = new DatabaseSync(path.join(future, "tasks.sqlite"));
      db.exec("PRAGMA user_version=99");
      db.close();
      assert.throws(() => new TaskStore(future), expectCode("UNSUPPORTED_STORE_VERSION"));
    });

    await check("损坏 JSON 拒绝 claim，批准不被消费", () => {
      const store = new TaskStore(dir("corrupt-json"));
      try {
        const ids = prepare(store, "one");
        const db = new DatabaseSync(store.databasePath);
        db.prepare("UPDATE plans SET payload_json=? WHERE plan_id=?").run("{broken", ids.planId);
        db.close();
        assert.throws(() => store.claim(ids.planId, ids.digest, ids.approvalId, ids.taskId, payload(ids.taskId, ids.planId, "running")), expectCode("CORRUPT_STORE"));
        assert.equal(store.getApproval(ids.approvalId)?.consumedByTaskId, undefined);
        assert.equal(store.getTask(ids.taskId)?.payload.status, "awaiting_approval");
      } finally { store.close(); }
    });
  } finally {
    const resolved = path.resolve(base);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("deskshell-task-store-")) throw new Error("Unexpected cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
    console.log(results.join("\n"));
    console.log(`${results.filter((line) => line.startsWith("PASS")).length}/${results.length} passed`);
  }
}
