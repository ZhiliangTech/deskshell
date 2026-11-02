import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { TaskStore } from "../../storage/src/task-store.ts";
import { ModelError } from "../../models/src/deepseek.ts";
import { BudgetError } from "../../models/src/budget.ts";
import { NotepadTaskError } from "../../runtime/src/notepad-task.ts";
import type { JsonValue, ModelProposal, ProposalRequest, ProposalResult, SkillDescription, SimpleSchema } from "../../models/src/deepseek.ts";

export interface AutonomyEnvelope {
  workflow: { id: string; version: string };
  goal: { intent: string; criteria: JsonValue };
  /** Trusted local bindings. They are never automatically sent as model context. */
  resources: Record<string, JsonValue>;
  allowedCapabilities: string[];
  /** IDs of resources the approved session may change or create. */
  allowedOutputs: string[];
  maxRounds: number;
  /** Absolute wall-time allowance starting at first activation, including pauses. */
  maxDurationMs: number;
}
export interface AutonomyObservation {
  state: JsonValue;
  /** Only this adapter-selected observation crosses the model boundary. */
  modelContext: JsonValue;
}
export interface AutonomyGoalResult { satisfied: boolean; detail: string }
export interface AutonomyAction {
  capabilities: string[];
  resourceIds: string[];
  outputIds: string[];
  effect: "read" | "write";
  payload: JsonValue;
}
export interface AutonomyExecutionResult {
  outcome: "completed" | "not_applied" | "unknown";
  evidence: JsonValue;
  /** Explicitly permitted feedback; local evidence and exception text are not sent automatically. */
  modelFeedback?: JsonValue;
}
export interface AutonomyAdapter {
  id: string;
  version: string;
  /** Must cover trusted adapter code/dependencies; an identifier alone is not a code sandbox. */
  revision(): string;
  skills: readonly SkillDescription[];
  observe(input: { envelope: AutonomyEnvelope; signal: AbortSignal }): AutonomyObservation | Promise<AutonomyObservation>;
  verify(input: { envelope: AutonomyEnvelope; observation: AutonomyObservation; signal: AbortSignal }): AutonomyGoalResult | Promise<AutonomyGoalResult>;
  validate(input: { envelope: AutonomyEnvelope; observation: AutonomyObservation; proposal: ModelProposal; signal: AbortSignal }): AutonomyAction | Promise<AutonomyAction>;
  execute(input: { envelope: AutonomyEnvelope; observation: AutonomyObservation; action: AutonomyAction; operationId: string; signal: AbortSignal }): AutonomyExecutionResult | Promise<AutonomyExecutionResult>;
}
export interface AutonomyBackend { propose(request: ProposalRequest): Promise<ProposalResult> }
export interface AutonomyHostOptions {
  /** Must already be designated as private application state by the trusted host. */
  dataDir: string;
  adapter: AutonomyAdapter;
  backend?: AutonomyBackend;
  backendFactory?: (input: { sessionId: string; envelope: AutonomyEnvelope; remainingRounds: number; signal: AbortSignal }) => AutonomyBackend | Promise<AutonomyBackend>;
}
export type AutonomyStatus = "awaiting_approval" | "ready" | "running" | "cancelling" | "paused" | "succeeded" | "cancelled" | "partial" | "exhausted" | "needs_attention";
export interface PreparedAutonomySession {
  formatVersion: 1;
  sessionId: string;
  digest: string;
  adapterFingerprint: string;
  envelope: AutonomyEnvelope;
  createdAt: number;
  expiresAt: number;
}
export interface AutonomyApprovalReceipt { approvalId: string; sessionId: string; digest: string; expiresAt: number }
export interface AutonomyRunRequest { sessionId: string; digest: string; approvalReceiptId: string }
export interface AutonomyRound {
  index: number;
  operationId: string;
  status: "observing" | "goal_satisfied" | "requesting" | "proposed" | "rejected" | "effect_intent" | "effect_completed" | "verified" | "not_applied" | "needs_attention" | "cancelled";
  startedAt: number;
  updatedAt: number;
  observation?: AutonomyObservation;
  afterObservation?: AutonomyObservation;
  proposal?: ModelProposal;
  action?: AutonomyAction;
  execution?: AutonomyExecutionResult;
  goal?: AutonomyGoalResult;
  request?: { requestId: string; model: string; usage: ProposalResult["usage"]; estimatedCostUsd: number };
  requestStatus?: "requesting" | "completed" | "unknown";
  errorCode?: string;
}
export interface AutonomyEvent { sequence: number; at: number; type: string; round?: number; data: JsonValue }
export interface AutonomySession {
  sessionId: string;
  digest: string;
  status: AutonomyStatus;
  prepared: PreparedAutonomySession;
  startedAt?: number;
  deadlineAt?: number;
  updatedAt: number;
  rounds: AutonomyRound[];
  events: AutonomyEvent[];
  goal?: AutonomyGoalResult;
  hasEffects: boolean;
  error?: { code: string; message: string };
}
export class AutonomyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "AutonomyError"; this.code = code; }
}

