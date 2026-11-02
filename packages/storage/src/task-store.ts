import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Storage only knows JSON, identifiers and the few states needed for durable claims. */
export type JsonObject = Record<string, unknown>;

export interface StoredPlan {
  planId: string;
  digest: string;
  payload: JsonObject;
  createdAt: number;
}

export interface StoredApproval {
  approvalId: string;
  planId: string;
  digest: string;
  payload: JsonObject;
  createdAt: number;
  consumedByTaskId?: string;
}

export interface StoredTask {
  taskId: string;
  planId: string;
  payload: JsonObject;
  createdAt: number;
  updatedAt: number;
}

export class TaskStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

const VERSION = 2;
const APPLICATION_ID = 0x44534831; // DSH1: never adopt an unrelated SQLite database.
const OWN_PID = process.pid;
let ownIdentity: string | undefined;

function fail(code: string, message: string): never {
  throw new TaskStoreError(code, message);
}

function identifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_ARGUMENT", `${name} must be a nonempty string`);
}

/** Refuse lossy serialization (undefined, nonfinite numbers, cycles, class instances). */
function encode(payload: JsonObject): string {
  const active = new Set<object>();
  function visit(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null) fail("INVALID_JSON", "Payload must contain only JSON values");
    if (active.has(value)) fail("INVALID_JSON", "Payload contains a cycle");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.length !== value.length + 1 ||
          ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
          fail("INVALID_JSON", "Sparse or extended arrays are not JSON payloads");
        }
        return value.map(visit);
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail("INVALID_JSON", "Payload must use plain objects");
      if (Object.getOwnPropertySymbols(value).length) fail("INVALID_JSON", "Symbol keys are not JSON payloads");
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, visit((value as JsonObject)[key])]));
    } finally {
      active.delete(value);
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("INVALID_JSON", "Payload must be an object");
  return JSON.stringify(visit(payload));
}

function decode(value: unknown): JsonObject {
  if (typeof value !== "string") fail("CORRUPT_STORE", "Stored payload is not text");
  try {
    const payload = JSON.parse(value) as JsonObject;
    encode(payload);
    return payload;
  } catch {
    return fail("CORRUPT_STORE", "Stored payload is not a valid JSON object");
  }
}

function taskPayload(taskId: string, planId: string, payload: JsonObject): string {
  const json = encode(payload);
  if (typeof payload.status !== "string" || !payload.status) fail("INVALID_TASK", "Task payload requires a status");
  if (payload.taskId !== undefined && payload.taskId !== taskId) fail("INVALID_TASK", "Task payload taskId does not match");
  if (payload.planId !== undefined && payload.planId !== planId) fail("INVALID_TASK", "Task payload planId does not match");
  return json;
}

/** null means confirmed absent; inability to inspect a process is an error, never stale. */
function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return fail("CORRUPT_STORE", "Invalid host PID");
  if (process.platform === "win32") {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // PID is a validated integer. StartTime comes from the OS, not our wall-clock guess.
    const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { $p.StartTime.ToUniversalTime().Ticks.ToString() }`;
    let answer: string;
    try {
      answer = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return fail("HOST_IDENTITY_UNAVAILABLE", `Cannot verify process ${pid} start identity`);
    }
    if (answer === "absent") return null;
    if (!/^\d+$/.test(answer)) return fail("HOST_IDENTITY_UNAVAILABLE", `Invalid process identity for ${pid}`);
    return `windows:${answer}`;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTicks = fields[19]; // field 22; the suffix begins at field 3.
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^\d+$/.test(startTicks ?? "") || !boot) return fail("HOST_IDENTITY_UNAVAILABLE", `Invalid /proc identity for ${pid}`);
      return `linux:${boot}:${startTicks}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(`/proc/${pid}`)) return null;
      return fail("HOST_IDENTITY_UNAVAILABLE", `Cannot verify process ${pid} start identity`);
    }
  }
  // G1 product targets Windows; Linux supports CI. Do not guess PID reuse on other OSes.
  return fail("UNSUPPORTED_HOST_PLATFORM", `TaskStore host identity is not implemented for ${process.platform}`);
}

type Row = Record<string, unknown>;

/**
 * One live process owns a store; that process may open multiple SQLite connections.
 * Claims are durable at-most-once admission, not exactly-once filesystem/UI effects.
 * Storage must reside on a private local disk. It does not sandbox same-account code.
 */
export class TaskStore {
  readonly dataDir: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly identity: string;
  private readonly connectionId = randomUUID();
  private closed = false;

