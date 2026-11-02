import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TaskStore } from "../../storage/src/task-store.ts";
import type { JsonObject } from "../../storage/src/task-store.ts";
import type { Action, CapabilityId } from "../../core/src/types.ts";
import { assertUnchanged, captureTree, predictFilePlan } from "./file-plan.ts";
import type { TreeNode, TreeSnapshot } from "./file-plan.ts";
import type { PreparedPlan, RecoveryPlan, RecoveryApprovalReceipt, RecoveryRequest, RecoveryStep, TaskResult } from "./types.ts";

export class RecoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "RecoveryError"; this.code = code; }
}
const fail = (code: string, message: string): never => { throw new RecoveryError(code, message); };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return fail("INVALID_RECOVERY_DATA", "Recovery accepts only finite JSON data");
}
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const data = (value: unknown): JsonObject => copy(value) as JsonObject;
const key = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const ordered = (nodes: TreeNode[]): TreeNode[] => nodes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sameNodes = (a: TreeNode[], b: TreeNode[]): boolean => canonical(ordered(copy(a))) === canonical(ordered(copy(b)));
const digestOf = (plan: RecoveryPlan): string => { const { digest: _, ...body } = plan; return hash(body); };
const forwardId = (taskId: string): string => `forward:${taskId}`;
type Effect = {
  operationId: string; taskId: string; index: number; action: Action | RecoveryStep;
  phase: "intent" | "verified" | "not_applied"; before: TreeSnapshot; intendedAt: number;
  after?: TreeSnapshot; resolvedAt?: number;
};

/** Exact reverse primitives are derived from verified forward actions, never supplied by a skill/model. */
function inverse(actions: Action[]): RecoveryStep[] {
  return actions.map((action, index): RecoveryStep => {
    const base = { id: `restore:${index}:${action.id}`, sourceActionId: action.id };
    if (action.kind === "fs.move") return { ...base, kind: "move", from: action.to, to: action.from };
    if (action.kind === "fs.write") return { ...base, kind: "remove-file", path: action.path };
    if (action.kind === "fs.mkdir") return { ...base, kind: "remove-directory", path: action.path };
    return fail("UNSUPPORTED_RECOVERY", "Only bounded file task effects can be restored");
  }).reverse();
}
function relative(root: string, absolute: string): string {
  if (typeof absolute !== "string" || !path.isAbsolute(absolute)) return fail("INVALID_RECOVERY_PLAN", "Recovery paths must be absolute");
  const name = path.relative(root, absolute);
  if (!name || path.isAbsolute(name) || name === ".." || name.startsWith(`..${path.sep}`)) return fail("INVALID_RECOVERY_PLAN", "Recovery cannot act on the root or outside it");
  return name.split(path.sep).join("/");
}
function recoveredNodes(before: TreeSnapshot, step: RecoveryStep): TreeNode[] {
  const nodes = copy(before.nodes); const byPath = new Map(nodes.map((node) => [key(node.path), node]));
  if (step.kind === "move") {
    const from = relative(before.root, step.from); const to = relative(before.root, step.to);
    const source = byPath.get(key(from)); const parent = byPath.get(key(path.posix.dirname(to) === "." ? "" : path.posix.dirname(to)));
    if (!source || source.kind !== "file" || byPath.has(key(to)) || parent?.kind !== "directory") return fail("RECOVERY_CONFLICT", "Reverse move requires its original file, an empty destination, and an existing parent");
    source.path = to;
  } else {
    const target = relative(before.root, step.path); const source = byPath.get(key(target));
    if (!source || source.kind !== (step.kind === "remove-file" ? "file" : "directory")) return fail("RECOVERY_CONFLICT", "Recovery target is missing or has changed kind");
    if (step.kind === "remove-directory" && nodes.some((node) => key(node.path).startsWith(`${key(target)}/`))) return fail("RECOVERY_CONFLICT", "Only the verified empty task-created directory can be removed");
    nodes.splice(nodes.indexOf(source), 1);
  }
  return ordered(nodes);
}
function matchesForward(before: TreeSnapshot, action: Action, after: TreeSnapshot): boolean {
  const predicted = predictFilePlan([action], before.root, before);
  if (after.root !== before.root || canonical(after.limits) !== canonical(before.limits) || predicted.semanticDigest !== after.semanticDigest) return false;
  const actual = new Map(after.nodes.map((node) => [key(node.path), node]));
  return predicted.nodes.every((node) => {
    const seen = actual.get(key(node.path));
    return !!seen && (!node.identity || seen.ino === node.identity.ino && seen.dev === node.identity.dev && (node.kind !== "file" || seen.mtimeNs === node.identity.mtimeNs));
  });
}
function description(step: RecoveryStep): string {
  return step.kind === "move" ? `Move ${step.from} back to ${step.to}` : `${step.kind === "remove-file" ? "Remove task-created file" : "Remove empty task-created directory"} ${step.path}`;
}

