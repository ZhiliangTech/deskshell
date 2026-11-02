import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { ACTION_CANCELLED_DETAIL, runActions } from "../../core/src/kernel.ts";
import { checkCapabilities, isInside } from "../../core/src/policy.ts";
import { load } from "../../core/src/journal.ts";
import { TaskStore } from "../../storage/src/task-store.ts";
import { afterFileAction, assertUnchanged, captureTree, compileFilePlan } from "./file-plan.ts";
import { createRecoveryController } from "./recovery.ts";
import type { ApprovalReceipt, ExecuteRequest, JsonValue, PreparedPlan, RecoveryApprovalReceipt, SkillRegistration, TaskHostOptions, TaskRequest, TaskResult, TaskService } from "./types.ts";

export class TaskError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "TaskError"; this.code = code; }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TaskError("INVALID_DATA", "Only finite JSON data is accepted");
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768) throw new TaskError("INVALID_REQUEST", `${label} must be a non-empty bounded string`);
}
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TaskError("INVALID_REQUEST", "Unexpected request fields");
  }
}
function planDigest(plan: PreparedPlan): string { const { digest: _, ...body } = plan; return hash(body); }
function readJournal(file: string) {
  return load(file).map((entry) => {
    const exposed = { ...entry } as typeof entry & { __file?: string };
    delete exposed.__file;
    return exposed;
  });
}
function identity(registration: SkillRegistration): string {
  const revision = registration.revision(); text(revision, "skill revision");
  return hash({ revision, manifest: copy(registration.skill.manifest), validator: { id: registration.validator.id, version: registration.validator.version } });
}

const liveHosts = new Set<string>();

/**
 * Embedded, single-owner G1 host. Only `tasks` may be given to an untrusted caller;
 * the creator retains `approvals`. This is not an IPC authentication mechanism.
 */
