import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { isInside } from "../../core/src/policy.ts";
import { TaskStore } from "../../storage/src/task-store.ts";
import type { JsonObject } from "../../storage/src/task-store.ts";

export type NotepadEncoding = "utf8" | "utf8-bom" | "utf16le-bom";
export type NotepadNewline = "none" | "lf" | "crlf";
export type NotepadInputMode = "foreground" | "targeted";
export interface NotepadBinding { appId: string; windowId: string; documentId: string; driverSessionId: string }
export interface NotepadObservation extends NotepadBinding {
  documentPath: string | null; windowTitle: string; text: string; modified: boolean; focused: boolean;
  evidence: {
    window: "driver-opaque" | "native-window";
    document: "driver-session-document" | "single-tab-marker";
    path: "explicit-open" | "save-copy-dialog";
    buffer: "accessibility-text" | "value-pattern";
    bufferComplete: true;
    inputMode?: NotepadInputMode;
  };
}
/**
 * Trusted driver contract: re-observe and compare expectedToken immediately before each real input.
 * Targeted mode binds each input to the observed window, selected document and control. Any global
 * keyboard fallback must independently verify the exact foreground resource immediately before use.
 */
export interface NotepadDriver {
  readonly appId: string;
  readonly sessionId: string;
  readonly capabilities: { readBuffer: boolean; compareBeforeInput: boolean; saveCopy: boolean; inputMode?: NotepadInputMode };
  revision(): string;
  open(input: { sourcePath: string; expectedSourceHash: string; signal: AbortSignal }): Promise<NotepadObservation>;
  observe(binding: NotepadBinding, signal?: AbortSignal): Promise<NotepadObservation>;
  edit(input: { binding: NotepadBinding; expected: NotepadObservation; expectedToken: string; replacementText: string; signal: AbortSignal }): Promise<NotepadObservation>;
  saveCopy(input: { binding: NotepadBinding; expected: NotepadObservation; expectedToken: string; copyPath: string; encoding: NotepadEncoding; signal: AbortSignal }): Promise<NotepadObservation>;
}
export interface NotepadFile {
  path: string; ino: string; dev: string; mtimeNs: string; size: number; hash: string;
  encoding: NotepadEncoding; newline: NotepadNewline; text: string;
}
export interface NotepadRequest { sourcePath: string; copyPath: string; desired: { appendText: string } | { expectedText: string } }
export interface NotepadPlan {
  kind: "notepad-copy"; formatVersion: 1; taskId: string; planId: string; digest: string;
  createdAt: number; expiresAt: number; root: string; source: NotepadFile; copyPath: string;
  destinationParent: { path: string; ino: string; dev: string };
  expectedText: string; expectedHash: string; expectedByteLength: number; expectedNewline: NotepadNewline;
  runtimeRevision: string;
  driver: { appId: string; sessionId: string; revision: string; inputMode: NotepadInputMode };
  preview: { steps: string[]; sourceText: string; expectedText: string; preservesOriginal: true; overwritesExisting: false };
}
export interface NotepadApproval { approvalId: string; planId: string; digest: string; expiresAt: number }
export interface NotepadExecute { planId: string; digest: string; approvalReceiptId: string }
export type NotepadPhase = "open" | "edit" | "save-copy";
export interface NotepadAdvance extends NotepadExecute { expectedPhase?: NotepadPhase }
export interface NotepadEffect {
  operationId: string; taskId: string; index: number; phase: "intent" | "verified";
  step: "open" | "edit" | "save-copy"; before: NotepadObservation | null; intendedAt: number;
  after?: NotepadObservation; resolvedAt?: number;
}
export interface NotepadResult {
  kind: "notepad-copy"; taskId: string; planId: string;
  status: "awaiting_approval" | "ready" | "running" | "cancelling" | "succeeded" | "cancelled" | "needs_attention";
  stage: "planned" | "open" | "edit" | "save-copy" | "verified";
  nextPhase: NotepadPhase | null;
  createdAt: number; updatedAt: number; journal: NotepadEffect[];
  binding?: NotepadBinding; bufferToken?: string;
  output?: NotepadFile;
  goal?: { satisfied: true; sourceUnchanged: true; copyHash: string; encoding: NotepadEncoding; newline: NotepadNewline };
  error?: { code: string; message: string };
}
export interface NotepadInspection {
  task: NotepadResult; observation?: NotepadObservation;
  goal: { satisfied: boolean; detail: string }; conflict?: { code: string };
}
export class NotepadTaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "NotepadTaskError"; this.code = code; }
}
const fail = (code: string, message: string): never => { throw new NotepadTaskError(code, message); };
const MAX_BYTES = 256 * 1024;
const live = new Set<string>();
const key = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const data = (value: unknown): JsonObject => copy(value) as JsonObject;
const hashBytes = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
/** Bind persisted authority to the local validation, storage and private-directory implementation. */
export function notepadRuntimeRevision(): string {
  const digest = createHash("sha256");
  for (const file of [import.meta.url, new URL("../../core/src/policy.ts", import.meta.url), new URL("../../storage/src/task-store.ts", import.meta.url), new URL("../windows/private-dir.ps1", import.meta.url)]) {
    const bytes = fs.readFileSync(typeof file === "string" ? new URL(file) : file);
    digest.update(String(bytes.length)); digest.update(":"); digest.update(bytes);
  }
  return digest.digest("hex");
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonical((value as JsonObject)[name])}`).join(",")}}`;
  return fail("INVALID_DATA", "Only finite plain JSON is supported");
}
function fields(value: unknown, allowed: string[], required = allowed): asserts value is JsonObject {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((name) => typeof name !== "string" || !allowed.includes(name) || !("value" in Object.getOwnPropertyDescriptor(value, name)!))
      || required.some((name) => !Object.hasOwn(value, name))) fail("INVALID_REQUEST", "Unexpected or missing request fields");
}
function label(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 8192) fail("INVALID_REQUEST", "Expected a bounded nonempty string"); }
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_BYTES || Buffer.from(value, "utf8").toString("utf8") !== value) fail("UNSUPPORTED_TEXT", "Text must be bounded Unicode without NUL or unpaired surrogates");
}
function newlineOf(value: string): NotepadNewline {
  const withoutCRLF = value.replaceAll("\r\n", "");
  if (withoutCRLF.includes("\r") || value.includes("\r\n") && withoutCRLF.includes("\n")) fail("UNSUPPORTED_NEWLINE", "Mixed or lone-CR line endings are unsupported");
  return value.includes("\r\n") ? "crlf" : value.includes("\n") ? "lf" : "none";
}
function encode(value: string, encoding: NotepadEncoding): Buffer {
  text(value);
  const content = encoding === "utf16le-bom" ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(value, "utf16le")])
    : encoding === "utf8-bom" ? Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(value, "utf8")]) : Buffer.from(value, "utf8");
  if (content.length > MAX_BYTES) fail("TEXT_LIMIT", "Encoded document exceeds the 256 KiB task limit");
  return content;
}
function exists(filename: string): boolean { try { fs.lstatSync(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function safePath(filename: string): string {
  label(filename);
  if (!path.isAbsolute(filename) || filename.includes("\0") || process.platform === "win32" && /^\\\\[?.]\\/.test(filename)) fail("INVALID_PATH", "An absolute ordinary filesystem path is required");
  const resolved = path.resolve(filename);
  if (process.platform === "win32" && resolved.slice(path.parse(resolved).root.length).split(path.sep).some((part) => /[:<>"|?*]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail("INVALID_PATH", "Ambiguous Windows path");
  for (let current = resolved; ; current = path.dirname(current)) {
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || current !== resolved && !stat.isDirectory()) fail("UNSUPPORTED_PATH", "Linked or non-directory ancestry is unsupported");
    }
    if (path.dirname(current) === current) break;
  }
  return resolved;
}
function directory(filename: string): { path: string; ino: string; dev: string } {
  const resolved = safePath(filename); const stat = fs.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DIRECTORY", "Expected an ordinary directory");
  return { path: resolved, ino: String(stat.ino), dev: String(stat.dev) };
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean { return a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink && a.mode === b.mode; }
function readFile(filename: string): NotepadFile {
  const resolved = safePath(filename); const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES)) fail("UNSUPPORTED_SOURCE", "Use a single ordinary text file of at most 256 KiB");
  const handle = fs.openSync(resolved, "r"); let bytes: Buffer;
  try {
    if (!sameStat(before, fs.fstatSync(handle, { bigint: true }))) fail("SOURCE_CHANGED", "Source changed while opening");
    bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset); if (!count) fail("SOURCE_CHANGED", "Source became shorter"); offset += count; }
    if (fs.readSync(handle, Buffer.alloc(1), 0, 1, bytes.length) || !sameStat(before, fs.fstatSync(handle, { bigint: true })) || !sameStat(before, fs.lstatSync(resolved, { bigint: true }))) fail("SOURCE_CHANGED", "Source changed during reading");
  } finally { fs.closeSync(handle); }
  let encoding: NotepadEncoding = "utf8"; let body = bytes!;
  if (body[0] === 255 && body[1] === 254) { encoding = "utf16le-bom"; body = body.subarray(2); }
  else if (body[0] === 239 && body[1] === 187 && body[2] === 191) { encoding = "utf8-bom"; body = body.subarray(3); }
  let decoded: string;
  try { decoded = new TextDecoder(encoding === "utf16le-bom" ? "utf-16le" : "utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
  catch { return fail("UNSUPPORTED_ENCODING", "Only strict UTF-8 or BOM-marked UTF-16LE are supported"); }
  text(decoded);
  return { path: resolved, ino: String(before.ino), dev: String(before.dev), mtimeNs: String(before.mtimeNs), size: Number(before.size), hash: hashBytes(bytes!), encoding, newline: newlineOf(decoded), text: decoded };
}
function bindingOf(observation: NotepadObservation): NotepadBinding {
  return { appId: observation.appId, windowId: observation.windowId, documentId: observation.documentId, driverSessionId: observation.driverSessionId };
}
function checkedObservation(value: unknown): NotepadObservation {
  if (value && typeof value === "object" && !(value as Partial<NotepadObservation>).evidence) fail("CAPABILITY_UNAVAILABLE", "Machine-readable buffer evidence is required");
  fields(value, ["appId", "windowId", "documentId", "driverSessionId", "documentPath", "windowTitle", "text", "modified", "focused", "evidence"]);
  for (const name of ["appId", "windowId", "documentId", "driverSessionId"] as const) label(value[name]);
  if (value.documentPath !== null && typeof value.documentPath !== "string" || typeof value.windowTitle !== "string" || value.windowTitle.length > 8192 || typeof value.modified !== "boolean" || typeof value.focused !== "boolean") fail("INVALID_OBSERVATION", "Invalid document observation");
  const evidence = value.evidence as NotepadObservation["evidence"];
  if (!evidence || !["accessibility-text", "value-pattern"].includes(evidence.buffer) || evidence.bufferComplete !== true) fail("CAPABILITY_UNAVAILABLE", "A complete machine-readable editor buffer is required");
  fields(evidence, ["window", "document", "path", "buffer", "bufferComplete", "inputMode"], ["window", "document", "path", "buffer", "bufferComplete"]);
  if (!["driver-opaque", "native-window"].includes(evidence.window) || !["driver-session-document", "single-tab-marker"].includes(evidence.document) || !["explicit-open", "save-copy-dialog"].includes(evidence.path)) fail("CAPABILITY_UNAVAILABLE", "Required window, document and path evidence is unavailable");
  if (Object.hasOwn(evidence, "inputMode") && !["foreground", "targeted"].includes(evidence.inputMode!)) fail("CAPABILITY_UNAVAILABLE", "Unknown input targeting evidence");
  text(value.text); newlineOf(value.text);
  return copy(value) as unknown as NotepadObservation;
}
/** Targeted input preserves actual focus in the journal, but focus changes alone do not change its token. */
export function notepadBufferToken(observation: NotepadObservation): string {
  const current = checkedObservation(observation);
  if (current.evidence.inputMode === "targeted") {
    const { focused: _focusIsNotTargetIdentity, ...target } = current;
    return hashBytes(canonical(target));
  }
  return hashBytes(canonical(current));
}

export function createNotepadTaskHost(options: { dataDir: string; allowedRoots: string[]; driver: NotepadDriver; planTtlMs?: number; stepTimeoutMs?: number }) {
  if (!isMainThread) fail("INVALID_CONFIG", "Notepad task host must run on the main thread");
  const roots = options.allowedRoots.map((root) => directory(root).path);
  if (!roots.length) fail("INVALID_CONFIG", "Explicit document roots are required");
  const state = safePath(path.resolve(options.dataDir));
  if (path.dirname(state) === state || roots.some((root) => isInside(root, state) || isInside(state, root))) fail("INVALID_STATE_SCOPE", "Task storage and document roots must be disjoint");
  const marker = path.join(state, "notepad-state.json"); const hostKey = key(state);
  if (live.has(hostKey)) fail("HOST_BUSY", "A Notepad host already owns this state directory");
  const ttl = options.planTtlMs ?? 600_000; const timeout = options.stepTimeoutMs ?? 120_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86_400_000 || !Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000) fail("INVALID_CONFIG", "Invalid Notepad task lifetime or step timeout");
  if (exists(state)) {
    directory(state);
    const names = fs.readdirSync(state);
    if (names.length && (!names.includes("notepad-state.json") || names.some((name) => !/^(notepad-state\.json|tasks\.sqlite(?:-wal|-shm|-journal)?)$/.test(name)))) fail("STATE_DIRECTORY_NOT_APP_OWNED", "Use a dedicated Notepad task state directory");
    if (exists(marker)) {
      const stat = fs.lstatSync(marker); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 || fs.readFileSync(marker, "utf8") !== '{"kind":"notepad-task","version":1}\n') fail("INVALID_STATE_DIRECTORY", "Invalid Notepad state marker");
    }
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    try { execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "../windows/private-dir.ps1"), "-Target", state], { windowsHide: true, timeout: 15_000, stdio: "ignore" }); }
    catch { fail("PRIVATE_STATE_FAILED", "Unable to protect the Notepad state directory"); }
  } else fs.chmodSync(state, 0o700);
  if (!exists(marker)) fs.writeFileSync(marker, '{"kind":"notepad-task","version":1}\n', { flag: "wx", mode: 0o600 });
  const store = new TaskStore(state);
  try { store.recoverInterrupted(); } catch (error) { store.close(); throw error; }
  live.add(hostKey);
  let closed = false; let queued = 0; let queue: Promise<unknown> = Promise.resolve();
  const controllers = new Map<string, AbortController>();
  const observationControllers = new Map<string, AbortController>();
  const pendingDriverOperations = new Set<Promise<unknown>>();
  const driver = options.driver;
  const ensureOpen = () => { if (closed) fail("HOST_CLOSED", "Notepad task host is closed"); };
  const serial = <T>(work: () => Promise<T>): Promise<T> => { ensureOpen(); queued++; const operation = queue.then(work).finally(() => { queued--; }); queue = operation.catch(() => undefined); return operation; };
  const capability = () => {
    if (!driver.capabilities?.readBuffer || !driver.capabilities.compareBeforeInput || !driver.capabilities.saveCopy) fail("CAPABILITY_UNAVAILABLE", "Machine-readable buffers, guarded input and save-copy support are required");
    if (driver.capabilities.inputMode !== undefined && !["foreground", "targeted"].includes(driver.capabilities.inputMode)) fail("CAPABILITY_UNAVAILABLE", "Unknown driver input mode");
    label(driver.appId); label(driver.sessionId); label(driver.revision());
  };
  const driverIdentity = (): NotepadPlan["driver"] => { capability(); return { appId: driver.appId, sessionId: driver.sessionId, revision: driver.revision(), inputMode: driver.capabilities.inputMode ?? "foreground" }; };
  const get = (taskId: string): NotepadResult => {
    ensureOpen(); label(taskId); const record = store.getTask(taskId);
    if (!record || record.payload.kind !== "notepad-copy") fail("TASK_NOT_FOUND", "Unknown Notepad task");
    const { authorizedApprovalId: _privateReceipt, ...payload } = copy(record.payload);
    const result = payload as unknown as NotepadResult;
    return { ...result, nextPhase: ["awaiting_approval", "ready", "running"].includes(result.status) ? result.nextPhase : null,
      journal: copy(store.effects(`notepad:${taskId}`)) as unknown as NotepadEffect[] };
  };
  const payload = (result: NotepadResult): JsonObject => {
    const approvalId = store.getTask(result.taskId)?.payload.authorizedApprovalId;
    return data({ ...result, updatedAt: Date.now(), journal: [], ...(approvalId ? { authorizedApprovalId: approvalId } : {}) });
  };
  const save = (result: NotepadResult): NotepadResult => { store.updateTask(result.taskId, payload(result)); return get(result.taskId); };
  const digest = (plan: NotepadPlan) => { const { digest: _digest, ...body } = plan; return hashBytes(canonical(body)); };
  const inspect = (planId: string): NotepadPlan => {
    ensureOpen(); label(planId); const record = store.getPlan(planId);
    if (!record || record.payload.kind !== "notepad-copy") fail("PLAN_NOT_FOUND", "Unknown Notepad plan");
    const plan = copy(record.payload) as unknown as NotepadPlan;
    if (plan.planId !== planId || plan.digest !== record.digest || digest(plan) !== record.digest) fail("CORRUPT_PLAN", "Notepad plan integrity check failed");
    return plan;
  };
  const originalUnchanged = (plan: NotepadPlan): void => { if (canonical(readFile(plan.source.path)) !== canonical(plan.source)) fail("SOURCE_CHANGED", "The original document changed"); };
  const destinationParentUnchanged = (plan: NotepadPlan): void => {
    if (canonical(directory(path.dirname(plan.copyPath))) !== canonical(plan.destinationParent)) fail("DESTINATION_CHANGED", "Destination directory changed");
  };
  const destinationFresh = (plan: NotepadPlan): void => {
    destinationParentUnchanged(plan);
    if (exists(plan.copyPath)) fail("DESTINATION_EXISTS", "Save-copy cannot overwrite an existing target");
  };
  const scopeUnchanged = (plan: NotepadPlan): void => {
    if (!roots.some((root) => isInside(root, plan.source.path) && isInside(root, plan.copyPath))) fail("PERMISSION_DENIED", "Document paths are no longer authorized");
    if (canonical(driverIdentity()) !== canonical(plan.driver)) fail("DRIVER_CHANGED", "Driver code or UI session changed");
    if (notepadRuntimeRevision() !== plan.runtimeRevision) fail("RUNTIME_CHANGED", "Task runtime or storage code changed; prepare a new plan");
    originalUnchanged(plan); destinationParentUnchanged(plan);
  };
  const fresh = (plan: NotepadPlan): void => {
    if (Date.now() >= plan.expiresAt) fail("PLAN_EXPIRED", "Prepare a new Notepad plan");
    scopeUnchanged(plan); destinationFresh(plan);
  };
  const verifiedCopy = (plan: NotepadPlan, previous?: NotepadFile): NotepadFile => {
    const target = readFile(plan.copyPath);
    if (target.hash !== plan.expectedHash || target.size !== plan.expectedByteLength || target.text !== plan.expectedText || target.encoding !== plan.source.encoding || target.newline !== plan.expectedNewline
        || previous && canonical(target) !== canonical(previous)) fail("COPY_NOT_VERIFIED", "Saved copy does not match the approved exact bytes, encoding or recorded identity");
    return target;
  };
  const observation = (plan: NotepadPlan, raw: NotepadObservation, expectedPath: string, expectedText: string, modified: boolean, binding?: NotepadBinding): NotepadObservation => {
    const observed = checkedObservation(raw);
    if (observed.appId !== plan.driver.appId || observed.driverSessionId !== plan.driver.sessionId || binding && canonical(bindingOf(observed)) !== canonical(binding)) fail("DOCUMENT_CHANGED", "The observed application, window or document identity changed");
    if ((observed.evidence.inputMode ?? "foreground") !== plan.driver.inputMode) fail("INPUT_MODE_MISMATCH", "Observed targeting evidence differs from the approved driver mode");
    if (!observed.documentPath || !path.isAbsolute(observed.documentPath) || key(path.resolve(observed.documentPath)) !== key(expectedPath)
        || (plan.driver.inputMode !== "targeted" && !observed.focused) || observed.modified !== modified || observed.text !== expectedText) fail("BUFFER_CHANGED", "Observed document path, required focus, text or dirty state differs from the approved operation");
    return observed;
  };
  const errorCode = (error: unknown): string => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "UI_OPERATION_UNCERTAIN";
  const attention = (task: NotepadResult, code: string): NotepadResult => save({ ...task, status: "needs_attention", nextPhase: null,
    error: { code, message: "UI effects are preserved. Inspect the original, copy and open document before any further action; no automatic undo or replay was attempted." } });
  const bounded = async <T>(controller: AbortController, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (controller.signal.aborted) fail("CANCELLED", "Stop requested; existing effects require inspection");
    const local = new AbortController(); let reject!: (error: unknown) => void;
    const interrupted = new Promise<never>((_resolve, failPromise) => { reject = failPromise; });
    const abort = () => { local.abort(); reject(new NotepadTaskError("CANCELLED", "UI operation cancelled; effects may already exist")); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { local.abort(); reject(new NotepadTaskError("UI_TIMEOUT", "UI operation timed out; effects require inspection")); }, timeout);
    try {
      const pending = Promise.resolve().then(() => {
        if (local.signal.aborted || controller.signal.aborted) fail("CANCELLED", "UI operation was stopped before invocation");
        return operation(local.signal);
      });
      pendingDriverOperations.add(pending);
      void pending.then(() => pendingDriverOperations.delete(pending), () => pendingDriverOperations.delete(pending));
      const result = await Promise.race([pending, interrupted]);
      if (controller.signal.aborted) fail("CANCELLED", "Stop requested; existing effects require inspection");
      return result;
    } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
  };
  const prepare = (request: NotepadRequest): Promise<NotepadPlan> => {
    fields(request, ["sourcePath", "copyPath", "desired"]);
    fields(request.desired, ["appendText", "expectedText"], []);
    if (Object.keys(request.desired).length !== 1) fail("INVALID_REQUEST", "Specify exactly one desired text operation");
    const input = copy(request);
    return serial(async () => {
      capability(); const sourcePath = safePath(input.sourcePath); const copyPath = safePath(input.copyPath);
      const root = roots.find((candidate) => isInside(candidate, sourcePath) && isInside(candidate, copyPath));
      if (!root || key(sourcePath) === key(copyPath)) fail("PERMISSION_DENIED", "Source and a distinct copy destination must share an authorized root");
      if (exists(copyPath)) fail("DESTINATION_EXISTS", "Copy destination already exists");
      const source = readFile(sourcePath); const destinationParent = directory(path.dirname(copyPath));
      if (source.dev !== destinationParent.dev) fail("UNSUPPORTED_PATH", "Source and destination must use the same filesystem");
      const desired = input.desired as { appendText?: string; expectedText?: string };
      text(Object.hasOwn(desired, "appendText") ? desired.appendText : desired.expectedText);
      const expectedText = Object.hasOwn(desired, "appendText") ? source.text + desired.appendText : desired.expectedText!;
      text(expectedText); const expectedNewline = newlineOf(expectedText);
      if (source.newline !== "none" && expectedNewline !== "none" && expectedNewline !== source.newline) fail("NEWLINE_CHANGED", "This task preserves the original line-ending convention");
      if (expectedText === source.text) fail("NO_CHANGE", "Desired document is unchanged");
      const expected = encode(expectedText, source.encoding); const id = randomUUID(); const createdAt = Date.now();
      const plan: NotepadPlan = { kind: "notepad-copy", formatVersion: 1, taskId: `notepad-task-${id}`, planId: `notepad-plan-${id}`, digest: "", createdAt, expiresAt: createdAt + ttl,
        root, source, copyPath, destinationParent, expectedText, expectedHash: hashBytes(expected), expectedByteLength: expected.length, expectedNewline, runtimeRevision: notepadRuntimeRevision(), driver: driverIdentity(),
        preview: { steps: ["Open the exact source in an isolated Notepad document", "Replace only the verified document buffer with the approved text", "Save a new copy and independently verify exact bytes while preserving the source"], sourceText: source.text, expectedText, preservesOriginal: true, overwritesExisting: false },
      };
      fresh(plan); plan.digest = digest(plan);
      const result: NotepadResult = { kind: "notepad-copy", taskId: plan.taskId, planId: plan.planId, status: "awaiting_approval", stage: "planned", nextPhase: "open", createdAt, updatedAt: createdAt, journal: [] };
      store.putPlan(plan.planId, plan.digest, data(plan), { taskId: plan.taskId, payload: data(result) });
      return copy(plan);
    });
  };
  const approve = (planId: string, approvedDigest: string): NotepadApproval => {
    const plan = inspect(planId);
    if (approvedDigest !== plan.digest) fail("DIGEST_MISMATCH", "Approval requires the exact displayed plan digest");
    const priorId = store.getTask(plan.taskId)?.payload.authorizedApprovalId;
    if (typeof priorId === "string") {
      const prior = store.getApproval(priorId);
      if (!prior || prior.planId !== planId || prior.digest !== plan.digest) fail("CORRUPT_APPROVAL", "Stored Notepad approval is inconsistent");
      return copy(prior.payload) as unknown as NotepadApproval;
    }
    const task = get(plan.taskId); if (!["awaiting_approval", "ready"].includes(task.status)) fail("TASK_STATE", "Task cannot be approved");
    fresh(plan); const receipt = { approvalId: `notepad-approval-${randomUUID()}`, planId, digest: plan.digest, expiresAt: plan.expiresAt };
    store.approve(receipt.approvalId, planId, plan.digest, data(receipt));
    store.updateTask(task.taskId, data({ ...task, status: "ready", updatedAt: Date.now(), journal: [], authorizedApprovalId: receipt.approvalId }));
    return receipt;
  };
  const cancel = (taskId: string): NotepadResult => {
    const task = get(taskId);
    observationControllers.get(taskId)?.abort();
    if (["awaiting_approval", "ready"].includes(task.status)) return save({ ...task, status: "cancelled", nextPhase: null });
    if (["running", "cancelling"].includes(task.status)) {
      const controller = controllers.get(taskId);
      if (!controller) return attention(task, "CANCELLED");
      controller.abort(); return save({ ...task, status: "cancelling", nextPhase: null });
    }
    return task;
  };
  const lastVerified = (task: NotepadResult): NotepadObservation => {
    const last = task.journal.at(-1);
    if (!last || last.phase !== "verified" || !last.after || !task.binding || task.bufferToken !== notepadBufferToken(last.after)) fail("EFFECT_UNCERTAIN", "No complete observation is available for the previous UI effect");
    return checkedObservation(last.after);
  };
  const liveObservation = async (plan: NotepadPlan, task: NotepadResult, controller: AbortController): Promise<NotepadObservation> => {
    const previous = lastVerified(task); const binding = bindingOf(previous);
    const current = observation(plan, await bounded(controller, (signal) => driver.observe(copy(binding), signal)), previous.documentPath!, previous.text, previous.modified, binding);
    if (notepadBufferToken(current) !== notepadBufferToken(previous)) fail("BUFFER_CHANGED", "The editor buffer or its binding changed since the last verified effect");
    return current;
  };
  const advanceWork = async (input: NotepadAdvance): Promise<NotepadResult> => {
      const plan = inspect(input.planId); if (input.digest !== plan.digest) fail("DIGEST_MISMATCH", "Execution must use the exact plan digest");
      let task = get(plan.taskId);
      if (!["awaiting_approval", "ready", "running"].includes(task.status)) return task;
      if (pendingDriverOperations.size) fail("UI_OPERATION_PENDING", "An earlier UI operation is still unresolved; do not start another task");
      if (input.expectedPhase && input.expectedPhase !== task.nextPhase) fail("PHASE_MISMATCH", "The requested phase is no longer the task's next phase");
      const receipt = store.getApproval(input.approvalReceiptId);
      if (!receipt || receipt.planId !== plan.planId || receipt.digest !== plan.digest
          || store.getTask(task.taskId)?.payload.authorizedApprovalId !== input.approvalReceiptId) fail("APPROVAL_REQUIRED", "A matching trusted approval is required");
      if (Number(receipt.payload.expiresAt) <= Date.now()) {
        if (task.status === "running") return attention(task, "APPROVAL_EXPIRED");
        fail("APPROVAL_EXPIRED", "Approval expired");
      }
      if (task.status !== "running") {
        fresh(plan); task = { ...task, status: "running", updatedAt: Date.now() };
        const claim = store.claim(plan.planId, plan.digest, input.approvalReceiptId, plan.taskId, payload(task)); if (!claim.claimed) return get(plan.taskId);
      } else if (receipt.consumedByTaskId !== task.taskId) fail("APPROVAL_REQUIRED", "Continuation requires the original consumed approval");
      const controller = new AbortController(); controllers.set(plan.taskId, controller);
      const checkpoint = () => { if (controller.signal.aborted) fail("CANCELLED", "Stop requested; preserve the document and inspect existing effects"); };
      const effect = async (index: number, step: NotepadEffect["step"], before: NotepadObservation | null, run: (signal: AbortSignal) => Promise<NotepadObservation>, verify: (value: NotepadObservation) => NotepadObservation): Promise<NotepadObservation> => {
        await new Promise<void>((resolve) => setImmediate(resolve)); checkpoint(); fresh(plan);
        const event: NotepadEffect = { operationId: `notepad:${plan.taskId}`, taskId: plan.taskId, index, phase: "intent", step, before: copy(before), intendedAt: Date.now() };
        store.putEffect(event.operationId, plan.taskId, index, data(event)); task = save({ ...get(plan.taskId), stage: step });
        const after = verify(await bounded(controller, (signal) => { checkpoint(); fresh(plan); return run(signal); })); scopeUnchanged(plan);
        store.putEffect(event.operationId, plan.taskId, index, data({ ...event, phase: "verified", after, resolvedAt: Date.now() }));
        task = save({ ...get(plan.taskId), binding: bindingOf(after), bufferToken: notepadBufferToken(after), nextPhase: step === "open" ? "edit" : step === "edit" ? "save-copy" : null });
        return after;
      };
      try {
        fresh(plan);
        if (task.nextPhase === "open") {
          await effect(0, "open", null, (signal) => driver.open({ sourcePath: plan.source.path, expectedSourceHash: plan.source.hash, signal }), (value) => observation(plan, value, plan.source.path, plan.source.text, false));
          return get(plan.taskId);
        }
        if (task.nextPhase !== "edit" && task.nextPhase !== "save-copy") fail("TASK_STATE", "No executable next phase is available");
        const before = await liveObservation(plan, task, controller); const binding = bindingOf(before);
        if (task.nextPhase === "edit") {
          await effect(1, "edit", before, (signal) => driver.edit({ binding: copy(binding), expected: copy(before), expectedToken: notepadBufferToken(before), replacementText: plan.expectedText, signal }), (value) => observation(plan, value, plan.source.path, plan.expectedText, true, binding));
          return get(plan.taskId);
        }
        let output: NotepadFile | undefined;
        const beforeSave = before;
        const saved = await effect(2, "save-copy", beforeSave, (signal) => driver.saveCopy({ binding: copy(binding), expected: copy(beforeSave), expectedToken: notepadBufferToken(beforeSave), copyPath: plan.copyPath, encoding: plan.source.encoding, signal }), (value) => {
          const current = observation(plan, value, plan.copyPath, plan.expectedText, false, binding);
          if (current.evidence.path !== "save-copy-dialog") fail("CAPABILITY_UNAVAILABLE", "Save-copy destination evidence is required");
          output = verifiedCopy(plan);
          return current;
        });
        checkpoint();
        const final = observation(plan, await bounded(controller, (signal) => driver.observe(copy(binding), signal)), plan.copyPath, plan.expectedText, false, binding);
        if (notepadBufferToken(final) !== notepadBufferToken(saved)) fail("COPY_NOT_VERIFIED", "Editor buffer changed during verification");
        scopeUnchanged(plan); verifiedCopy(plan, output);
        return save({ ...get(plan.taskId), status: "succeeded", stage: "verified", nextPhase: null, output,
          goal: { satisfied: true, sourceUnchanged: true, copyHash: plan.expectedHash, encoding: plan.source.encoding, newline: plan.expectedNewline } });
      } catch (error) {
        return attention(get(plan.taskId), errorCode(error));
      } finally { controllers.delete(plan.taskId); }
  };
  const executionInput = (request: NotepadAdvance, incremental: boolean): NotepadAdvance => {
    fields(request, ["planId", "digest", "approvalReceiptId", ...(incremental ? ["expectedPhase"] : [])], ["planId", "digest", "approvalReceiptId"]);
    for (const name of ["planId", "digest", "approvalReceiptId"] as const) label(request[name]);
    if (Object.hasOwn(request, "expectedPhase") && !["open", "edit", "save-copy"].includes(request.expectedPhase!)) fail("INVALID_REQUEST", "Unknown Notepad phase");
    return copy(request);
  };
  const advance = (request: NotepadAdvance): Promise<NotepadResult> => { const input = executionInput(request, true); return serial(() => advanceWork(input)); };
  const execute = (request: NotepadExecute): Promise<NotepadResult> => {
    const input = executionInput(request, false);
    return serial(async () => {
      let result = await advanceWork(input);
      while (result.status === "running" && result.nextPhase) result = await advanceWork(input);
      return result;
    });
  };
  const observe = (taskId: string, signal?: AbortSignal): Promise<NotepadInspection> => {
    label(taskId);
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail("INVALID_REQUEST", "Invalid observation cancellation signal");
    return serial(async () => {
      const task = get(taskId); const plan = inspect(task.planId);
      const controller = new AbortController(); observationControllers.set(taskId, controller);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        if (controller.signal.aborted) fail("CANCELLED", "Observation cancelled before reading");
        if (pendingDriverOperations.size) fail("UI_OPERATION_PENDING", "An earlier UI operation is still unresolved");
        scopeUnchanged(plan);
        if (["needs_attention", "cancelling"].includes(task.status)) fail(task.error?.code ?? "EFFECT_UNCERTAIN", "Existing UI effects require inspection");
        if (!task.journal.length) {
          destinationFresh(plan);
          if (task.status === "cancelled") fail("CANCELLED", "Task was cancelled");
          if (Date.now() >= plan.expiresAt) fail("PLAN_EXPIRED", "Prepare a new Notepad plan");
          return { task, goal: { satisfied: false, detail: "Source and unused destination are unchanged; no application step has run." } };
        }
        const current = await liveObservation(plan, task, controller);
        scopeUnchanged(plan);
        if (task.status === "succeeded") {
          if (!task.output || task.stage !== "verified") fail("COPY_NOT_VERIFIED", "The completed task has no recorded output identity");
          verifiedCopy(plan, task.output);
          return { task, observation: current, goal: { satisfied: true, detail: "Fresh editor, original identity and bytes, and saved copy identity, bytes, encoding and line endings match the approved result." } };
        }
        destinationFresh(plan);
        if (Date.now() >= plan.expiresAt) fail("PLAN_EXPIRED", "Prepare a new Notepad plan");
        return { task, observation: current, goal: { satisfied: false, detail: "The last application step is still verified; further approved steps remain." } };
      } catch (error) {
        return { task: get(taskId), goal: { satisfied: false, detail: "Fresh verification was cancelled or found a changed or uncertain resource; no input or save was performed." }, conflict: { code: errorCode(error) } };
      } finally { signal?.removeEventListener("abort", abort); observationControllers.delete(taskId); }
    });
  };
  const assertIdle = (): void => { ensureOpen(); if (queued || controllers.size || observationControllers.size || pendingDriverOperations.size) fail("HOST_BUSY", "Wait for pending UI work before closing"); };
  return Object.freeze({ tasks: Object.freeze({ prepare, inspect, get, observe, list: () => { ensureOpen(); return store.listTasks().map((record) => get(record.taskId)); }, advance, execute, cancel }), approvals: Object.freeze({ approve }), assertIdle,
    close(): void { assertIdle(); store.close(); closed = true; live.delete(hostKey); },
  });
}

/** The marker is synthetic data for binding a dedicated test document, never an existing user's file. */
export function createNotepadFixture(parent = os.tmpdir(), options: { encoding?: NotepadEncoding; newline?: "lf" | "crlf" } = {}) {
  const fixture = fs.mkdtempSync(path.join(path.resolve(parent), "deskshell-notepad-task-"));
  const root = path.join(fixture, "files"); fs.mkdirSync(root);
  const marker = `deskshell-notepad-${randomUUID()}`; const newline = options.newline === "lf" ? "\n" : "\r\n";
  const sourceText = `${marker}${newline}Original synthetic document.${newline}`;
  const expectedText = `${sourceText}Approved synthetic addition.${newline}`;
  const sourcePath = path.join(root, "source.txt"); const copyPath = path.join(root, "approved-copy.txt");
  fs.writeFileSync(sourcePath, encode(sourceText, options.encoding ?? "utf8"), { flag: "wx" });
  return { fixture, root, sourcePath, copyPath, stateDir: path.join(fixture, "notepad-state"), marker, sourceText, expectedText };
}
