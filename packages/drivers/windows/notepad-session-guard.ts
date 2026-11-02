import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NotepadGuardBinding { pid: number; startedTicks: string; hwnd: string; documentRuntimeId: number[]; tabRuntimeId: number[] }
export type NotepadGuardOperation = "open" | "observe" | "edit" | "save-copy";
/** Only permits the helper to CHECK an existing lease; never to create or renew one. */
export interface NotepadGuardLease { version: 1; pipe: string; nonce: string; leaseId: string; inputTick: number }
export interface NotepadSessionGuard {
  readonly signal: AbortSignal;
  revision(): string;
  start(): Promise<void>;
  bind(binding: NotepadGuardBinding): Promise<void>;
  assertHealthy(): Promise<void>;
  withLease<T>(kind: NotepadGuardOperation, operation: (signal: AbortSignal, lease: NotepadGuardLease) => Promise<T>): Promise<T>;
  close(): void;
}
export class NotepadGuardError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "NotepadGuardError"; this.code = code; }
}
/** Trusted operation failures keep their fixed diagnostic code after the guard
 * is invalidated. Arbitrary callback exceptions never cross this boundary. */
export class NotepadGuardOperationError extends Error {
  readonly code: string;
  constructor(code: string) {
    if (!/^[A-Z0-9_]{1,80}$/.test(code)) throw new NotepadGuardError("GUARD_INVALID_OPERATION");
    super(code); this.name = "NotepadGuardOperationError"; this.code = code;
  }
}
/** Trusted synthetic transport for offline tests. It is not an IPC/model configuration option. */
export type NotepadGuardTransport = (events: { data(chunk: Buffer | string): void; closed(): void; error(): void }) => { write(line: string): void; close(): void };
export interface NotepadGuardOptions {
  transport?: NotepadGuardTransport;
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  commandTimeoutMs?: number;
  leaseTimeoutMs?: number;
}
const script = fileURLToPath(new URL("./notepad-session-guard.ps1", import.meta.url));
const source = fileURLToPath(new URL("./notepad-session-guard.cs", import.meta.url));
export function notepadSessionGuardRevision(): string {
  return createHash("sha256").update(fs.readFileSync(import.meta.filename)).update(fs.readFileSync(script)).update(fs.readFileSync(source)).digest("hex");
}
const nativeTransport: NotepadGuardTransport = (events) => {
  if (process.platform !== "win32") throw new NotepadGuardError("GUARD_WINDOWS_REQUIRED");
  const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", events.data); child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
  child.on("close", events.closed); child.on("error", events.error); child.stdin.on("error", events.error);
  return { write(line) { child.stdin.write(line); }, close() { child.kill(); } };
};
const codes = new Set(["GUARD_INPUT_CHANGED", "GUARD_WINDOW_CHANGED", "GUARD_PROCESS_CHANGED", "GUARD_UNLEASED_EVENT", "GUARD_UNEXPECTED_DIALOG", "GUARD_DIALOG_LEFT_OPEN", "GUARD_LEASE_EXPIRED", "GUARD_PUMP_GAP", "GUARD_INPUT_UNAVAILABLE", "GUARD_HOOK_FAILED", "GUARD_PROTOCOL_FAILED", "GUARD_PARENT_EXITED", "GUARD_PIPE_FAILED", "GUARD_SESSION_EXPIRED"]);
const plain = (value: unknown): value is Record<string, any> => !!value && Object.getPrototypeOf(value) === Object.prototype;
function bindingOf(value: NotepadGuardBinding): NotepadGuardBinding {
  if (!plain(value) || Object.keys(value).some((key) => !["pid", "startedTicks", "hwnd", "documentRuntimeId", "tabRuntimeId"].includes(key))
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[1-9][0-9]{0,20}$/.test(value.startedTicks) || !/^[1-9][0-9]{0,19}$/.test(value.hwnd)
    || [value.documentRuntimeId, value.tabRuntimeId].some((ids) => !Array.isArray(ids) || !ids.length || ids.length > 64 || ids.some((id) => !Number.isSafeInteger(id)))) throw new NotepadGuardError("GUARD_INVALID_BINDING");
  return JSON.parse(JSON.stringify(value));
}

/**
 * Cooperative continuity guard, not native path discovery or an adversarial UI sandbox.
 * ANY input in this interactive desktop session invalidates it, including input in
 * other applications and input during an authorized lease. No keys or window text
 * are collected. A fresh process/session cannot recover this volatile evidence.
 */