export function createTaskHost(options: TaskHostOptions): {
  tasks: TaskService;
  approvals: { approve(planId: string, digest: string): ApprovalReceipt; approveRecovery(recoveryId: string, digest: string): RecoveryApprovalReceipt };
  close(): void;
} {
  if (!isMainThread) throw new TaskError("INVALID_CONFIG", "TaskHost must be owned by the main host thread");
  const grants = [...options.granted];
  if (!grants.includes("fs.read")) throw new TaskError("PERMISSION_DENIED", "File snapshots require an explicit fs.read grant");
  const roots = options.allowedRoots.map((root) => fs.realpathSync.native(path.resolve(root)));
  if (!roots.length) throw new TaskError("INVALID_CONFIG", "At least one allowed root is required");
  if (roots.some((root) => isInside(root, path.resolve(options.dataDir)) || isInside(path.resolve(options.dataDir), root))) {
    throw new TaskError("INVALID_CONFIG", "Host storage and task roots must be disjoint");
  }
  fs.mkdirSync(path.resolve(options.dataDir), { recursive: true, mode: 0o700 });
  const dataDir = fs.realpathSync.native(path.resolve(options.dataDir));
  if (roots.some((root) => isInside(root, dataDir) || isInside(dataDir, root))) {
    throw new TaskError("INVALID_CONFIG", "Host storage and task roots must be disjoint");
  }
  const hostKey = process.platform === "win32" ? dataDir.toLowerCase() : dataDir;
  if (liveHosts.has(hostKey)) throw new TaskError("HOST_BUSY", "This data directory already has a host in this process");
  const ttl = options.planTtlMs ?? 10 * 60_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 60 * 60_000) throw new TaskError("INVALID_CONFIG", "Invalid plan lifetime");
  const registry = new Map<string, SkillRegistration>();
  for (const registration of options.skills) {
    text(registration.skill.manifest.name, "skill name");
    text(registration.validator.id, "validator id"); text(registration.validator.version, "validator version");
    if (registry.has(registration.skill.manifest.name)) throw new TaskError("INVALID_CONFIG", "Duplicate skill registration");
    registry.set(registration.skill.manifest.name, registration);
  }
  const store = new TaskStore(dataDir);
  try { store.recoverInterrupted(); } catch (error) { store.close(); throw error; }
  liveHosts.add(hostKey);
  let closed = false;
  let queued = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const controllers = new Map<string, AbortController>();
  const ensureOpen = (): void => { if (closed) throw new TaskError("HOST_CLOSED", "The task host is closed"); };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    ensureOpen(); queued++;
    const result = queue.then(operation).finally(() => { queued--; });
    queue = result.catch(() => undefined);
    return result;
  };
  const get = (taskId: string): TaskResult => {
    ensureOpen(); text(taskId, "taskId"); const record = store.getTask(taskId);
    if (!record) throw new TaskError("TASK_NOT_FOUND", "Unknown task");
    return copy(record.payload as unknown as TaskResult);
  };
  const inspect = (planId: string): PreparedPlan => {
    ensureOpen(); text(planId, "planId"); const record = store.getPlan(planId);
    if (!record) throw new TaskError("PLAN_NOT_FOUND", "Unknown plan");
    const plan = copy(record.payload as unknown as PreparedPlan);
    if (plan.planId !== planId || plan.digest !== record.digest || planDigest(plan) !== record.digest) throw new TaskError("CORRUPT_PLAN", "Stored plan integrity check failed");
    return plan;
  };
  const save = (result: TaskResult): TaskResult => {
    result.updatedAt = Date.now(); store.updateTask(result.taskId, copy(result) as unknown as Record<string, unknown>); return copy(result);
  };
  const fresh = (plan: PreparedPlan): SkillRegistration => {
    if (!roots.some((root) => isInside(root, plan.root)) || isInside(plan.root, dataDir) || isInside(dataDir, plan.root)) {
      throw new TaskError("PERMISSION_DENIED", "The plan root is no longer authorized by this host");
    }
    if (Date.now() >= plan.expiresAt) throw new TaskError("PLAN_EXPIRED", "Prepare and approve a fresh plan");
    const registration = registry.get(plan.skill.id);
    if (!registration || identity(registration) !== plan.skill.contentHash) throw new TaskError("STALE_PLAN", "Skill or goal validator changed");
    if (canonical(plan.granted) !== canonical(grants)) throw new TaskError("STALE_PLAN", "Host permissions changed");
    try { assertUnchanged(plan.root, plan.observation); } catch (error) {
      throw new TaskError("STALE_PLAN", error instanceof Error ? error.message : String(error));
    }
    return registration;
  };

  const prepare = (request: TaskRequest): Promise<PreparedPlan> => {
    // Copy before waiting in the host queue, so caller mutation cannot change intent.
    keys(request, ["skillId", "root", "args", "goal"]);
    text(request.skillId, "skillId"); text(request.root, "root");
    keys(request.goal, ["intent", "criteria"]); text(request.goal.intent, "goal.intent"); canonical(request.goal.criteria);
    if (request.args !== undefined) {
      if (!request.args || Array.isArray(request.args) || typeof request.args !== "object" || Object.hasOwn(request.args, "root")) throw new TaskError("INVALID_REQUEST", "args cannot override root");
      canonical(request.args);
    }
    const input = copy(request);
    return serial(async () => {
      const root = path.resolve(input.root);
      if (!roots.some((allowed) => isInside(allowed, root)) || isInside(root, dataDir) || isInside(dataDir, root)) throw new TaskError("PERMISSION_DENIED", "Task root is outside the host scope");
      const registration = registry.get(input.skillId);
      if (!registration) throw new TaskError("SKILL_NOT_FOUND", "Skill is not in the trusted registry");
      const manifest = copy(registration.skill.manifest);
      const caps = checkCapabilities(manifest.capabilities, grants, root);
      if (!caps.allowed) throw new TaskError("PERMISSION_DENIED", caps.reasons.join("; "));
      if (manifest.capabilities.some((cap) => !["fs.read", "fs.write"].includes(cap.id))) throw new TaskError("UNSUPPORTED_SKILL", "This G1 host accepts file-only skills");
      const revision = identity(registration);
      const observation = captureTree(root);
      const actions = compileFilePlan(await registration.skill.plan({ ...(input.args ?? {}), root }, {}), root, observation);
      if (identity(registration) !== revision) throw new TaskError("STALE_PLAN", "Skill changed during planning");
      assertUnchanged(root, observation);
      // v0 only bounds capabilities by root. The new host also enforces narrower grants.
      for (const action of actions) {
        const targets = action.kind === "fs.move" ? [action.from, action.to] : [(action as { path: string }).path];
        if (!manifest.capabilities.some((cap) => cap.id === "fs.write" && targets.every((target) => isInside(root, target) && isInside(cap.scope?.replaceAll("{{root}}", root) ?? root, target)))) {
          throw new TaskError("PERMISSION_DENIED", "Action exceeds the declared write scope");
        }
      }
      const uuid = randomUUID(); const taskId = `task-${uuid}`; const planId = `plan-${uuid}`;
      const preview = await runActions(manifest, actions, { mode: "preview", root, granted: grants, journalPath: path.join(dataDir, "journals", `${taskId}.jsonl`) });
      const createdAt = Date.now();
      const plan: PreparedPlan = {
        formatVersion: 1, actionProtocol: "v0", planId, taskId, digest: "", createdAt, expiresAt: createdAt + ttl, root,
        skill: { id: manifest.name, version: manifest.version, contentHash: revision, manifest },
        input: input.args ?? {}, goal: { ...input.goal, validatorId: registration.validator.id, validatorVersion: registration.validator.version },
        granted: [...grants], observation, actions, preview: copy({ summary: preview.summary, steps: preview.steps }),
      };
      plan.digest = planDigest(plan);
      const result: TaskResult = { taskId, planId, status: "awaiting_approval", createdAt, updatedAt: createdAt, steps: [], journal: [], rolledBack: 0 };
      store.putPlan(planId, plan.digest, copy(plan) as unknown as Record<string, unknown>, { taskId, payload: result as unknown as Record<string, unknown> });
      return copy(plan);
    });
  };

  const approve = (planId: string, digest: string): ApprovalReceipt => {
    const plan = inspect(planId); text(digest, "digest");
    if (digest !== plan.digest) throw new TaskError("DIGEST_MISMATCH", "Approval does not match the stored plan");
    const task = get(plan.taskId);
    if (!["awaiting_approval", "ready"].includes(task.status)) throw new TaskError("TASK_STATE", "Task cannot be approved in its current state");
    fresh(plan);
    const receipt: ApprovalReceipt = { approvalId: `approval-${randomUUID()}`, planId, digest, expiresAt: plan.expiresAt };
    store.approve(receipt.approvalId, planId, digest, copy(receipt) as unknown as Record<string, unknown>);
    save({ ...task, status: "ready" }); return receipt;
  };

  const recovery = createRecoveryController({
    store, grants, ttl, get, inspect, save, serial, controllers,
    assertScope(plan) {
      ensureOpen();
      if (!roots.some((root) => isInside(root, plan.root)) || isInside(plan.root, dataDir) || isInside(dataDir, plan.root)) throw new TaskError("PERMISSION_DENIED", "Recovery root is outside current host scope");
      const decision = checkCapabilities(plan.skill.manifest.capabilities, grants, plan.root);
      if (!decision.allowed || !grants.includes("fs.write")) throw new TaskError("PERMISSION_DENIED", "Recovery requires currently granted file read/write permissions");
    },
  });

  const execute = (request: ExecuteRequest): Promise<TaskResult> => {
    keys(request, ["planId", "digest", "approvalReceiptId", "idempotencyKey"]);
    for (const [key, value] of Object.entries(request)) text(value, key);
    for (const key of ["planId", "digest", "approvalReceiptId", "idempotencyKey"] as const) text(request[key], key);
    const input = copy(request);
    return serial(async () => {
      const plan = inspect(input.planId);
      if (input.digest !== plan.digest) throw new TaskError("DIGEST_MISMATCH", "Execution does not match the approved plan");
      const task = get(plan.taskId);
      if (!["awaiting_approval", "ready"].includes(task.status)) return task;
      const approval = store.getApproval(input.approvalReceiptId);
      if (!approval || approval.planId !== plan.planId || approval.digest !== plan.digest) throw new TaskError("APPROVAL_REQUIRED", "A matching host approval receipt is required");
      const receipt = approval.payload as unknown as ApprovalReceipt;
      if (Date.now() >= receipt.expiresAt) throw new TaskError("APPROVAL_EXPIRED", "Approval expired");
      const registration = fresh(plan);
      const running: TaskResult = { ...task, status: "running", updatedAt: Date.now() };
      const claim = store.claim(plan.planId, plan.digest, input.approvalReceiptId, plan.taskId, copy(running) as unknown as Record<string, unknown>);
      if (!claim.claimed) return copy(claim.task.payload as unknown as TaskResult);
      const controller = new AbortController(); controllers.set(plan.taskId, controller);
      const journalPath = path.join(dataDir, "journals", `${plan.taskId}.jsonl`);
      let observed = plan.observation;
      try {
        const report = await runActions(plan.skill.manifest, plan.actions, { mode: "apply", root: plan.root, granted: grants, journalPath }, {}, {
          taskId: plan.taskId, signal: controller.signal, rollbackOnFailure: false,
          beforeAction: async (action, index) => {
            // File effects and snapshots are synchronous. Give OS signals and timers a
            // turn at each boundary, then observe again before allowing the next effect.
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (controller.signal.aborted) return;
            assertUnchanged(plan.root, observed);
            recovery.beforeForward(plan.taskId, index, action, observed);
            // Durable intent writes may block; revalidate the tree and immediate
            // targets after the commit, before the core starts the effect.
            assertUnchanged(plan.root, observed);
            recovery.guardForward(observed, action);
            // runActions checks the same signal again after this awaited hook.
          },
          afterAction: (action, index) => {
            const after = afterFileAction(plan.root, observed, action);
            recovery.afterForward(plan.taskId, index, after); observed = after;
          },
        });
        const result = { ...running, steps: report.steps, journal: readJournal(journalPath), rolledBack: report.rolledBack };
        if (report.steps.some((step) => step.status === "failed")) {
          return save({ ...result, status: "needs_attention", error: { code: "EXECUTION_FAILED", message: "Execution stopped; preserved effects require inspection before recovery" } });
        }
        if (report.steps.some((step) => step.status === "skipped" && step.detail === ACTION_CANCELLED_DETAIL)) {
          return save({ ...result, status: report.journal.length ? "partial" : "cancelled" });
        }
        assertUnchanged(plan.root, observed);
        const goal = await registration.validator.verify({ root: plan.root, criteria: copy(plan.goal.criteria), actions: copy(plan.actions) });
        if (!goal || typeof goal.satisfied !== "boolean" || typeof goal.detail !== "string") throw new TaskError("INVALID_GOAL_RESULT", "Trusted goal verifier returned an invalid result");
        assertUnchanged(plan.root, observed);
        return save({ ...result, status: goal.satisfied ? "succeeded" : "partial", goal: copy(goal), ...(goal.satisfied ? {} : { error: { code: "GOAL_NOT_MET", message: goal.detail } }) });
      } catch (error) {
        const journal = readJournal(journalPath);
        return save({ ...running, status: "needs_attention", journal, steps: journal.map((entry) => ({ actionId: entry.actionId, status: entry.status === "failed" ? "failed" as const : "ok" as const, detail: entry.detail })), error: { code: "EXECUTION_UNCERTAIN", message: error instanceof Error ? error.message : String(error) } });
      } finally { controllers.delete(plan.taskId); }
    });
  };

  const cancel = (taskId: string): TaskResult => {
    const task = get(taskId);
    if (["awaiting_approval", "ready"].includes(task.status)) return save({ ...task, status: "cancelled" });
    if (task.status === "running" || task.status === "cancelling" || task.status === "recovering") {
      controllers.get(taskId)?.abort(); return save({ ...task, status: "cancelling", ...(task.recovery ? { recovery: { ...task.recovery, status: "cancelling" as const } } : {}) });
    }
    return task;
  };
  return Object.freeze({
    tasks: Object.freeze({ prepare, inspect, execute, get, cancel,
      list: () => { ensureOpen(); return store.listTasks().map((record) => copy(record.payload as unknown as TaskResult)).filter((task) => roots.some((root) => isInside(root, inspect(task.planId).root))); },
      prepareRecovery: recovery.prepareRecovery, inspectRecovery: recovery.inspectRecovery, recover: recovery.recover,
    }),
    approvals: Object.freeze({ approve, approveRecovery: recovery.approveRecovery }),
    close(): void {
      ensureOpen();
      if (queued || controllers.size) throw new TaskError("HOST_BUSY", "Wait for pending work to finish before closing");
      store.close(); closed = true; liveHosts.delete(hostKey);
    },
  });
}