// These fixed diagnostics are local output, never exception messages or arbitrary
// adapter/provider strings. Unrecognized classes and codes keep the generic result.
const diagnosticCodes = {
  autonomy: new Set(["INVALID_DATA", "DATA_LIMIT", "WORKFLOW_MISMATCH", "INVALID_ENVELOPE", "INVALID_SCHEMA", "INVALID_ADAPTER", "INVALID_PROPOSAL", "ENVELOPE_VIOLATION", "INVALID_OBSERVATION", "INVALID_GOAL_RESULT", "INVALID_EFFECT_RESULT", "INVALID_AUTONOMY_CONFIG", "AUTONOMY_HOST_BUSY", "UNSUPPORTED_AUTONOMY_STORE", "CORRUPT_AUTONOMY_STORE", "AUTONOMY_STORE_FAILED", "AUTONOMY_HOST_CLOSED", "SESSION_NOT_FOUND", "STALE_SESSION", "DIGEST_MISMATCH", "SESSION_STATE", "APPROVAL_EXPIRED", "INVALID_REQUEST", "APPROVAL_REQUIRED", "INVALID_BACKEND", "INVALID_MODEL_RESULT"]),
  model: new Set(["INVALID_DATA", "INVALID_SCHEMA", "INVALID_REQUEST", "INVALID_RESPONSE", "INVALID_CONFIG", "CREDENTIAL_IN_PAYLOAD", "INPUT_LIMIT", "BUDGET_EXCEEDED", "DAILY_BUDGET_EXCEEDED", "BUDGET_STORE_FAILED", "BUDGET_SETTLEMENT_FAILED", "RESPONSE_LIMIT", "OUTPUT_LIMIT", "OUTPUT_TRUNCATED", "MODEL_REFUSAL", "NO_PROPOSAL", "INVALID_PROPOSAL", "TIMEOUT", "CANCELLED", "AUTH_FAILED", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "HTTP_ERROR", "TRANSPORT_ERROR"]),
  budget: new Set(["INVALID_BUDGET_ARGUMENT", "BUDGET_STORE_FAILED", "BUDGET_CONFIG_MISMATCH", "INVALID_BUDGET_CLOCK", "BUDGET_RESERVATION_CONFLICT", "DAILY_BUDGET_EXCEEDED", "BUDGET_RESERVATION_NOT_FOUND", "BUDGET_SETTLEMENT_CONFLICT"]),
  application: new Set(["PLAN_SCOPE_MISMATCH", "INVALID_INTENT", "INVALID_ROUND_LIMIT", "INVALID_NEXT_STEP", "TASK_STATE", "HOST_BUSY", "HOST_CLOSED", "TASK_NOT_FOUND", "PLAN_NOT_FOUND", "CORRUPT_PLAN", "SOURCE_CHANGED", "DESTINATION_CHANGED", "DESTINATION_EXISTS", "PERMISSION_DENIED", "DRIVER_CHANGED", "RUNTIME_CHANGED", "PLAN_EXPIRED", "COPY_NOT_VERIFIED", "DOCUMENT_CHANGED", "BUFFER_CHANGED", "CAPABILITY_UNAVAILABLE", "INVALID_OBSERVATION", "CORRUPT_APPROVAL", "EFFECT_UNCERTAIN", "UI_OPERATION_PENDING", "PHASE_MISMATCH", "APPROVAL_REQUIRED", "APPROVAL_EXPIRED", "UI_TIMEOUT", "CANCELLED",
    "GUARD_INPUT_CHANGED", "GUARD_INPUT_ACTIVITY_DETECTED", "GUARD_UNAVAILABLE", "GUARD_WINDOW_CHANGED", "GUARD_PROCESS_CHANGED", "GUARD_UNLEASED_EVENT", "GUARD_UNEXPECTED_DIALOG", "GUARD_DIALOG_LEFT_OPEN", "GUARD_LEASE_EXPIRED", "GUARD_PUMP_GAP", "GUARD_INPUT_UNAVAILABLE", "GUARD_HOOK_FAILED", "GUARD_PROTOCOL_FAILED", "GUARD_PARENT_EXITED", "GUARD_PIPE_FAILED", "GUARD_SESSION_EXPIRED", "GUARD_BINDING_STATE", "GUARD_CLOSED", "GUARD_COMMAND_TIMEOUT", "GUARD_EXITED", "GUARD_HEARTBEAT_LOST", "GUARD_INVALID_BINDING", "GUARD_INVALID_CONFIG", "GUARD_INVALID_OPERATION", "GUARD_LEASE_STATE", "GUARD_NOT_STARTED", "GUARD_OPERATION_FAILED", "GUARD_START_TIMEOUT", "GUARD_TRANSPORT_FAILED", "GUARD_WINDOWS_REQUIRED"]),
};
function diagnosticCode(error: unknown, fallback: string): string {
  const allowed = error instanceof AutonomyError ? diagnosticCodes.autonomy : error instanceof ModelError ? diagnosticCodes.model
    : error instanceof BudgetError ? diagnosticCodes.budget : error instanceof NotepadTaskError ? diagnosticCodes.application : undefined;
  return allowed && allowed.has((error as { code: string }).code) ? (error as { code: string }).code : fallback;
}

