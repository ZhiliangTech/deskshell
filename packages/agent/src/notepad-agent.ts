import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue, SkillDescription } from "../../models/src/deepseek.ts";
import { NotepadTaskError } from "../../runtime/src/notepad-task.ts";
import type { createNotepadTaskHost, NotepadPlan, NotepadResult, NotepadPhase } from "../../runtime/src/notepad-task.ts";
import type { AutonomyAdapter, AutonomyEnvelope } from "./autonomy.ts";

export type NotepadHost = ReturnType<typeof createNotepadTaskHost>;
export const NOTEPAD_WORKFLOW = { id: "notepad-approved-copy", version: "1" } as const;
const steps = ["open", "edit", "save-copy"] as const;
const skill: SkillDescription = {
  id: "notepad-next-step", version: "1",
  description: "Advance one step of an already approved Notepad copy task. Choose exactly the nextStep from the trusted observation. The local host supplies all paths and text; you cannot change them, grant permission, or declare completion. After the result, observe again before proposing the next step.",
  argsSchema: { type: "object", properties: { step: { type: "string", enum: [...steps] } }, required: ["step"], additionalProperties: false },
};
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const fail = (code: string): never => { throw new NotepadTaskError(code, "The approved Notepad workflow no longer matches the current task"); };
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const nextStep = (stage: string): string | null => ({ planned: "open", open: "edit", edit: "save-copy" }[stage] ?? null);
// The dedicated task journal already persists complete local buffer evidence. Keep
// coordinator records small even for a document near the task's 256 KiB limit.
const evidence = (task: NotepadResult): JsonValue => json({
  taskId: task.taskId, planId: task.planId, stage: task.stage, status: task.status,
  nextPhase: task.nextPhase, binding: task.binding ?? null, bufferToken: task.bufferToken ?? null,
  goal: task.goal ?? null, error: task.error ? { code: task.error.code } : null,
  journal: task.journal.map(({ operationId, index, phase, step }) => ({ operationId, index, phase, step })),
});

/** This local constructor fixes authority and content before any model call. */
export function notepadEnvelope(plan: NotepadPlan, intent: string, maxRounds = 6): AutonomyEnvelope {
  if (typeof intent !== "string" || !intent.trim() || Buffer.byteLength(intent, "utf8") > 2048) fail("INVALID_INTENT");
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 3 || maxRounds > 10) fail("INVALID_ROUND_LIMIT");
  return {
    workflow: { ...NOTEPAD_WORKFLOW }, goal: { intent, criteria: { planId: plan.planId, digest: plan.digest, expectedHash: plan.expectedHash, preservesOriginal: true } },
    resources: { plan: { planId: plan.planId, digest: plan.digest }, source: { path: plan.source.path, hash: plan.source.hash }, document: { appId: plan.driver.appId }, copy: { path: plan.copyPath, hash: plan.expectedHash } },
    allowedCapabilities: ["fs.read", "fs.write", "ui.read", "ui.input"], allowedOutputs: ["document", "copy"], maxRounds, maxDurationMs: 300_000,
  };
}

/** A trusted adapter maps a tiny model vocabulary onto the immutable local plan. */
export function createNotepadAutonomyAdapter(host: NotepadHost, root: string): AutonomyAdapter {
  const selected = (envelope: AutonomyEnvelope): NotepadPlan => {
    const reference = envelope.resources.plan as { planId?: string; digest?: string } | undefined;
    if (!reference || typeof reference.planId !== "string") fail("PLAN_SCOPE_MISMATCH");
    const plan = host.tasks.inspect(reference.planId);
    const expected = notepadEnvelope(plan, envelope.goal.intent, envelope.maxRounds);
    if (reference.digest !== plan.digest || !samePath(plan.root, root)
      || canonical(envelope.resources) !== canonical(expected.resources)
      || canonical(envelope.goal.criteria) !== canonical(expected.goal.criteria)
      || canonical([...envelope.allowedCapabilities].sort()) !== canonical([...expected.allowedCapabilities].sort())
      || canonical([...envelope.allowedOutputs].sort()) !== canonical([...expected.allowedOutputs].sort())
      || envelope.maxDurationMs > expected.maxDurationMs) fail("PLAN_SCOPE_MISMATCH");
    return plan;
  };
  return {
    ...NOTEPAD_WORKFLOW,
    revision: () => createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).update(fs.readFileSync(new URL("../../runtime/src/notepad-task.ts", import.meta.url))).digest("hex"),
    skills: [skill],
    async observe({ envelope, signal }) {
      if (signal.aborted) fail("CANCELLED");
      const plan = selected(envelope);
      const current = await host.tasks.observe(plan.taskId, signal);
      if (current.conflict) fail(current.conflict.code);
      const task = current.task;
      // No document body, filesystem path, filename, window title or native identifier leaves the host.
      return { state: { task: evidence(task), goal: json(current.goal) }, modelContext: { task: "approved-notepad-copy", stage: task.stage, status: task.status, nextStep: nextStep(task.stage), goalSatisfied: current.goal.satisfied } };
    },
    verify({ observation }) {
      const current = observation.state as { goal: { satisfied: boolean; detail: string } };
      return { satisfied: current.goal.satisfied === true, detail: current.goal.detail };
    },
    validate({ envelope, observation, proposal }) {
      selected(envelope);
      const current = observation.state as { task: { stage: string; status: string } };
      if (!["awaiting_approval", "ready", "running", "paused"].includes(current.task.status)) fail("TASK_STATE");
      if (proposal.skillId !== skill.id || proposal.version !== skill.version || Object.keys(proposal.args).length !== 1 || proposal.args.step !== nextStep(current.task.stage)) fail("INVALID_NEXT_STEP");
      const save = proposal.args.step === "save-copy";
      return { capabilities: save ? ["fs.read", "fs.write", "ui.read", "ui.input"] : ["fs.read", "ui.read", "ui.input"], resourceIds: ["plan", "source", "document", ...(save ? ["copy"] : [])], outputIds: save ? ["document", "copy"] : ["document"], effect: "write", payload: { step: proposal.args.step } };
    },
    async execute({ envelope, action, signal }) {
      const plan = selected(envelope);
      if (signal.aborted) return { outcome: "not_applied", evidence: { code: "CANCELLED" } };
      const current = host.tasks.get(plan.taskId);
      if ((action.payload as { step: string }).step !== nextStep(current.stage)) fail("INVALID_NEXT_STEP");
      // The session's exact approved envelope delegates this already-fixed plan. The model has no approval API.
      const receipt = host.approvals.approve(plan.planId, plan.digest);
      // Cancellation may arrive while a durable record is being committed. Never
      // throw from an AbortSignal listener; the coordinator also records uncertainty.
      const cancel = () => { try { host.tasks.cancel(plan.taskId); } catch { /* The coordinator stops and preserves any unresolved effect. */ } };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (signal.aborted) { cancel(); return { outcome: "not_applied", evidence: { code: "CANCELLED" } }; }
        const result = await host.tasks.advance({ planId: plan.planId, digest: plan.digest, approvalReceiptId: receipt.approvalId, expectedPhase: (action.payload as { step: NotepadPhase }).step });
        return { outcome: result.status === "needs_attention" ? "unknown" : result.status === "cancelled" ? "not_applied" : "completed", evidence: evidence(result), modelFeedback: { stage: result.stage, status: result.status, nextStep: nextStep(result.stage) } };
      } finally { signal.removeEventListener("abort", cancel); }
    },
  };
}
