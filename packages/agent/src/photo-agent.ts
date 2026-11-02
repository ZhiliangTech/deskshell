import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DeepSeekBackend, ModelLimits, ProposalResult } from "../../models/src/deepseek.ts";
import { createTaskHost, TaskError } from "../../runtime/src/host.ts";
import { captureTree } from "../../runtime/src/file-plan.ts";
import { createPhotoGoal, createPhotoRegistration, PHOTO_SKILL_ID, PHOTO_SKILL_VERSION, PHOTO_DEFAULT_TIMEZONE, photoSkillDescription, photoDedupeSkillDescription } from "../../runtime/src/photo-task.ts";
import type { PreparedPlan, TaskResult } from "../../runtime/src/types.ts";

export const PHOTO_MODEL_LIMITS: Readonly<ModelLimits> = Object.freeze({
  maxRequests: 1, maxInputBytes: 8192, maxOutputTokens: 512, timeoutMs: 30_000, maxEstimatedCostUsd: 0.01,
});
export type PhotoHost = ReturnType<typeof createTaskHost>;
export type ProposalBackend = Pick<DeepSeekBackend, "propose">;
export interface PhotoModelRecord {
  requestId: string; model: string; usage: ProposalResult["usage"]; estimatedCostUsd: number; budget: ProposalResult["budget"];
}
const cancelled = (signal?: AbortSignal): void => { if (signal?.aborted) throw new TaskError("CANCELLED", "Task planning was cancelled"); };
const sameRoot = (a: string, b: string): boolean => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

export function openPhotoHost(root: string, stateDir: string): PhotoHost {
  return createTaskHost({ dataDir: stateDir, allowedRoots: [root], granted: ["fs.read", "fs.write"], skills: [createPhotoRegistration()] });
}