/** Last path-based checks after durable I/O. This does not claim an OS no-replace primitive. */
function requireAbsent(file: string): void {
  try { fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  fail("RECOVERY_CONFLICT", "The effect destination is no longer absent");
}
function requireIdentity(before: TreeSnapshot, file: string): void {
  const relativePath = path.relative(before.root, file).split(path.sep).join("/");
  const expected = before.nodes.find((node) => key(node.path) === key(relativePath));
  if (!expected) fail("RECOVERY_CONFLICT", "The effect resource is not in the verified observation");
  const current = fs.lstatSync(file, { bigint: true });
  if (current.isSymbolicLink() || String(current.ino) !== expected.ino || String(current.dev) !== expected.dev
      || expected.kind === "directory" && !current.isDirectory()
      || expected.kind === "file" && (!current.isFile() || current.nlink !== 1n || Number(current.size) !== expected.size || String(current.mtimeNs) !== expected.mtimeNs)) {
    fail("RECOVERY_CONFLICT", "The effect resource identity changed immediately before use");
  }
}
function guardRecovery(before: TreeSnapshot, step: RecoveryStep): void {
  if (step.kind === "move") {
    requireIdentity(before, step.from); requireIdentity(before, path.dirname(step.to)); requireAbsent(step.to);
  } else {
    requireIdentity(before, step.path);
    if (step.kind === "remove-directory" && fs.readdirSync(step.path).length !== 0) fail("RECOVERY_CONFLICT", "The directory gained content before removal");
  }
}
function guardForward(before: TreeSnapshot, action: Action): void {
  if (action.kind === "fs.move") {
    requireIdentity(before, action.from); requireIdentity(before, path.dirname(action.to)); requireAbsent(action.to);
  } else if (action.kind === "fs.mkdir" || action.kind === "fs.write") {
    requireIdentity(before, path.dirname(action.path)); requireAbsent(action.path);
  } else fail("UNSUPPORTED_RECOVERY", "Only bounded file effects can be checked");
}

export function createRecoveryController(options: {
  store: TaskStore; grants: CapabilityId[]; ttl: number;
  get(taskId: string): TaskResult; inspect(planId: string): PreparedPlan; save(task: TaskResult): TaskResult;
  assertScope(plan: PreparedPlan): void;
  serial<T>(operation: () => Promise<T>): Promise<T>;
  controllers: Map<string, AbortController>;
}) {
  const { store, get, inspect, save, serial, controllers } = options;
  const effects = (operationId: string): Effect[] => store.effects(operationId) as unknown as Effect[];
  const resolve = (entry: Effect, phase: "verified" | "not_applied", after: TreeSnapshot): Effect => {
    const resolved: Effect = { ...entry, phase, after: copy(after), resolvedAt: Date.now() };
    store.putEffect(entry.operationId, entry.taskId, entry.index, data(resolved)); return resolved;
  };
  const begin = (operationId: string, taskId: string, index: number, action: Action | RecoveryStep, before: TreeSnapshot): void => {
    store.putEffect(operationId, taskId, index, data({ operationId, taskId, index, action, phase: "intent", before, intendedAt: Date.now() }));
  };
  const finish = (operationId: string, index: number, after: TreeSnapshot): void => {
    const entry = effects(operationId).find((item) => item.index === index);
    if (!entry || entry.phase !== "intent") fail("RECOVERY_EVIDENCE_INVALID", "Verified effect must have a durable intent");
    resolve(entry, "verified", after);
  };
  const inspectRecovery = (recoveryId: string): RecoveryPlan => {
    const record = store.getRecovery(recoveryId);
    if (!record) return fail("RECOVERY_NOT_FOUND", "Unknown recovery plan");
    const plan = record.payload as unknown as RecoveryPlan;
    if (plan.recoveryId !== recoveryId || plan.taskId !== record.taskId || plan.digest !== record.digest || digestOf(plan) !== record.digest) return fail("CORRUPT_RECOVERY_PLAN", "Stored recovery plan integrity check failed");
    options.assertScope(inspect(plan.planId));
    return copy(plan);
  };
  const evidenceDigest = (taskId: string): string => hash({
    forward: effects(forwardId(taskId)),
    recoveries: store.claimedRecoveries(taskId).map((id) => ({ id, digest: inspectRecovery(id).digest, effects: effects(id) })),
  });

  /** Resolve only an exact observed before/after; new unverified objects have unknown ownership. */
  const reconcile = (task: TaskResult, original: PreparedPlan) => {
    const actual = captureTree(original.root, original.observation.limits);
    const forward = effects(forwardId(task.taskId)); const recoveries = store.claimedRecoveries(task.taskId);
    let observed = original.observation; const applied: Action[] = [];
    for (let index = 0; index < forward.length; index++) {
      let entry = forward[index]; const action = original.actions[index];
      if (!action || entry.index !== index || entry.taskId !== task.taskId || canonical(entry.action) !== canonical(action) || entry.before.digest !== observed.digest) fail("RECOVERY_EVIDENCE_INVALID", "Forward checkpoints do not form the approved action chain");
      if (entry.phase === "intent") {
        if (index !== forward.length - 1 || recoveries.length) fail("RECOVERY_EVIDENCE_INVALID", "Unresolved intent is not the final effect");
        if (actual.digest === entry.before.digest) entry = resolve(entry, "not_applied", actual);
        else if (action.kind === "fs.move" && matchesForward(entry.before, action, actual)) entry = resolve(entry, "verified", actual);
        else fail("RECOVERY_EFFECT_UNKNOWN", "An unverified effect cannot be attributed safely; files were preserved");
      }
      if (entry.phase === "not_applied") {
        if (index !== forward.length - 1 || entry.after?.digest !== entry.before.digest) fail("RECOVERY_EVIDENCE_INVALID", "A non-applied effect must end the chain");
      } else {
        if (!entry.after || !matchesForward(entry.before, action, entry.after)) fail("RECOVERY_EVIDENCE_INVALID", "Verified forward checkpoint has an invalid result");
        observed = entry.after; applied.push(action);
      }
    }
    let undone = 0; let mode: "undo" | "restore" = task.status === "succeeded" ? "undo" : "restore";
    for (const recoveryId of recoveries) {
      const recovery = inspectRecovery(recoveryId); mode = recovery.mode;
      if (recovery.taskId !== task.taskId || recovery.planId !== original.planId || recovery.observation.digest !== observed.digest || canonical(recovery.steps) !== canonical(inverse(applied.slice(0, applied.length - undone)))) fail("RECOVERY_EVIDENCE_INVALID", "Recovery history does not match the remaining verified effects");
      const recorded = effects(recoveryId);
      for (let index = 0; index < recorded.length; index++) {
        let entry = recorded[index]; const step = recovery.steps[index];
        if (!step || entry.index !== index || entry.taskId !== task.taskId || canonical(entry.action) !== canonical(step) || entry.before.digest !== observed.digest) fail("RECOVERY_EVIDENCE_INVALID", "Recovery checkpoints do not form a valid chain");
        const expected = recoveredNodes(entry.before, step);
        if (entry.phase === "intent") {
          if (index !== recorded.length - 1 || recoveryId !== recoveries.at(-1)) fail("RECOVERY_EVIDENCE_INVALID", "Unresolved recovery is not the final effect");
          if (actual.digest === entry.before.digest) entry = resolve(entry, "not_applied", actual);
          else if (sameNodes(actual.nodes, expected)) entry = resolve(entry, "verified", actual);
          else fail("RECOVERY_EFFECT_UNKNOWN", "Recovery was interrupted with an unrecognized file state");
        }
        if (entry.phase === "not_applied") {
          if (index !== recorded.length - 1 || entry.after?.digest !== entry.before.digest) fail("RECOVERY_EVIDENCE_INVALID", "Non-applied recovery must end its attempt");
        } else {
          if (!entry.after || !sameNodes(entry.after.nodes, expected)) fail("RECOVERY_EVIDENCE_INVALID", "Verified recovery has an invalid result");
          observed = entry.after; undone++;
        }
      }
    }
    if (actual.digest !== observed.digest) fail("RECOVERY_CONFLICT", "The entire current tree must match verified effects; preserve manual changes and inspect them first");
    return { observation: actual, actions: applied.slice(0, applied.length - undone), originalCount: applied.length, mode };
  };

  const prepareRecovery = (taskId: string): Promise<RecoveryPlan> => serial(async () => {
    const task = get(taskId); const original = inspect(task.planId); options.assertScope(original);
    if (["undone", "restored"].includes(task.status)) return fail("TASK_ALREADY_RESTORED", "Task effects were already restored; inspect its recorded result");
    if (!["succeeded", "partial", "needs_attention", "cancelled"].includes(task.status)) return fail("TASK_STATE", "Stop or finish the task before preparing recovery");
    const current = reconcile(task, original); const steps = inverse(current.actions); const createdAt = Date.now();
    const plan: RecoveryPlan = {
      formatVersion: 1, recoveryId: `recovery-${randomUUID()}`, taskId, planId: original.planId, root: original.root, digest: "",
      createdAt, expiresAt: createdAt + options.ttl, mode: current.mode, granted: [...options.grants],
      observation: current.observation, originalObservation: original.observation, evidenceDigest: evidenceDigest(taskId), steps,
      preview: { steps: steps.map((step) => ({ actionId: step.id, detail: description(step) })), completeTreeRequired: true },
    };
    plan.digest = digestOf(plan); store.putRecovery(plan.recoveryId, taskId, plan.digest, data(plan)); return copy(plan);
  });
  const fresh = (plan: RecoveryPlan): void => {
    options.assertScope(inspect(plan.planId));
    if (Date.now() >= plan.expiresAt) fail("PLAN_EXPIRED", "Prepare a fresh recovery preview");
    if (canonical(plan.granted) !== canonical(options.grants)) fail("STALE_RECOVERY", "Recovery permissions changed");
    if (evidenceDigest(plan.taskId) !== plan.evidenceDigest) fail("STALE_RECOVERY", "Recovery evidence changed; prepare again");
    assertUnchanged(plan.root, plan.observation);
  };
  const approveRecovery = (recoveryId: string, digest: string): RecoveryApprovalReceipt => {
    const plan = inspectRecovery(recoveryId);
    if (plan.digest !== digest) return fail("DIGEST_MISMATCH", "Recovery approval must match its preview");
    if (!store.claimedRecoveries(plan.taskId).includes(recoveryId)) {
      if (!["succeeded", "partial", "needs_attention", "cancelled"].includes(get(plan.taskId).status)) fail("TASK_STATE", "Task cannot be approved for recovery");
      fresh(plan);
    }
    const receipt = { approvalId: `recovery-approval-${randomUUID()}`, recoveryId, digest, expiresAt: plan.expiresAt };
    store.approveRecovery(receipt.approvalId, recoveryId, digest, data(receipt)); return receipt;
  };
  const recover = (request: RecoveryRequest): Promise<TaskResult> => {
    if (!request || Object.keys(request).sort().join(",") !== "approvalReceiptId,digest,recoveryId" || Object.values(request).some((value) => typeof value !== "string" || !value.trim())) return Promise.reject(new RecoveryError("INVALID_REQUEST", "Recovery requires its ID, exact digest, and approval receipt"));
    const input = copy(request);
    return serial(async () => {
      const plan = inspectRecovery(input.recoveryId);
      if (plan.digest !== input.digest) fail("DIGEST_MISMATCH", "Recovery execution differs from its preview");
      const approval = store.getRecoveryApproval(input.approvalReceiptId);
      if (!approval || approval.recoveryId !== plan.recoveryId || approval.digest !== plan.digest) fail("APPROVAL_REQUIRED", "A trusted recovery approval is required");
      if (store.claimedRecoveries(plan.taskId).includes(plan.recoveryId)) return get(plan.taskId);
      if (Date.now() >= Number(approval.payload.expiresAt)) fail("APPROVAL_EXPIRED", "Recovery approval expired");
      fresh(plan);
      const task = get(plan.taskId);
      const running: TaskResult = { ...task, status: "recovering", updatedAt: Date.now(), recovery: { recoveryId: plan.recoveryId, mode: plan.mode, status: "running", completedSteps: 0, totalSteps: plan.steps.length } };
      const claim = store.claimRecovery(plan.recoveryId, plan.digest, input.approvalReceiptId, plan.taskId, data(running));
      if (!claim.claimed) return copy(claim.task.payload as unknown as TaskResult);
      const controller = new AbortController(); controllers.set(plan.taskId, controller);
      let observed = plan.observation; let completed = 0;
      try {
        for (let index = 0; index < plan.steps.length; index++) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (controller.signal.aborted) fail("RECOVERY_CANCELLED", "Recovery stopped at an action boundary; remaining effects were preserved");
          assertUnchanged(plan.root, observed);
          const step = plan.steps[index]; const expected = recoveredNodes(observed, step);
          begin(plan.recoveryId, plan.taskId, index, step, observed);
          // SQLite commit can block while another process changes the tree. Never use
          // the observation from before that durable boundary to authorize a write.
          assertUnchanged(plan.root, observed);
          guardRecovery(observed, step);
          if (step.kind === "move") fs.renameSync(step.from, step.to);
          else if (step.kind === "remove-file") fs.unlinkSync(step.path);
          else fs.rmdirSync(step.path);
          const actual = captureTree(plan.root, observed.limits);
          if (!sameNodes(actual.nodes, expected)) fail("RECOVERY_RESULT_MISMATCH", "Recovery effect requires inspection; no further steps were started");
          finish(plan.recoveryId, index, actual); observed = actual; completed++;
          save({ ...running, recovery: { ...running.recovery!, completedSteps: completed } });
        }
        assertUnchanged(plan.root, observed);
        if (observed.digest !== plan.originalObservation.digest) fail("RECOVERY_GOAL_NOT_MET", "Original tree has not been restored");
        const originalCount = effects(forwardId(plan.taskId)).filter((entry) => entry.phase === "verified").length;
        const { error: _oldError, ...rest } = running;
        return save({ ...rest, status: plan.mode === "undo" ? "undone" : "restored", rolledBack: originalCount, recovery: { ...running.recovery!, status: "completed", completedSteps: completed } });
      } catch (error) {
        return save({ ...running, status: "needs_attention", recovery: { ...running.recovery!, status: "needs_attention", completedSteps: completed },
          error: { code: error instanceof RecoveryError ? error.code : "RECOVERY_FAILED", message: "Recovery stopped; inspect current state and prepare a fresh recovery preview" } });
      } finally { controllers.delete(plan.taskId); }
    });
  };
  return {
    prepareRecovery, inspectRecovery, approveRecovery, recover,
    beforeForward: (taskId: string, index: number, action: Action, before: TreeSnapshot): void => begin(forwardId(taskId), taskId, index, action, before),
    afterForward: (taskId: string, index: number, after: TreeSnapshot): void => finish(forwardId(taskId), index, after),
    guardForward,
  };
}