const fail = (code: string, message: string): never => { throw new AutonomyError(code, message); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) fail("INVALID_DATA", "Unsupported object fields");
}
function json<T>(value: T, maximum = 65_536): T {
  const seen = new Set<object>(); let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 16) fail("DATA_LIMIT", "Data is too deep or large");
    if (item === null || typeof item === "boolean" || typeof item === "string" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item)) fail("INVALID_DATA", "Only acyclic finite JSON data is allowed");
    seen.add(item);
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1) fail("INVALID_DATA", "Sparse or extended arrays are unsupported");
      for (const child of item) visit(child, depth + 1);
    } else {
      if (!plain(item) || Reflect.ownKeys(item).some((key) => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(item, key)!))) fail("INVALID_DATA", "Only plain JSON objects are allowed");
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0); const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maximum) fail("DATA_LIMIT", "Data exceeds its byte allowance");
  return JSON.parse(encoded) as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown): string => createHash("sha256").update(canonical(json(value))).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function identifiers(value: unknown, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 32 || value.some((entry) => !id(entry)) || new Set(value).size !== value.length) fail("INVALID_DATA", "Identifiers must be a bounded unique list");
}
function envelopeOf(value: AutonomyEnvelope, adapter: AutonomyAdapter): AutonomyEnvelope {
  fields(value, ["workflow", "goal", "resources", "allowedCapabilities", "allowedOutputs", "maxRounds", "maxDurationMs"]);
  fields(value.workflow, ["id", "version"]); fields(value.goal, ["intent", "criteria"]);
  if (value.workflow.id !== adapter.id || value.workflow.version !== adapter.version) fail("WORKFLOW_MISMATCH", "The selected adapter does not match the envelope");
  if (typeof value.goal.intent !== "string" || !value.goal.intent.trim() || Buffer.byteLength(value.goal.intent, "utf8") > 2048 || !Object.hasOwn(value.goal, "criteria")) fail("INVALID_ENVELOPE", "A bounded goal and explicit trusted criteria are required");
  if (!plain(value.resources) || !Object.keys(value.resources).length || Object.keys(value.resources).length > 32 || Object.keys(value.resources).some((name) => !id(name))) fail("INVALID_ENVELOPE", "Resources require stable identifiers and trusted bindings");
  identifiers(value.allowedCapabilities); identifiers(value.allowedOutputs, true);
  if (value.allowedOutputs.some((name) => !Object.hasOwn(value.resources, name))) fail("INVALID_ENVELOPE", "Every output must have a trusted resource binding");
  if (!Number.isSafeInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 20 || !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1 || value.maxDurationMs > 600_000) fail("INVALID_ENVELOPE", "Sessions require 1–20 rounds and at most ten minutes");
  return json(value);
}
function schemaOf(schema: SimpleSchema, depth = 0): void {
  if (depth > 8 || !plain(schema)) fail("INVALID_SCHEMA", "Invalid skill schema");
  const extras: Record<string, string[]> = { object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"], string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] };
  if (!Object.hasOwn(extras, schema.type)) fail("INVALID_SCHEMA", "Unsupported schema type");
  fields(schema, ["type", "description", "enum", ...extras[schema.type]]);
  if (schema.description !== undefined && typeof schema.description !== "string") fail("INVALID_SCHEMA", "Invalid schema description");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value)))) fail("INVALID_SCHEMA", "Invalid schema enum");
  if (schema.type === "object") {
    if (!plain(schema.properties) || schema.additionalProperties !== false || Object.keys(schema.properties).length > 64) fail("INVALID_SCHEMA", "Object schemas must declare closed properties");
    for (const child of Object.values(schema.properties)) schemaOf(child, depth + 1);
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string" || !Object.hasOwn(schema.properties!, name)) || new Set(schema.required).size !== schema.required.length)) fail("INVALID_SCHEMA", "Invalid required properties");
  }
  if (schema.type === "array") schemaOf(schema.items!, depth + 1);
  for (const field of ["minimum", "maximum"] as const) if (schema[field] !== undefined && !Number.isFinite(schema[field])) fail("INVALID_SCHEMA", "Invalid numeric schema bound");
  for (const field of ["minItems", "maxItems", "minLength", "maxLength"] as const) if (schema[field] !== undefined && (!Number.isSafeInteger(schema[field]) || schema[field]! < 0)) fail("INVALID_SCHEMA", "Invalid size schema bound");
  for (const [a, b] of [["minimum", "maximum"], ["minItems", "maxItems"], ["minLength", "maxLength"]] as const) if (schema[a] !== undefined && schema[b] !== undefined && schema[a]! > schema[b]!) fail("INVALID_SCHEMA", "Contradictory schema bounds");
}
function conforms(value: unknown, schema: SimpleSchema): boolean {
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string" && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity);
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every((item) => conforms(item, schema.items!));
    case "object": return plain(value) && (schema.required ?? []).every((name) => Object.hasOwn(value, name)) && Object.entries(value).every(([name, item]) => Object.hasOwn(schema.properties!, name) && conforms(item, schema.properties![name]));
  }
}
function skillsOf(adapter: AutonomyAdapter): SkillDescription[] {
  if (!id(adapter.id) || !id(adapter.version) || !Array.isArray(adapter.skills) || !adapter.skills.length || adapter.skills.length > 16) fail("INVALID_ADAPTER", "A bounded trusted workflow registry is required");
  const skills = json([...adapter.skills], 16_384); const ids = new Set<string>();
  for (const skill of skills) {
    fields(skill, ["id", "version", "description", "argsSchema"]);
    if (!id(skill.id) || !id(skill.version) || typeof skill.description !== "string" || !skill.description.trim() || ids.has(skill.id)) fail("INVALID_ADAPTER", "Invalid or duplicate skill description");
    ids.add(skill.id); schemaOf(skill.argsSchema);
    if (skill.argsSchema.type !== "object") fail("INVALID_SCHEMA", "Skill arguments must be a closed object");
  }
  return skills;
}
function proposalOf(value: ModelProposal, skills: SkillDescription[]): ModelProposal {
  fields(value, ["skillId", "version", "args", "goalCriteria"]); const candidate = json(value, 16_384);
  const skill = skills.find((item) => item.id === candidate.skillId && item.version === candidate.version);
  if (!skill || !plain(candidate.args) || !plain(candidate.goalCriteria) || !conforms(candidate.args, skill.argsSchema)) fail("INVALID_PROPOSAL", "Proposal does not match the trusted skill contract");
  return candidate;
}
function actionOf(value: AutonomyAction, envelope: AutonomyEnvelope): AutonomyAction {
  fields(value, ["capabilities", "resourceIds", "outputIds", "effect", "payload"]);
  identifiers(value.capabilities); identifiers(value.resourceIds); identifiers(value.outputIds, true);
  if (!["read", "write"].includes(value.effect) || !Object.hasOwn(value, "payload")
      || value.capabilities.some((name) => !envelope.allowedCapabilities.includes(name))
      || value.resourceIds.some((name) => !Object.hasOwn(envelope.resources, name))
      || value.outputIds.some((name) => !envelope.allowedOutputs.includes(name) || !value.resourceIds.includes(name))
      || value.effect === "write" && !value.outputIds.length || value.effect === "read" && value.outputIds.length) fail("ENVELOPE_VIOLATION", "Action exceeds the approved capabilities, resources, or output scope");
  return json(value, 16_384);
}
function observationOf(value: AutonomyObservation): AutonomyObservation {
  fields(value, ["state", "modelContext"]);
  if (!Object.hasOwn(value, "state") || !Object.hasOwn(value, "modelContext")) fail("INVALID_OBSERVATION", "Observation must separate local state from model context");
  json(value.modelContext, 4096); return json(value);
}
function goalOf(value: AutonomyGoalResult): AutonomyGoalResult {
  fields(value, ["satisfied", "detail"]);
  if (typeof value.satisfied !== "boolean" || typeof value.detail !== "string" || value.detail.length > 2048) fail("INVALID_GOAL_RESULT", "Local verification must return a bounded goal result");
  return json(value);
}
function executionOf(value: AutonomyExecutionResult): AutonomyExecutionResult {
  fields(value, ["outcome", "evidence", "modelFeedback"]);
  if (!["completed", "not_applied", "unknown"].includes(value.outcome) || !Object.hasOwn(value, "evidence")) fail("INVALID_EFFECT_RESULT", "An effect must report its actual known outcome");
  if (value.modelFeedback !== undefined) json(value.modelFeedback, 2048);
  return json(value);
}
const sessionDigest = (prepared: PreparedAutonomySession): string => { const { digest: _, ...body } = prepared; return hash(body); };
const terminal = new Set<AutonomyStatus>(["succeeded", "cancelled", "partial", "exhausted", "needs_attention"]);
const liveStores = new Set<string>();
type SessionData = Omit<AutonomySession, "rounds" | "events">;