/** Only the trusted caller supplies root/state and owns this host's approval interface. */
export async function preparePhotoTask(options: {
  host: PhotoHost; root: string; stateDir: string; intent: string; backend: ProposalBackend; signal?: AbortSignal; deduplicate?: boolean;
}): Promise<{ plan: PreparedPlan; model: PhotoModelRecord }> {
  const { host, root, stateDir, intent, backend, signal } = options;
  if (typeof intent !== "string" || !intent.trim() || Buffer.byteLength(intent, "utf8") > 2048) throw new TaskError("INVALID_INTENT", "Provide a goal of 1–2048 UTF-8 bytes");
  cancelled(signal);
  if (options.deduplicate !== undefined && typeof options.deduplicate !== "boolean") throw new TaskError("INVALID_REQUEST", "Deduplication mode must be selected by the trusted caller");
  const deduplicate = options.deduplicate === true;
  const goal = createPhotoGoal(root, { deduplicate });
  // Capture trusted local expectations before the network wait. Never send this tree or its paths.
  const auditPath = path.join(stateDir, `model-request-${randomUUID()}.json`);
  const audit: Record<string, unknown> = {
    formatVersion: 1, startedAt: new Date().toISOString(), status: "started", provider: "deepseek", requestedModel: "deepseek-flash",
    intentSha256: createHash("sha256").update(intent).digest("hex"), outboundFields: ["user-entered intent", "fixed skill description and schema"],
  };
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  let prepared: PreparedPlan | undefined;
  try {
    const response = await backend.propose({ intent, skills: [deduplicate ? photoDedupeSkillDescription : photoSkillDescription], ...(signal ? { signal } : {}) });
    cancelled(signal);
    const candidate = response.proposal;
    if (candidate.skillId !== PHOTO_SKILL_ID || candidate.version !== PHOTO_SKILL_VERSION
        || candidate.args.dateSource !== "mtime" || candidate.args.timeZone !== PHOTO_DEFAULT_TIMEZONE
        || (deduplicate ? candidate.args.deduplicate !== true || Object.keys(candidate.args).length !== 3 : Object.keys(candidate.args).length !== 2)) throw new TaskError("INVALID_PHOTO_PROPOSAL", "Proposal does not match the photo task contract");
    if (captureTree(path.resolve(root)).digest !== goal.observationDigest) throw new TaskError("STALE_PLAN", "Files changed while the model was responding; prepare again");
    cancelled(signal);
    prepared = await host.tasks.prepare({ skillId: candidate.skillId, root, args: candidate.args, goal: { intent, criteria: goal } });
    if (signal?.aborted || prepared.observation.digest !== goal.observationDigest) {
      host.tasks.cancel(prepared.taskId);
      cancelled(signal);
      throw new TaskError("STALE_PLAN", "Files changed between observation and planning; prepare again");
    }
    const model: PhotoModelRecord = { requestId: response.requestId, model: response.model, usage: response.usage, estimatedCostUsd: response.estimatedCostUsd, budget: response.budget };
    Object.assign(audit, { status: "prepared", completedAt: new Date().toISOString(), taskId: prepared.taskId, planId: prepared.planId, digest: prepared.digest, ...model });
    // Audit update is atomic. A process crash may leave a 'started' record, never a false zero-cost success.
    const temporary = `${auditPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(audit, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, auditPath);
    return { plan: prepared, model };
  } catch (error) {
    if (prepared && host.tasks.get(prepared.taskId).status === "awaiting_approval") host.tasks.cancel(prepared.taskId);
    // Failed requests retain their initial 'started' audit: usage/outcome may be unknown, never assumed free.
    throw error;
  }
}

export function inspectPhotoPlan(host: PhotoHost, root: string, planId: string): PreparedPlan {
  const plan = host.tasks.inspect(planId);
  if (!sameRoot(root, plan.root) || plan.skill.id !== PHOTO_SKILL_ID || plan.skill.version !== PHOTO_SKILL_VERSION) throw new TaskError("PLAN_SCOPE_MISMATCH", "The selected plan belongs to a different root or skill");
  return plan;
}

/** Called only by the explicit apply command, never by propose/prepare or a model tool. */
export async function applyPhotoPlan(host: PhotoHost, root: string, planId: string, digest: string, signal?: AbortSignal): Promise<TaskResult> {
  const plan = inspectPhotoPlan(host, root, planId);
  if (digest !== plan.digest) throw new TaskError("DIGEST_MISMATCH", "Use the exact digest shown in the preview");
  const task = host.tasks.get(plan.taskId);
  if (!["awaiting_approval", "ready"].includes(task.status)) return task;
  if (signal?.aborted) return host.tasks.cancel(plan.taskId);
  let cancellationFailed = false;
  const onAbort = (): void => {
    try { host.tasks.cancel(plan.taskId); }
    catch { cancellationFailed = true; }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const receipt = host.approvals.approve(planId, digest);
    const result = await host.tasks.execute({ planId, digest, approvalReceiptId: receipt.approvalId, idempotencyKey: `cli:${planId}` });
    if (cancellationFailed) throw new TaskError("CANCEL_FAILED", "Cancellation could not be recorded; inspect the persisted task result");
    return result;
  } finally { signal?.removeEventListener("abort", onAbort); }
}

export function photoPreview(plan: PreparedPlan) {
  return {
    phase: "preview", taskId: plan.taskId, planId: plan.planId, digest: plan.digest, root: plan.root,
    expiresAt: new Date(plan.expiresAt).toISOString(), rule: { dateSource: "file modification time (mtime)", timeZone: PHOTO_DEFAULT_TIMEZONE, recursive: false, overwrite: false, deduplicate: plan.input.deduplicate === true, ...(plan.input.deduplicate === true ? { duplicatesDirectory: "_duplicates", keepRule: "First filename in case-sensitive UTF-16 order among root-level byte-identical photos" } : {}) },
    steps: plan.preview.steps, approvalPolicy: "Explicit apply command with this exact digest",
  };
}
