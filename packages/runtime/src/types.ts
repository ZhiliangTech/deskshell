import type { Action, ActionSummary, CapabilityId, JournalEntry, Skill, SkillManifest, StepResult } from "../../core/src/types.ts";
import type { TreeSnapshot } from "./file-plan.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TaskStatus = "awaiting_approval" | "ready" | "running" | "cancelling" | "succeeded" | "cancelled" | "partial" | "needs_attention" | "recovering" | "undone" | "restored";

export interface TaskRequest {
  skillId: string;
  root: string;
  args?: Record<string, JsonValue>;
  goal: { intent: string; criteria: JsonValue };
}

export interface PreparedPlan {
  formatVersion: 1;
  actionProtocol: "v0";
  planId: string;
  taskId: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  root: string;
  skill: { id: string; version: string; contentHash: string; manifest: SkillManifest };
  input: Record<string, JsonValue>;
  goal: { intent: string; criteria: JsonValue; validatorId: string; validatorVersion: string };
  granted: CapabilityId[];
  observation: TreeSnapshot;
  actions: Action[];
  preview: { summary?: ActionSummary; steps: StepResult[] };
}

export interface GoalResult { satisfied: boolean; detail: string }
export interface TaskResult {
  taskId: string;
  planId: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  steps: StepResult[];
  journal: JournalEntry[];
  rolledBack: number;
  goal?: GoalResult;
  error?: { code: string; message: string };
  recovery?: { recoveryId: string; mode: "undo" | "restore"; status: "running" | "cancelling" | "needs_attention" | "completed"; completedSteps: number; totalSteps: number };
}

export type RecoveryStep = { id: string; sourceActionId: string } & (
  { kind: "move"; from: string; to: string } | { kind: "remove-file" | "remove-directory"; path: string }
);
export interface RecoveryPlan {
  formatVersion: 1;
  recoveryId: string;
  taskId: string;
  planId: string;
  root: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  mode: "undo" | "restore";
  granted: CapabilityId[];
  observation: TreeSnapshot;
  originalObservation: TreeSnapshot;
  evidenceDigest: string;
  steps: RecoveryStep[];
  preview: { steps: { actionId: string; detail: string }[]; completeTreeRequired: true };
}
export interface RecoveryApprovalReceipt { approvalId: string; recoveryId: string; digest: string; expiresAt: number }
export interface RecoveryRequest { recoveryId: string; digest: string; approvalReceiptId: string }

export interface ExecuteRequest { planId: string; digest: string; approvalReceiptId: string; idempotencyKey: string }
export interface ApprovalReceipt { approvalId: string; planId: string; digest: string; expiresAt: number }

/** First-party registration is a trusted code boundary, not a sandbox. */
export interface SkillRegistration {
  skill: Skill;
  /** Must cover executable skill code and its dependencies; never supplied by a model. */
  revision(): string;
  validator: {
    id: string;
    version: string;
    verify(input: { root: string; criteria: JsonValue; actions: readonly Action[] }): GoalResult | Promise<GoalResult>;
  };
}

export interface TaskHostOptions {
  dataDir: string;
  allowedRoots: string[];
  granted: CapabilityId[];
  skills: SkillRegistration[];
  planTtlMs?: number;
}

export interface TaskService {
  prepare(request: TaskRequest): Promise<PreparedPlan>;
  inspect(planId: string): PreparedPlan;
  execute(request: ExecuteRequest): Promise<TaskResult>;
  get(taskId: string): TaskResult;
  cancel(taskId: string): TaskResult;
  list(): TaskResult[];
  prepareRecovery(taskId: string): Promise<RecoveryPlan>;
  inspectRecovery(recoveryId: string): RecoveryPlan;
  recover(request: RecoveryRequest): Promise<TaskResult>;
}