export function createNotepadSessionGuard(options: NotepadGuardOptions = {}): NotepadSessionGuard {
  const limits = { startupTimeoutMs: options.startupTimeoutMs ?? 15_000, heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 1500, commandTimeoutMs: options.commandTimeoutMs ?? 1500, leaseTimeoutMs: options.leaseTimeoutMs ?? 30_000 };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 20 || value > (name === "leaseTimeoutMs" ? 30_000 : 15_000)) throw new NotepadGuardError("GUARD_INVALID_CONFIG");
  const controller = new AbortController(); const nonce = randomUUID(); const pipe = `deskshell-notepad-guard-${randomUUID()}`;
  let connection: ReturnType<NotepadGuardTransport> | undefined;
  let started: Promise<void> | undefined; let resolveStart!: () => void; let rejectStart!: (error: unknown) => void;
  let failure: NotepadGuardError | undefined; let ready = false; let bound = false; let lease = false; let closed = false;
  let textBuffer = ""; let sequence = 0; let inputTick = 0; let lastReceived = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined; let startup: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { resolve(value: Record<string, any>): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const invalidate = (code: string): void => {
    if (failure) return;
    failure = new NotepadGuardError(code); controller.abort(failure);
    clearInterval(watchdog); clearTimeout(startup);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); } pending.clear();
    rejectStart?.(failure); connection?.close();
  };
  const check = (): void => {
    if (failure) throw failure;
    if (closed) throw new NotepadGuardError("GUARD_CLOSED");
    if (!ready) throw new NotepadGuardError("GUARD_NOT_STARTED");
    if (performance.now() - lastReceived > limits.heartbeatTimeoutMs) { invalidate("GUARD_HEARTBEAT_LOST"); throw failure; }
  };
  const onData = (chunk: Buffer | string): void => {
    if (failure || closed) return;
    textBuffer += String(chunk);
    if (Buffer.byteLength(textBuffer) > 32_768) { invalidate("GUARD_PROTOCOL_FAILED"); return; }
    let end: number;
    while ((end = textBuffer.indexOf("\n")) >= 0) {
      const line = textBuffer.slice(0, end); textBuffer = textBuffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (!plain(frame) || frame.version !== 1 || frame.nonce !== nonce || frame.sequence !== sequence + 1
          || !["ready", "heartbeat", "reply", "invalid"].includes(frame.type)) throw new Error();
        sequence = frame.sequence; lastReceived = performance.now();
        if (frame.type === "invalid") { invalidate(codes.has(frame.code) ? frame.code : "GUARD_PROTOCOL_FAILED"); return; }
        if (frame.type === "ready") {
          if (ready || !Number.isSafeInteger(frame.inputTick) || frame.inputTick < 0 || frame.inputTick > 0xffffffff) throw new Error();
          inputTick = frame.inputTick; ready = true; clearTimeout(startup); resolveStart(); continue;
        }
        if (!ready || frame.inputTick !== inputTick) { invalidate("GUARD_INPUT_CHANGED"); return; }
        if (frame.type === "reply") {
          const work = pending.get(frame.requestId); if (!work || frame.ok !== true) throw new Error();
          pending.delete(frame.requestId); clearTimeout(work.timer); work.resolve(frame);
        }
      } catch { invalidate("GUARD_PROTOCOL_FAILED"); return; }
    }
  };
  const start = (): Promise<void> => {
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.reject(new NotepadGuardError("GUARD_CLOSED"));
    if (started) return started;
    started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    startup = setTimeout(() => invalidate("GUARD_START_TIMEOUT"), limits.startupTimeoutMs);
    try {
      connection = (options.transport ?? nativeTransport)({ data: onData, closed: () => invalidate("GUARD_EXITED"), error: () => invalidate("GUARD_TRANSPORT_FAILED") });
      connection.write(JSON.stringify({ version: 1, command: "start", nonce, pipe, parentPid: process.pid, leaseTimeoutMs: limits.leaseTimeoutMs }) + "\n");
      watchdog = setInterval(() => { if (ready && performance.now() - lastReceived > limits.heartbeatTimeoutMs) invalidate("GUARD_HEARTBEAT_LOST"); }, Math.min(100, limits.heartbeatTimeoutMs));
    } catch { invalidate("GUARD_TRANSPORT_FAILED"); }
    return started;
  };
  const request = async (command: string, data: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    await start(); check(); const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => invalidate("GUARD_COMMAND_TIMEOUT"), limits.commandTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try { connection!.write(JSON.stringify({ version: 1, nonce, requestId, command, ...data }) + "\n"); }
      catch { invalidate("GUARD_TRANSPORT_FAILED"); }
    });
  };
  return {
    signal: controller.signal, revision: notepadSessionGuardRevision, start,
    async bind(value) {
      if (bound || lease) throw new NotepadGuardError("GUARD_BINDING_STATE");
      await request("bind", { binding: bindingOf(value) }); bound = true;
    },
    async assertHealthy() { await request("check"); check(); },
    async withLease<T>(kind: NotepadGuardOperation, operation: (signal: AbortSignal, proof: NotepadGuardLease) => Promise<T>): Promise<T> {
      if (!["open", "observe", "edit", "save-copy"].includes(kind) || typeof operation !== "function") throw new NotepadGuardError("GUARD_INVALID_OPERATION");
      await start(); check();
      if (lease || kind === "open" && bound || kind !== "open" && !bound) throw new NotepadGuardError("GUARD_LEASE_STATE");
      lease = true; const leaseId = randomUUID(); let abort!: () => void;
      try {
        await request("begin", { kind, leaseId });
        const stopped = new Promise<never>((_, reject) => { abort = () => reject(failure ?? new NotepadGuardError("GUARD_CLOSED")); controller.signal.addEventListener("abort", abort, { once: true }); });
        check();
        const proof: NotepadGuardLease = Object.freeze({ version: 1, pipe, nonce, leaseId, inputTick });
        const result = await Promise.race([Promise.resolve().then(() => { check(); return operation(controller.signal, proof); }), stopped]);
        await request("end", { leaseId }); check(); return result;
      } catch (error) {
        // A known monitoring fault always takes priority. Otherwise preserve the
        // first trusted operation failure while permanently disabling this guard;
        // running end() now could hide it behind a secondary open-dialog failure.
        if (failure) throw failure;
        invalidate("GUARD_OPERATION_FAILED");
        throw error instanceof NotepadGuardOperationError ? error : failure;
      }
      finally { lease = false; if (abort) controller.signal.removeEventListener("abort", abort); }
    },
    close() { if (closed) return; closed = true; invalidate("GUARD_CLOSED"); },
  };
}