/** Cooperative host controller: adapters are trusted code, not a third-party sandbox. */
export function createAutonomyHost(options: AutonomyHostOptions) {
  if (!isMainThread) fail("INVALID_AUTONOMY_CONFIG", "Autonomy must be owned by the main host thread");
  if (!!options.backend === !!options.backendFactory) fail("INVALID_AUTONOMY_CONFIG", "Provide exactly one backend or backendFactory");
  const adapter = options.adapter; const skills = skillsOf(adapter);
  const fingerprint = (): string => {
    const revision = adapter.revision();
    if (typeof revision !== "string" || !revision.trim() || revision.length > 4096) fail("INVALID_ADAPTER", "Adapter revision must cover trusted code");
    return hash({ id: adapter.id, version: adapter.version, revision, skills: skillsOf(adapter) });
  };
  const initialFingerprint = fingerprint();
  const directory = path.resolve(options.dataDir); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonicalDir = fs.realpathSync.native(directory); const storeKey = process.platform === "win32" ? canonicalDir.toLowerCase() : canonicalDir;
  if (liveStores.has(storeKey)) fail("AUTONOMY_HOST_BUSY", "This process already owns the autonomy database");
  // TaskStore permits multiple connections in the same verified host process. Holding
  // one prevents another process from opening this directory while either host lives.
  const ownership = new TaskStore(canonicalDir);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path.join(canonicalDir, "autonomy.sqlite"));
    db.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    const application = Number(db.prepare("PRAGMA application_id").get()?.application_id);
    if (version === 0 && application === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE sessions(session_id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT;
        CREATE TABLE approvals(approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), digest TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
        CREATE TABLE rounds(session_id TEXT NOT NULL REFERENCES sessions(session_id), round_index INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(session_id,round_index)) STRICT;
        CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id), at INTEGER NOT NULL, type TEXT NOT NULL, round_index INTEGER, data_json TEXT NOT NULL) STRICT;
        PRAGMA application_id=1146306865; PRAGMA user_version=1; COMMIT;`);
    } else if (version !== 1 || application !== 1146306865) fail("UNSUPPORTED_AUTONOMY_STORE", "Unrecognized autonomy database format");
    if (db.prepare("PRAGMA quick_check").all().some((row) => Object.values(row)[0] !== "ok")) fail("CORRUPT_AUTONOMY_STORE", "Autonomy database integrity check failed");
  } catch (error) { try { db!?.close(); } finally { ownership.close(); } throw error instanceof AutonomyError ? error : new AutonomyError("AUTONOMY_STORE_FAILED", "Autonomy storage could not be opened"); }
  liveStores.add(storeKey);
  let closed = false; let active = false;
  const controls = new Map<string, AbortController>();
  const pendingEffects = new Set<Promise<unknown>>();
  const ensureOpen = (): void => { if (closed) fail("AUTONOMY_HOST_CLOSED", "Autonomy host is closed"); };
  const transaction = <T>(work: () => T): T => {
    ensureOpen(); db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* Keep the original failure. */ } throw error; }
  };
  const event = (sessionId: string, type: string, data: JsonValue = null, round?: number): void => {
    db.prepare("INSERT INTO events(session_id,at,type,round_index,data_json) VALUES(?,?,?,?,?)").run(sessionId, Date.now(), type, round ?? null, JSON.stringify(json(data)));
  };
  const readData = (sessionId: string): SessionData => {
    ensureOpen(); const row = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId);
    if (!row) return fail("SESSION_NOT_FOUND", "Unknown autonomy session");
    const session = JSON.parse(String(row.payload_json)) as SessionData;
    if (session.sessionId !== row.session_id || session.status !== row.status || session.digest !== row.digest || session.prepared.sessionId !== session.sessionId || session.prepared.digest !== session.digest || sessionDigest(session.prepared) !== session.digest) fail("CORRUPT_AUTONOMY_STORE", "Session columns or envelope digest disagree");
    return session;
  };
  const inspect = (sessionId: string): AutonomySession => {
    const data = readData(sessionId);
    const rounds = db.prepare("SELECT round_index,payload_json FROM rounds WHERE session_id=? ORDER BY round_index").all(sessionId).map((row) => {
      const round = JSON.parse(String(row.payload_json)) as AutonomyRound;
      if (round.index !== row.round_index) fail("CORRUPT_AUTONOMY_STORE", "Round identity mismatch"); return round;
    });
    if (rounds.some((round, index) => round.index !== index + 1) || rounds.length > data.prepared.envelope.maxRounds) fail("CORRUPT_AUTONOMY_STORE", "Round sequence is invalid");
    const events = db.prepare("SELECT * FROM events WHERE session_id=? ORDER BY sequence").all(sessionId).map((row): AutonomyEvent => ({ sequence: Number(row.sequence), at: Number(row.at), type: String(row.type), ...(row.round_index === null ? {} : { round: Number(row.round_index) }), data: JSON.parse(String(row.data_json)) }));
    return { ...data, rounds, events };
  };
  const save = (session: SessionData, type: string, round?: AutonomyRound, eventData: JsonValue = null): void => transaction(() => {
    session.updatedAt = Date.now();
    const encoded = JSON.stringify(json(session, 131_072));
    const changed = db.prepare("UPDATE sessions SET status=?,payload_json=? WHERE session_id=? AND digest=?").run(session.status, encoded, session.sessionId, session.digest);
    if (Number(changed.changes) !== 1) fail("SESSION_NOT_FOUND", "Session disappeared while recording progress");
    if (round) {
      round.updatedAt = Date.now();
      db.prepare("INSERT INTO rounds(session_id,round_index,payload_json) VALUES(?,?,?) ON CONFLICT(session_id,round_index) DO UPDATE SET payload_json=excluded.payload_json")
        .run(session.sessionId, round.index, JSON.stringify(json(round, 196_608)));
    }
    event(session.sessionId, type, eventData, round?.index);
  });
  // Opening another same-process TaskStore connection does not recover anything;
  // autonomy alone owns its state transitions, and only this constructor handles restart.
  try {
    for (const row of db.prepare("SELECT session_id FROM sessions WHERE status IN ('running','cancelling')").all()) {
      const session = readData(String(row.session_id)); session.status = "needs_attention";
      session.error = { code: "INTERRUPTED", message: "Previous round was interrupted; inspect its effect before starting new work" };
      const rounds = inspect(session.sessionId).rounds; const last = rounds.at(-1);
      if (last) { last.status = "needs_attention"; last.errorCode = "INTERRUPTED"; if (last.requestStatus === "requesting") last.requestStatus = "unknown"; }
      save(session, "interrupted", last);
    }
  } catch (error) { db.close(); ownership.close(); liveStores.delete(storeKey); throw error; }

  const fresh = (session: SessionData): void => {
    if (session.prepared.adapterFingerprint !== initialFingerprint || fingerprint() !== initialFingerprint) fail("STALE_SESSION", "Trusted adapter code or schema changed; prepare a new envelope");
  };
  const prepare = (value: AutonomyEnvelope): PreparedAutonomySession => {
    ensureOpen(); const envelope = envelopeOf(value, adapter); const createdAt = Date.now();
    if (fingerprint() !== initialFingerprint) fail("STALE_SESSION", "Adapter changed after host creation");
    const prepared: PreparedAutonomySession = { formatVersion: 1, sessionId: `autonomy-${randomUUID()}`, digest: "", adapterFingerprint: initialFingerprint, envelope, createdAt, expiresAt: createdAt + 600_000 };
    prepared.digest = sessionDigest(prepared);
    const session: SessionData = { sessionId: prepared.sessionId, digest: prepared.digest, status: "awaiting_approval", prepared, updatedAt: createdAt, hasEffects: false };
    transaction(() => { db.prepare("INSERT INTO sessions(session_id,digest,status,payload_json) VALUES(?,?,?,?)").run(session.sessionId, session.digest, session.status, JSON.stringify(session)); event(session.sessionId, "prepared", { digest: session.digest }); });
    return json(prepared);
  };
  const approve = (sessionId: string, digest: string): AutonomyApprovalReceipt => {
    const session = readData(sessionId); fresh(session);
    if (session.digest !== digest) fail("DIGEST_MISMATCH", "Approval must match the exact envelope digest");
    if (!["awaiting_approval", "ready"].includes(session.status)) fail("SESSION_STATE", "This envelope cannot receive a new approval");
    if (Date.now() >= session.prepared.expiresAt) fail("APPROVAL_EXPIRED", "Prepare a fresh envelope");
    const receipt = { approvalId: `autonomy-approval-${randomUUID()}`, sessionId, digest, expiresAt: session.prepared.expiresAt };
    transaction(() => {
      db.prepare("INSERT INTO approvals(approval_id,session_id,digest,expires_at) VALUES(?,?,?,?)").run(receipt.approvalId, sessionId, digest, receipt.expiresAt);
      session.status = "ready"; session.updatedAt = Date.now();
      db.prepare("UPDATE sessions SET status=?,payload_json=? WHERE session_id=?").run(session.status, JSON.stringify(session), sessionId); event(sessionId, "approved", { digest });
    });
    return receipt;
  };
  const cancel = (sessionId: string): AutonomySession => {
    const session = readData(sessionId);
    if (terminal.has(session.status)) return inspect(sessionId);
    controls.get(sessionId)?.abort();
    session.status = controls.has(sessionId) ? "cancelling" : session.hasEffects ? "partial" : "cancelled";
    session.error = { code: "CANCELLED", message: "Cancellation requested; already produced effects are preserved" };
    save(session, "cancel_requested"); return inspect(sessionId);
  };

  const drive = async (request: AutonomyRunRequest, signal: AbortSignal | undefined, oneRound: boolean): Promise<AutonomySession> => {
    ensureOpen(); fields(request, ["sessionId", "digest", "approvalReceiptId"]);
    if (Object.keys(request).length !== 3 || Object.values(request).some((value) => typeof value !== "string" || !value.trim() || value.length > 256)) fail("INVALID_REQUEST", "Run requires an exact session, digest, and approval receipt");
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail("INVALID_REQUEST", "Invalid cancellation signal");
    const input = json(request); let session = readData(input.sessionId);
    if (session.digest !== input.digest) fail("DIGEST_MISMATCH", "Run differs from the approved envelope");
    const approval = db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(input.approvalReceiptId);
    if (!approval || approval.session_id !== session.sessionId || approval.digest !== session.digest) fail("APPROVAL_REQUIRED", "A trusted approval for this exact envelope is required");
    if (terminal.has(session.status)) return inspect(session.sessionId);
    if (active || pendingEffects.size) fail("AUTONOMY_HOST_BUSY", "Another round or unresolved in-flight effect still owns this adapter");
    fresh(session);
    if (signal?.aborted) return cancel(session.sessionId);
    if (!["ready", "paused"].includes(session.status)) fail("SESSION_STATE", "Only approved or verified paused sessions can run");
    transaction(() => {
      session = readData(input.sessionId);
      if (session.startedAt === undefined) {
        if (approval.consumed !== 0 || Date.now() >= Number(approval.expires_at)) fail("APPROVAL_EXPIRED", "The first activation requires a live unconsumed approval");
        session.startedAt = Date.now(); session.deadlineAt = session.startedAt + session.prepared.envelope.maxDurationMs;
        db.prepare("UPDATE approvals SET consumed=1 WHERE approval_id=? AND consumed=0").run(input.approvalReceiptId);
      } else if (approval.consumed !== 1) fail("APPROVAL_REQUIRED", "Resume with the approval that activated this envelope");
      session.status = "running"; session.updatedAt = Date.now();
      db.prepare("UPDATE sessions SET status='running',payload_json=? WHERE session_id=?").run(JSON.stringify(session), session.sessionId);
      event(session.sessionId, "activated", { mode: oneRound ? "advance" : "run", deadlineAt: session.deadlineAt! });
    });
    active = true;
    const controller = new AbortController(); controls.set(session.sessionId, controller);
    let timedOut = false; let phase = "observe"; let effectStarted = false; let cancellationRecordFailed = false;
    let round: AutonomyRound | undefined; let backend: AutonomyBackend | undefined;
    const onCancel = (): void => {
      try { cancel(session.sessionId); } catch { cancellationRecordFailed = true; controller.abort(); }
    };
    signal?.addEventListener("abort", onCancel, { once: true });
    if (signal?.aborted) onCancel();
    const deadline = session.deadlineAt!;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    const checkpoint = (): void => {
      if (Date.now() >= deadline) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) fail(timedOut ? "DURATION_LIMIT" : "CANCELLED", timedOut ? "The approved session duration has elapsed" : "Session cancellation requested");
      fresh(session);
    };
    const bounded = async <T>(operation: () => T | Promise<T>, effect = false): Promise<T> => {
      checkpoint();
      const pending = Promise.resolve().then(() => { checkpoint(); if (effect) effectStarted = true; return operation(); });
      if (effect) {
        pendingEffects.add(pending);
        void pending.then(() => pendingEffects.delete(pending), () => pendingEffects.delete(pending));
      }
      let abort!: () => void;
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new AutonomyError(timedOut ? "DURATION_LIMIT" : "CANCELLED", "The bounded operation was stopped"));
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      try { const result = await Promise.race([pending, stopped]); checkpoint(); return result; }
      finally { controller.signal.removeEventListener("abort", abort); }
    };
    const finishBoundary = (): AutonomySession | undefined => {
      checkpoint();
      if (round!.index >= session.prepared.envelope.maxRounds) {
        session.status = "exhausted"; session.error = { code: "ROUND_LIMIT", message: "The approved round budget is exhausted; existing effects were preserved" };
        save(session, "round_limit", round); return inspect(session.sessionId);
      }
      if (oneRound) { session.status = "paused"; save(session, "paused_at_verified_boundary", round); return inspect(session.sessionId); }
      return undefined;
    };
    try {
      while (true) {
        await new Promise<void>((resolve) => setImmediate(resolve)); checkpoint();
        const previousRounds = inspect(session.sessionId).rounds;
        if (previousRounds.length >= session.prepared.envelope.maxRounds) {
          session.status = "exhausted"; session.error = { code: "ROUND_LIMIT", message: "The approved round budget is exhausted" }; save(session, "round_limit"); return inspect(session.sessionId);
        }
        round = { index: previousRounds.length + 1, operationId: `autonomy-effect-${randomUUID()}`, status: "observing", startedAt: Date.now(), updatedAt: Date.now() };
        save(session, "round_started", round);
        const envelope = session.prepared.envelope;
        phase = "observe";
        const observation = observationOf(await bounded(() => adapter.observe({ envelope: json(envelope), signal: controller.signal })));
        round.observation = observation;
        phase = "verify";
        const initialGoal = goalOf(await bounded(() => adapter.verify({ envelope: json(envelope), observation: json(observation), signal: controller.signal })));
        round.goal = initialGoal; session.goal = initialGoal;
        if (initialGoal.satisfied) {
          round.status = "goal_satisfied"; session.status = "succeeded"; delete session.error;
          save(session, "local_goal_satisfied", round); return inspect(session.sessionId);
        }
        phase = "backend"; checkpoint();
        round.status = "requesting"; round.requestStatus = "requesting"; save(session, "model_request_started", round);
        if (!backend) backend = options.backend ?? await bounded(() => options.backendFactory!({ sessionId: session.sessionId, envelope: json(envelope), remainingRounds: envelope.maxRounds - previousRounds.length, signal: controller.signal }));
        if (!backend || typeof backend.propose !== "function") fail("INVALID_BACKEND", "Backend factory did not supply a proposal interface");
        const previous = previousRounds.at(-1);
        const feedback = previous?.execution?.modelFeedback ?? (previous ? { status: previous.status, code: previous.errorCode ?? null } : null);
        const requestIntent = JSON.stringify({ goal: envelope.goal.intent, observation: observation.modelContext, previousStepFeedback: feedback });
        const result = await bounded(() => backend!.propose({ intent: requestIntent, skills: json(skills), signal: controller.signal }));
        // Persist normalized request metadata, never raw provider responses or internal reasoning.
        if (!id(result.requestId) || !id(result.model) || !Number.isFinite(result.estimatedCostUsd) || result.estimatedCostUsd < 0) fail("INVALID_MODEL_RESULT", "Backend returned invalid request metadata");
        round.request = json({ requestId: result.requestId, model: result.model, usage: result.usage, estimatedCostUsd: result.estimatedCostUsd });
        round.requestStatus = "completed";
        phase = "validate";
        let action: AutonomyAction;
        try {
          const proposal = proposalOf(result.proposal, skills); round.proposal = proposal;
          round.status = "proposed"; save(session, "model_proposal_received", round);
          action = actionOf(await bounded(() => adapter.validate({ envelope: json(envelope), observation: json(observation), proposal: json(proposal), signal: controller.signal })), envelope);
        } catch (error) {
          checkpoint();
          round.status = "rejected";
          round.errorCode = error instanceof AutonomyError && ["ENVELOPE_VIOLATION", "INVALID_PROPOSAL", "INVALID_DATA", "DATA_LIMIT"].includes(error.code) ? error.code : "VALIDATION_REJECTED";
          save(session, "proposal_rejected", round, { code: round.errorCode });
          const done = finishBoundary(); if (done) return done; continue;
        }
        checkpoint(); round.action = action; round.status = "effect_intent";
        save(session, "effect_intent", round, { operationId: round.operationId });
        // Durable I/O may have consumed time or delivered an explicit local cancellation.
        checkpoint(); phase = "execute"; effectStarted = false;
        const execution = executionOf(await bounded(() => adapter.execute({ envelope: json(envelope), observation: json(observation), action: json(action), operationId: round!.operationId, signal: controller.signal }), true));
        if (execution.outcome === "unknown") {
          round.execution = execution; round.status = "needs_attention"; round.errorCode = "EFFECT_OUTCOME_UNKNOWN";
          session.status = "needs_attention"; session.error = { code: "EFFECT_OUTCOME_UNKNOWN", message: "The adapter cannot verify the effect; it will not be replayed" };
          save(session, "effect_unknown", round); return inspect(session.sessionId);
        }
        round.execution = execution; round.status = execution.outcome === "not_applied" ? "not_applied" : "effect_completed";
        if (execution.outcome === "completed" && action.effect === "write") session.hasEffects = true;
        save(session, execution.outcome === "not_applied" ? "effect_not_applied" : "effect_completed", round);
        effectStarted = false;
        phase = "observe";
        const after = observationOf(await bounded(() => adapter.observe({ envelope: json(envelope), signal: controller.signal })));
        phase = "verify";
        const verified = goalOf(await bounded(() => adapter.verify({ envelope: json(envelope), observation: json(after), signal: controller.signal })));
        round.afterObservation = after; round.goal = verified; session.goal = verified; round.status = "verified";
        if (verified.satisfied) {
          session.status = "succeeded"; delete session.error;
          save(session, "local_goal_satisfied", round); return inspect(session.sessionId);
        }
        save(session, "round_verified", round);
        const done = finishBoundary(); if (done) return done;
      }
    } catch (error) {
      const stopped = controller.signal.aborted || error instanceof AutonomyError && ["CANCELLED", "DURATION_LIMIT"].includes(error.code);
      const unknownEffect = effectStarted;
      const code = cancellationRecordFailed ? "CANCEL_RECORD_FAILED" : unknownEffect ? "EFFECT_OUTCOME_UNKNOWN"
        : stopped ? timedOut ? "DURATION_LIMIT" : "CANCELLED"
          : diagnosticCode(error, phase === "backend" ? "MODEL_REQUEST_FAILED" : "ADAPTER_OPERATION_FAILED");
      session.status = unknownEffect || cancellationRecordFailed || !stopped ? "needs_attention" : session.hasEffects ? "partial" : timedOut ? "exhausted" : "cancelled";
      session.error = { code, message: unknownEffect ? "An effect may have happened; inspect it before starting new work" : "The session stopped within its approved envelope; inspect the recorded status" };
      if (round) { round.status = session.status === "cancelled" || session.status === "partial" || session.status === "exhausted" ? "cancelled" : "needs_attention"; round.errorCode = code; if (round.requestStatus === "requesting") round.requestStatus = "unknown"; }
      save(session, "session_stopped", round, { code }); return inspect(session.sessionId);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", onCancel); controls.delete(session.sessionId); active = false;
    }
  };
  const assertIdle = (): void => {
    ensureOpen();
    if (active || pendingEffects.size) fail("AUTONOMY_HOST_BUSY", "Wait for active or unresolved in-flight adapter work before closing");
  };
  return Object.freeze({
    sessions: Object.freeze({
      prepare, inspect,
      list: (): AutonomySession[] => { ensureOpen(); return db.prepare("SELECT session_id FROM sessions ORDER BY rowid").all().map((row) => inspect(String(row.session_id))); },
      run: (request: AutonomyRunRequest, signal?: AbortSignal) => drive(request, signal, false),
      advance: (request: AutonomyRunRequest, signal?: AbortSignal) => drive(request, signal, true),
      cancel,
    }),
    approvals: Object.freeze({ approve }),
    assertIdle,
    close(): void {
      assertIdle();
      try { db.close(); } finally { ownership.close(); liveStores.delete(storeKey); closed = true; }
    },
  });
}