  constructor(dataDir: string) {
    identifier(dataDir, "dataDir");
    ownIdentity ??= processIdentity(OWN_PID) ?? fail("HOST_IDENTITY_UNAVAILABLE", "Current process disappeared");
    this.identity = ownIdentity;
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = path.join(this.dataDir, "tasks.sqlite");
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
      const check = this.db.prepare("PRAGMA quick_check").all();
      if (check.length !== 1 || Object.values(check[0])[0] !== "ok") fail("CORRUPT_STORE", "SQLite integrity check failed");
      this.initialize();
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.acquireHost();
    } catch (error) {
      this.db.close();
      this.closed = true;
      if (error instanceof TaskStoreError) throw error;
      fail("STORE_OPEN_FAILED", `Cannot open task store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private transaction<T>(work: () => T): T {
    if (this.closed) fail("STORE_CLOSED", "Task store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  private initialize(): void {
    this.transaction(() => {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      const applicationId = Number(this.db.prepare("PRAGMA application_id").get()?.application_id);
      if (version === VERSION && applicationId === APPLICATION_ID) return;
      if (version === 1 && applicationId === APPLICATION_ID) {
        const owner = this.db.prepare("SELECT pid,identity FROM host_lock WHERE singleton=1").get();
        if (owner && (Number(owner.pid) !== OWN_PID || owner.identity !== this.identity)
            && processIdentity(Number(owner.pid)) === owner.identity) fail("HOST_IN_USE", "Stop the existing host before upgrading its task store");
        this.createRecoveryTables();
        this.db.exec(`PRAGMA user_version=${VERSION}`);
        return;
      }
      if (version !== 0 || applicationId !== 0) fail("UNSUPPORTED_STORE_VERSION", "Unrecognized task store version or application");
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (tables.length) fail("CORRUPT_STORE", "Refusing to adopt an unversioned database");
      this.db.exec(`
        CREATE TABLE plans (
          plan_id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES plans(plan_id),
          status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE approvals (
          approval_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(plan_id), digest TEXT NOT NULL,
          payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, consumed_by_task_id TEXT REFERENCES tasks(task_id)
        ) STRICT;
        CREATE TABLE claims (
          plan_id TEXT PRIMARY KEY REFERENCES plans(plan_id), task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
          digest TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id), claimed_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE host_lock (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL,
          identity TEXT NOT NULL, acquired_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE host_connections (
          connection_id TEXT PRIMARY KEY, identity TEXT NOT NULL
        ) STRICT;
        PRAGMA application_id=${APPLICATION_ID};
        PRAGMA user_version=${VERSION};
      `);
      this.createRecoveryTables();
    });
  }

  private createRecoveryTables(): void {
    this.db.exec(`
      CREATE TABLE effects (
        operation_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(task_id), step_index INTEGER NOT NULL,
        phase TEXT NOT NULL, payload_json TEXT NOT NULL, checksum TEXT NOT NULL,
        PRIMARY KEY(operation_id,step_index)
      ) STRICT;
      CREATE TABLE recovery_plans (
        recovery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), digest TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE recovery_approvals (
        approval_id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL REFERENCES recovery_plans(recovery_id), digest TEXT NOT NULL,
        payload_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE recovery_claims (
        recovery_id TEXT PRIMARY KEY REFERENCES recovery_plans(recovery_id), task_id TEXT NOT NULL REFERENCES tasks(task_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES recovery_approvals(approval_id), claimed_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  private acquireHost(): void {
    this.transaction(() => {
      const owner = this.db.prepare("SELECT * FROM host_lock WHERE singleton=1").get();
      if (owner) {
        const pid = Number(owner.pid);
        if (typeof owner.identity !== "string" || !owner.identity) fail("CORRUPT_STORE", "Missing host identity");
        if (pid !== OWN_PID || owner.identity !== this.identity) {
          const actual = processIdentity(pid);
          if (actual === owner.identity) fail("HOST_IN_USE", `Task store already belongs to live process ${pid}`);
          // Confirmed absent, or an OS-proven different process that reused the PID.
          this.db.exec("DELETE FROM host_connections; DELETE FROM host_lock;");
        }
      } else if (Number(this.db.prepare("SELECT count(*) AS n FROM host_connections").get()?.n) !== 0) {
        fail("CORRUPT_STORE", "Host connections exist without an owner");
      }
      this.db.prepare("INSERT OR IGNORE INTO host_lock(singleton,pid,identity,acquired_at) VALUES(1,?,?,?)")
        .run(OWN_PID, this.identity, Date.now());
      this.db.prepare("INSERT INTO host_connections(connection_id,identity) VALUES(?,?)").run(this.connectionId, this.identity);
    });
  }

  private assertOwner(): void {
    if (this.closed) fail("STORE_CLOSED", "Task store is closed");
    const owner = this.db.prepare(`SELECT h.pid, h.identity FROM host_lock h JOIN host_connections c
      ON c.identity=h.identity WHERE h.singleton=1 AND c.connection_id=?`).get(this.connectionId);
    if (!owner || Number(owner.pid) !== OWN_PID || owner.identity !== this.identity) fail("HOST_LOCK_LOST", "Task store ownership was lost");
  }

  private plan(row: Row): StoredPlan {
    return { planId: String(row.plan_id), digest: String(row.digest), payload: decode(row.payload_json), createdAt: Number(row.created_at) };
  }

  private approval(row: Row): StoredApproval {
    return {
      approvalId: String(row.approval_id), planId: String(row.plan_id), digest: String(row.digest),
      payload: decode(row.payload_json), createdAt: Number(row.created_at),
      ...(row.consumed_by_task_id === null ? {} : { consumedByTaskId: String(row.consumed_by_task_id) }),
    };
  }

  private task(row: Row): StoredTask {
    const payload = decode(row.payload_json);
    if (payload.status !== row.status || (payload.taskId !== undefined && payload.taskId !== row.task_id) ||
      (payload.planId !== undefined && payload.planId !== row.plan_id)) fail("CORRUPT_STORE", "Task columns disagree with payload");
    return { taskId: String(row.task_id), planId: String(row.plan_id), payload,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  putPlan(planId: string, digest: string, payload: JsonObject, initialTask?: { taskId: string; payload: JsonObject }): void {
    identifier(planId, "planId");
    identifier(digest, "digest");
    const json = encode(payload);
    if (initialTask) {
      identifier(initialTask.taskId, "taskId");
      taskPayload(initialTask.taskId, planId, initialTask.payload);
    }
    this.transaction(() => {
      this.assertOwner();
      const existing = this.db.prepare("SELECT * FROM plans WHERE plan_id=?").get(planId);
      if (existing) {
        if (existing.digest !== digest || existing.payload_json !== json) fail("PLAN_IMMUTABLE", `Plan ${planId} already has different content`);
      } else {
        this.db.prepare("INSERT INTO plans(plan_id,digest,payload_json,created_at) VALUES(?,?,?,?)").run(planId, digest, json, Date.now());
      }
      if (initialTask) this.insertTask(initialTask.taskId, planId, initialTask.payload);
    });
  }

  getPlan(planId: string): StoredPlan | undefined {
    this.assertOwner();
    const row = this.db.prepare("SELECT * FROM plans WHERE plan_id=?").get(planId);
    return row ? this.plan(row) : undefined;
  }

  private insertTask(taskId: string, planId: string, payload: JsonObject): StoredTask {
    identifier(taskId, "taskId");
    identifier(planId, "planId");
    const json = taskPayload(taskId, planId, payload);
    if (!this.db.prepare("SELECT 1 FROM plans WHERE plan_id=?").get(planId)) fail("PLAN_NOT_FOUND", `Plan ${planId} not found`);
    const existing = this.db.prepare("SELECT * FROM tasks WHERE task_id=? OR plan_id=?").get(taskId, planId);
    if (existing) {
      if (existing.task_id !== taskId || existing.plan_id !== planId) fail("TASK_CONFLICT", "Task or plan is already associated with another identifier");
      return this.task(existing); // Never reset a task that has progressed.
    }
    const now = Date.now();
    this.db.prepare("INSERT INTO tasks(task_id,plan_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(taskId, planId, String(payload.status), json, now, now);
    return { taskId, planId, payload: decode(json), createdAt: now, updatedAt: now };
  }

  createTask(taskId: string, planId: string, payload: JsonObject): StoredTask {
    return this.transaction(() => { this.assertOwner(); return this.insertTask(taskId, planId, payload); });
  }

  approve(approvalId: string, planId: string, digest: string, payload: JsonObject): void {
    identifier(approvalId, "approvalId");
    const json = encode(payload);
    this.transaction(() => {
      this.assertOwner();
      const plan = this.db.prepare("SELECT digest FROM plans WHERE plan_id=?").get(planId);
      if (!plan) fail("PLAN_NOT_FOUND", `Plan ${planId} not found`);
      if (plan.digest !== digest) fail("DIGEST_MISMATCH", "Approval digest does not match plan");
      const existing = this.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(approvalId);
      if (existing) {
        if (existing.plan_id !== planId || existing.digest !== digest || existing.payload_json !== json) {
          fail("APPROVAL_IMMUTABLE", "Approval identifier already has different content");
        }
        return;
      }
      this.db.prepare("INSERT INTO approvals(approval_id,plan_id,digest,payload_json,created_at) VALUES(?,?,?,?,?)")
        .run(approvalId, planId, digest, json, Date.now());
    });
  }

  getApproval(approvalId: string): StoredApproval | undefined {
    this.assertOwner();
    const row = this.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(approvalId);
    return row ? this.approval(row) : undefined;
  }

  claim(planId: string, digest: string, approvalId: string, taskId: string, payload: JsonObject): { claimed: boolean; task: StoredTask } {
    const json = taskPayload(taskId, planId, payload);
    if (payload.status !== "running") fail("INVALID_TASK_STATUS", "Claim payload must enter running");
    return this.transaction(() => {
      this.assertOwner();
      const plan = this.db.prepare("SELECT * FROM plans WHERE plan_id=?").get(planId);
      if (!plan) fail("PLAN_NOT_FOUND", `Plan ${planId} not found`);
      this.plan(plan); // Also fail closed on corrupted persisted JSON.
      if (plan.digest !== digest) fail("DIGEST_MISMATCH", "Claim digest does not match plan");
      const approval = this.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(approvalId);
      if (!approval || approval.plan_id !== planId || approval.digest !== digest) fail("APPROVAL_MISMATCH", "Claim requires an approval for this plan and digest");
      this.approval(approval);
      const existingClaim = this.db.prepare("SELECT * FROM claims WHERE plan_id=?").get(planId);
      if (existingClaim) {
        const task = this.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(existingClaim.task_id as string);
        if (!task) fail("CORRUPT_STORE", "Claim has no task");
        return { claimed: false, task: this.task(task) };
      }
      if (approval.consumed_by_task_id !== null) fail("APPROVAL_CONSUMED", "Approval was already consumed");
      const task = this.db.prepare("SELECT * FROM tasks WHERE task_id=? AND plan_id=?").get(taskId, planId);
      if (!task) fail("TASK_NOT_FOUND", "Prepare must persist the task before execution");
      this.task(task);
      if (task.status !== "awaiting_approval" && task.status !== "ready") fail("TASK_NOT_EXECUTABLE", `Cannot claim a ${task.status} task`);
      const now = Date.now();
      this.db.prepare("INSERT INTO claims(plan_id,task_id,digest,approval_id,claimed_at) VALUES(?,?,?,?,?)")
        .run(planId, taskId, digest, approvalId, now);
      const consumed = this.db.prepare("UPDATE approvals SET consumed_by_task_id=? WHERE approval_id=? AND consumed_by_task_id IS NULL")
        .run(taskId, approvalId);
      if (Number(consumed.changes) !== 1) fail("APPROVAL_CONSUMED", "Approval consumption failed");
      this.db.prepare("UPDATE tasks SET status='running',payload_json=?,updated_at=? WHERE task_id=?").run(json, now, taskId);
      return { claimed: true, task: { taskId, planId, payload: decode(json), createdAt: Number(task.created_at), updatedAt: now } };
    });
  }

  getTask(taskId: string): StoredTask | undefined {
    this.assertOwner();
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId);
    return row ? this.task(row) : undefined;
  }

  listTasks(): StoredTask[] {
    this.assertOwner();
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at,task_id").all().map((row) => this.task(row));
  }

  updateTask(taskId: string, payload: JsonObject, expectedStatuses?: string[]): StoredTask {
    return this.transaction(() => {
      this.assertOwner();
      const row = this.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId);
      if (!row) fail("TASK_NOT_FOUND", `Task ${taskId} not found`);
      const current = this.task(row);
      if (expectedStatuses && !expectedStatuses.includes(String(current.payload.status))) fail("TASK_STATE_CONFLICT", `Task is ${current.payload.status}`);
      const json = taskPayload(taskId, current.planId, payload);
      const now = Date.now();
      this.db.prepare("UPDATE tasks SET status=?,payload_json=?,updated_at=? WHERE task_id=?")
        .run(String(payload.status), json, now, taskId);
      return { ...current, payload: decode(json), updatedAt: now };
    });
  }

  /** WAL/FULL commit precedes the filesystem effect; intent is never evidence of completion. */
  putEffect(operationId: string, taskId: string, index: number, payload: JsonObject): void {
    identifier(operationId, "operationId"); identifier(taskId, "taskId");
    if (!Number.isSafeInteger(index) || index < 0 || !["intent", "verified", "not_applied"].includes(String(payload.phase))) fail("INVALID_EFFECT", "Invalid effect checkpoint");
    const json = encode(payload); const checksum = createHash("sha256").update(json).digest("hex");
    this.transaction(() => {
      this.assertOwner();
      const existing = this.db.prepare("SELECT * FROM effects WHERE operation_id=? AND step_index=?").get(operationId, index);
      if (existing) {
        if (existing.task_id !== taskId) fail("INVALID_EFFECT", "Effect task cannot change");
        if (existing.payload_json === json && existing.checksum === checksum) return;
        if (existing.phase !== "intent" || payload.phase === "intent") fail("EFFECT_IMMUTABLE", "Only an intent can be resolved");
        const previous = decode(existing.payload_json);
        const { phase: _oldPhase, after: _oldAfter, resolvedAt: _oldResolvedAt, ...oldIntent } = previous;
        const { phase: _newPhase, after: _newAfter, resolvedAt: _newResolvedAt, ...newIntent } = payload;
        if (encode(oldIntent) !== encode(newIntent)) fail("EFFECT_IMMUTABLE", "Resolving an intent cannot change its action or before state");
        this.db.prepare("UPDATE effects SET phase=?,payload_json=?,checksum=? WHERE operation_id=? AND step_index=?").run(String(payload.phase), json, checksum, operationId, index);
      } else {
        if (payload.phase !== "intent") fail("INVALID_EFFECT", "An effect must start as an intent");
        this.db.prepare("INSERT INTO effects(operation_id,task_id,step_index,phase,payload_json,checksum) VALUES(?,?,?,?,?,?)")
          .run(operationId, taskId, index, String(payload.phase), json, checksum);
      }
    });
  }

  effects(operationId: string): JsonObject[] {
    this.assertOwner();
    return this.db.prepare("SELECT * FROM effects WHERE operation_id=? ORDER BY step_index").all(operationId).map((row) => {
      const json = String(row.payload_json);
      if (createHash("sha256").update(json).digest("hex") !== row.checksum) fail("CORRUPT_STORE", "Effect checksum failed");
      const value = decode(json);
      if (value.phase !== row.phase || value.operationId !== row.operation_id || value.taskId !== row.task_id || value.index !== row.step_index) fail("CORRUPT_STORE", "Effect fields disagree with columns");
      return value;
    });
  }

  putRecovery(recoveryId: string, taskId: string, digest: string, payload: JsonObject): void {
    const json = encode(payload);
    this.transaction(() => {
      this.assertOwner();
      const existing = this.db.prepare("SELECT * FROM recovery_plans WHERE recovery_id=?").get(recoveryId);
      if (existing) {
        if (existing.task_id !== taskId || existing.digest !== digest || existing.payload_json !== json) fail("PLAN_IMMUTABLE", "Recovery plan is immutable");
        return;
      }
      this.db.prepare("INSERT INTO recovery_plans(recovery_id,task_id,digest,payload_json,created_at) VALUES(?,?,?,?,?)")
        .run(recoveryId, taskId, digest, json, Date.now());
    });
  }

  getRecovery(recoveryId: string): { recoveryId: string; taskId: string; digest: string; payload: JsonObject } | undefined {
    this.assertOwner();
    const row = this.db.prepare("SELECT * FROM recovery_plans WHERE recovery_id=?").get(recoveryId);
    return row ? { recoveryId, taskId: String(row.task_id), digest: String(row.digest), payload: decode(row.payload_json) } : undefined;
  }

  claimedRecoveries(taskId: string): string[] {
    this.assertOwner();
    return this.db.prepare("SELECT recovery_id FROM recovery_claims WHERE task_id=? ORDER BY rowid").all(taskId).map((row) => String(row.recovery_id));
  }

  approveRecovery(approvalId: string, recoveryId: string, digest: string, payload: JsonObject): void {
    const json = encode(payload);
    this.transaction(() => {
      this.assertOwner();
      const plan = this.db.prepare("SELECT digest FROM recovery_plans WHERE recovery_id=?").get(recoveryId);
      if (!plan || plan.digest !== digest) fail("DIGEST_MISMATCH", "Recovery approval must match a stored plan");
      const existing = this.db.prepare("SELECT * FROM recovery_approvals WHERE approval_id=?").get(approvalId);
      if (existing) {
        if (existing.recovery_id !== recoveryId || existing.digest !== digest || existing.payload_json !== json) fail("APPROVAL_IMMUTABLE", "Recovery approval is immutable");
        return;
      }
      this.db.prepare("INSERT INTO recovery_approvals(approval_id,recovery_id,digest,payload_json) VALUES(?,?,?,?)").run(approvalId, recoveryId, digest, json);
    });
  }

  getRecoveryApproval(approvalId: string): { recoveryId: string; digest: string; payload: JsonObject } | undefined {
    this.assertOwner();
    const row = this.db.prepare("SELECT * FROM recovery_approvals WHERE approval_id=?").get(approvalId);
    return row ? { recoveryId: String(row.recovery_id), digest: String(row.digest), payload: decode(row.payload_json) } : undefined;
  }

  claimRecovery(recoveryId: string, digest: string, approvalId: string, taskId: string, payload: JsonObject): { claimed: boolean; task: StoredTask } {
    return this.transaction(() => {
      this.assertOwner();
      const plan = this.db.prepare("SELECT * FROM recovery_plans WHERE recovery_id=?").get(recoveryId);
      if (!plan || plan.digest !== digest || plan.task_id !== taskId) fail("DIGEST_MISMATCH", "Recovery claim must match its plan and task");
      const approval = this.db.prepare("SELECT * FROM recovery_approvals WHERE approval_id=?").get(approvalId);
      if (!approval || approval.recovery_id !== recoveryId || approval.digest !== digest) fail("APPROVAL_MISMATCH", "Matching recovery approval required");
      const task = this.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId);
      if (!task) fail("TASK_NOT_FOUND", "Recovery task is missing");
      const current = this.task(task);
      if (this.db.prepare("SELECT 1 FROM recovery_claims WHERE recovery_id=?").get(recoveryId)) return { claimed: false, task: current };
      if (approval.consumed !== 0) fail("APPROVAL_CONSUMED", "Recovery approval was consumed");
      if (!["succeeded", "partial", "needs_attention", "cancelled"].includes(String(current.payload.status)) || payload.status !== "recovering") fail("TASK_NOT_EXECUTABLE", "Task cannot enter recovery");
      const json = taskPayload(taskId, current.planId, payload); const now = Date.now();
      this.db.prepare("INSERT INTO recovery_claims(recovery_id,task_id,approval_id,claimed_at) VALUES(?,?,?,?)").run(recoveryId, taskId, approvalId, now);
      this.db.prepare("UPDATE recovery_approvals SET consumed=1 WHERE approval_id=?").run(approvalId);
      this.db.prepare("UPDATE tasks SET status='recovering',payload_json=?,updated_at=? WHERE task_id=?").run(json, now, taskId);
      return { claimed: true, task: { ...current, payload: decode(json), updatedAt: now } };
    });
  }

  /** Explicit startup operation. Opening a second same-host connection does not call it. */
  recoverInterrupted(): StoredTask[] {
    return this.transaction(() => {
      this.assertOwner();
      const rows = this.db.prepare("SELECT * FROM tasks WHERE status IN ('running','cancelling','recovering') ORDER BY created_at,task_id").all();
      return rows.map((row) => {
        const current = this.task(row);
        const now = Date.now();
        const payload = { ...current.payload, status: "needs_attention", updatedAt: now,
          ...(current.payload.recovery ? { recovery: { ...(current.payload.recovery as JsonObject), status: "needs_attention" } } : {}),
          error: { code: "INTERRUPTED", message: "Previous execution was interrupted; effects require inspection before further action." } };
        this.db.prepare("UPDATE tasks SET status='needs_attention',payload_json=?,updated_at=? WHERE task_id=?")
          .run(encode(payload), now, current.taskId);
        return { ...current, payload, updatedAt: now };
      });
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.transaction(() => {
        this.assertOwner();
        this.db.prepare("DELETE FROM host_connections WHERE connection_id=?").run(this.connectionId);
        if (Number(this.db.prepare("SELECT count(*) AS n FROM host_connections").get()?.n) === 0) {
          this.db.prepare("DELETE FROM host_lock WHERE singleton=1 AND pid=? AND identity=?").run(OWN_PID, this.identity);
        }
      });
    } finally {
      this.closed = true;
      this.db.close();
    }
  }
}
