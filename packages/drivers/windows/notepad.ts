import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notepadBufferToken } from "../../runtime/src/notepad-task.ts";
import type { NotepadBinding, NotepadDriver, NotepadEncoding, NotepadObservation } from "../../runtime/src/notepad-task.ts";
import { createNotepadSessionGuard, notepadSessionGuardRevision, NotepadGuardError, NotepadGuardOperationError } from "./notepad-session-guard.ts";
import type { NotepadSessionGuard } from "./notepad-session-guard.ts";

/** First-party, locally verified UIA selectors. Never accept this profile through a model or RPC request. */
export interface TrustedNotepadProfile {
  id: string; schemaVersion: 2; verified: boolean; packageVersion: "11.2607.14.0"; locale: "zh-CN";
  editor: { className: "RichEditD2DPT"; rawNewline: "cr"; editMethod: "em-replacesel" };
  menu: { fileAutomationId: "File"; fileClass: "Microsoft.UI.Xaml.Controls.MenuBarItem"; itemClass: "MenuFlyoutItem"; openName: "打开"; saveCopyName: "另存为" };
  openDialog: { className: "#32770"; filenameId: 1148; actionId: 1; cancelId: 2 };
  saveDialog: { className: "#32770"; filenameId: 1001; actionId: 1; cancelId: 2; encodingId: 0; encodingChoices: string[] };
  supportedEncodings: ["utf8"];
}
/** Explicit lab opt-in only. Never automatically enabled by service construction. */
export const NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE: Readonly<TrustedNotepadProfile> = Object.freeze({
  id: "notepad-11.2607.14.0-zh-CN-candidate-v2", schemaVersion: 2, verified: false, packageVersion: "11.2607.14.0", locale: "zh-CN",
  editor: Object.freeze({ className: "RichEditD2DPT", rawNewline: "cr", editMethod: "em-replacesel" }),
  menu: Object.freeze({ fileAutomationId: "File", fileClass: "Microsoft.UI.Xaml.Controls.MenuBarItem", itemClass: "MenuFlyoutItem", openName: "打开", saveCopyName: "另存为" }),
  openDialog: Object.freeze({ className: "#32770", filenameId: 1148, actionId: 1, cancelId: 2 }),
  saveDialog: Object.freeze({ className: "#32770", filenameId: 1001, actionId: 1, cancelId: 2, encodingId: 0, encodingChoices: Object.freeze(["ANSI", "UTF-16 LE", "UTF-16 BE", "UTF-8", "UTF-8 BOM", "GB18030"]) as unknown as string[] }),
  supportedEncodings: Object.freeze(["utf8"]) as unknown as ["utf8"],
});
export interface NativeNotepadProbe {
  appId: string; driverSessionId: string; readOnly: true; available: boolean; profileId: string | null;
  capabilities: { readBuffer: boolean; compareBeforeInput: boolean; saveCopy: boolean; inputMode: "targeted" };
  reasons: string[];
  /** Installed-package/profile metadata only; this probe never checks a live document. */
  runtimeVerified: false;
  profileVerified: boolean;
  installedVersion?: string;
}
interface NativeSession {
  pid: number; startedTicks: string; hwnd: string; documentRuntimeId: number[]; tabRuntimeId: number[]; documentPath: string; pathEvidence: "explicit-open" | "save-copy-dialog";
  sourcePath: string; sourceHash: string; sourceNewline: "none" | "lf" | "crlf"; documentNewline: "none" | "lf" | "crlf";
}
interface NativeReply { ok: true; observation?: NotepadObservation; session?: NativeSession; probe?: { available: boolean; reasons: string[]; installedVersion?: string } }
export type NotepadNativeTransport = (request: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
export class NativeNotepadError extends NotepadGuardOperationError {
  readonly reason?: string;
  constructor(code: string, reason?: string) { super(code); this.name = "NativeNotepadError"; if (reason) this.reason = reason; }
}
const APP_ID = "windows.notepad";
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HELPER = fileURLToPath(new URL("./notepad.ps1", import.meta.url));
const fail = (code: string, reason?: string): never => { throw new NativeNotepadError(code, reason); };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
function checkedReply(value: unknown): NativeReply {
  if (!record(value) || typeof value.ok !== "boolean") fail("INVALID_NOTEPAD_RESPONSE");
  if (!value.ok) {
    const code = typeof value.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : "NOTEPAD_OPERATION_FAILED";
    const reason = typeof value.reason === "string" && /^[A-Z0-9_]{1,80}$/.test(value.reason) ? value.reason : undefined;
    fail(code, reason);
  }
  return value as unknown as NativeReply;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const samePath = (a: string, b: string): boolean => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const sameBinding = (a: NotepadBinding, b: NotepadBinding): boolean => ["appId", "windowId", "documentId", "driverSessionId"].every((key) => a[key as keyof NotepadBinding] === b[key as keyof NotepadBinding]);
function checkedText(text: unknown): asserts text is string {
  if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) fail("INVALID_NOTEPAD_INPUT");
}
function checkedPath(file: unknown, exists: boolean): asserts file is string {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n"]/.test(file) || path.extname(file).toLowerCase() !== ".txt") fail("INVALID_NOTEPAD_PATH");
  if (process.platform === "win32" && (/^\\\\/.test(file) || path.parse(file).root.length !== 3 || file.slice(3).includes(":"))) fail("INVALID_NOTEPAD_PATH");
  for (let current = path.dirname(path.resolve(file)); ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_NOTEPAD_PATH");
    if (path.dirname(current) === current) break;
  }
  if (exists) {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_TEXT_BYTES) fail("INVALID_NOTEPAD_PATH");
  } else {
    try { fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    fail("COPY_ALREADY_EXISTS");
  }
}
function checkedProfile(profile: TrustedNotepadProfile, allowCandidate: boolean): TrustedNotepadProfile {
  const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : record(v) ? "{" + Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",") + "}" : JSON.stringify(v);
  if (!record(profile) || typeof profile.verified !== "boolean" || !/^[A-Za-z0-9_.-]{1,80}$/.test(profile.id)
      || canonical({ ...profile, id: NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE.id, verified: false }) !== canonical(NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE)
      || !profile.verified && !allowCandidate) fail("INVALID_NOTEPAD_PROFILE");
  return copy(profile);
}

/** Bounded private stdin/stdout IPC. File contents never enter command arguments or diagnostics. */
const nativeTransport: NotepadNativeTransport = (request, options) => new Promise((resolve, reject) => {
  if (process.platform !== "win32") { reject(new NativeNotepadError("CAPABILITY_UNAVAILABLE", "WINDOWS_REQUIRED")); return; }
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) { reject(new NativeNotepadError("NOTEPAD_REQUEST_LIMIT")); return; }
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", HELPER], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let finished = false; let bytes = 0; const chunks: Buffer[] = [];
  const done = (error?: NativeNotepadError, value?: unknown): void => {
    if (finished) return; finished = true; clearTimeout(timer); options.signal.removeEventListener("abort", abort);
    for (const chunk of chunks) chunk.fill(0);
    if (error) {
      // Await process exit when possible. An already dispatched application message
      // can still finish late; callers permanently close this uncertain session.
      let settled = false;
      const settle = (): void => {
        if (settled) return; settled = true; clearTimeout(exitTimer);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); reject(error);
      };
      const exitTimer = setTimeout(settle, 750);
      child.once("close", settle);
      if (child.exitCode !== null || child.signalCode !== null) settle();
      else {
        child.kill();
        // Closing our ends also handles a legacy child that inherited a pipe.
        // Never wait for the application's lifetime to release helper IPC.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
    } else resolve(value);
  };
  const abort = (): void => done(new NativeNotepadError("CANCELLED"));
  const timer = setTimeout(() => done(new NativeNotepadError("NOTEPAD_TIMEOUT")), options.timeoutMs);
  options.signal.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => { if (finished) { chunk.fill(0); return; } bytes += chunk.length; if (bytes > MAX_RESPONSE_BYTES) { chunk.fill(0); done(new NativeNotepadError("NOTEPAD_RESPONSE_LIMIT")); } else chunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
  child.on("error", () => done(new NativeNotepadError("NOTEPAD_TRANSPORT_FAILED")));
  child.stdin.on("error", () => done(new NativeNotepadError("NOTEPAD_TRANSPORT_FAILED")));
  child.on("close", (code) => {
    if (finished) return;
    try {
      const buffer = Buffer.concat(chunks); let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "").trim()); } finally { buffer.fill(0); }
      if (code !== 0 && (!record(value) || value.ok !== false)) return done(new NativeNotepadError("NOTEPAD_TRANSPORT_FAILED"));
      done(undefined, value);
    } catch { done(new NativeNotepadError("INVALID_NOTEPAD_RESPONSE")); }
  });
  if (options.signal.aborted) abort(); else child.stdin.end(body, "utf8");
});

/** No UI is started by construction. A profile must be locally validated before production enables it. */
export class WindowsNotepadDriver implements NotepadDriver {
  readonly appId = APP_ID;
  readonly sessionId = `notepad-${randomUUID()}`;
  readonly capabilities: Readonly<{ readBuffer: boolean; compareBeforeInput: boolean; saveCopy: boolean; inputMode: "targeted" }>;
  #profile?: TrustedNotepadProfile;
  #transport: NotepadNativeTransport;
  #timeoutMs: number;
  #session?: NativeSession;
  #busy = false;
  #closed = false;
  #current?: AbortController;
  #guard?: NotepadSessionGuard;
  constructor(options: { profile?: TrustedNotepadProfile; allowUnverifiedProfile?: boolean; transport?: NotepadNativeTransport; guard?: NotepadSessionGuard; timeoutMs?: number } = {}) {
    if (options.profile) this.#profile = checkedProfile(options.profile, options.allowUnverifiedProfile === true);
    this.#transport = options.transport ?? nativeTransport;
    this.#guard = options.guard;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) fail("INVALID_NOTEPAD_CONFIG");
    this.capabilities = Object.freeze({ readBuffer: true, compareBeforeInput: true, saveCopy: !!this.#profile, inputMode: "targeted" as const });
  }
  revision(): string { return createHash("sha256").update(fs.readFileSync(import.meta.filename)).update(fs.readFileSync(HELPER)).update(notepadSessionGuardRevision()).update(JSON.stringify(this.#profile ?? null)).digest("hex"); }
  async #call(operation: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<NativeReply> {
    if (this.#closed) fail("NOTEPAD_DRIVER_CLOSED");
    if (this.#busy) fail("NOTEPAD_DRIVER_BUSY");
    if (signal?.aborted) fail("CANCELLED");
    this.#busy = true; const controller = new AbortController(); this.#current = controller;
    const abort = (): void => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false; const deadline = Date.now() + this.#timeoutMs;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    // A stopped helper can have an unresolved UI effect. Never reuse this driver session.
    const onAbort = (): void => { this.#closed = true; this.#guard?.close(); rejectAborted(new NativeNotepadError(timedOut ? "NOTEPAD_TIMEOUT" : "CANCELLED")); };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const request = { version: 1, operation, appId: this.appId, driverSessionId: this.sessionId, profile: this.#profile ?? null, session: this.#session ?? null, ...payload };
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) fail("NOTEPAD_REQUEST_LIMIT");
      const run = async (): Promise<unknown> => {
        if (operation === "probe") {
          if (this.#session) await this.#guard!.assertHealthy();
          const result = checkedReply(await this.#transport(request, { signal: controller.signal, timeoutMs: this.#timeoutMs }));
          if (this.#session) await this.#guard!.assertHealthy(); return result;
        }
        this.#guard ??= createNotepadSessionGuard();
        await this.#guard.start(); await this.#guard.assertHealthy();
        return this.#guard.withLease(operation as "open" | "observe" | "edit" | "save-copy", async (guardSignal, lease) => {
          const combined = AbortSignal.any([controller.signal, guardSignal]);
          // Decode failures before ending the lease. A still-open owned dialog
          // must not replace the original fixed helper failure with an end error.
          return checkedReply(await this.#transport({ ...request, guard: lease }, { signal: combined, timeoutMs: this.#timeoutMs }));
        });
      };
      const value = await Promise.race([run(), aborted]);
      if (controller.signal.aborted || Date.now() >= deadline) { this.#closed = true; fail(timedOut || Date.now() >= deadline ? "NOTEPAD_TIMEOUT" : "CANCELLED"); }
      return checkedReply(value);
    } catch (error) {
      if (operation !== "probe" || error instanceof NotepadGuardError) { this.#closed = true; this.#guard?.close(); }
      if (error instanceof NativeNotepadError) throw error;
      fail(error instanceof NotepadGuardError ? error.code : "NOTEPAD_OPERATION_FAILED");
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onAbort); this.#busy = false; this.#current = undefined; }
  }
  #observation(reply: NativeReply, expectedPath: string, binding?: NotepadBinding): NotepadObservation {
    try {
    const observation = reply.observation;
    try { notepadBufferToken(observation!); } catch { fail("INVALID_NOTEPAD_RESPONSE"); }
    if (!observation || observation.appId !== this.appId || observation.driverSessionId !== this.sessionId || !observation.documentPath || !samePath(observation.documentPath, expectedPath)
        || observation.evidence.window !== "native-window" || observation.evidence.document !== "single-tab-marker" || observation.evidence.buffer !== "accessibility-text" || observation.evidence.inputMode !== "targeted"
        || binding && !sameBinding(observation, binding)) fail("NOTEPAD_BINDING_CHANGED");
    return copy(observation);
    } catch (error) { this.close(); if (error instanceof NativeNotepadError) throw error; fail("INVALID_NOTEPAD_RESPONSE"); }
  }
  #checkExpected(binding: NotepadBinding, expected: NotepadObservation, token: string): void {
    if (!this.#session || binding.appId !== this.appId || binding.driverSessionId !== this.sessionId || !sameBinding(binding, expected)
        || notepadBufferToken(expected) !== token || expected.evidence.inputMode !== "targeted" || !samePath(expected.documentPath ?? "", this.#session.documentPath)) fail("NOTEPAD_BINDING_CHANGED");
  }
  async probe(options: { readOnly?: true; signal?: AbortSignal } = {}): Promise<NativeNotepadProbe> {
    if (this.#closed) fail("NOTEPAD_DRIVER_CLOSED");
    if (options.signal?.aborted) fail("CANCELLED");
    if (options.readOnly !== undefined && options.readOnly !== true) fail("INVALID_NOTEPAD_INPUT");
    const base = { appId: this.appId, driverSessionId: this.sessionId, readOnly: true as const, profileId: this.#profile?.id ?? null, capabilities: { ...this.capabilities }, runtimeVerified: false as const, profileVerified: this.#profile?.verified === true };
    if (!this.#profile) return { ...base, available: false, reasons: ["SAVE_COPY_PROFILE_UNVERIFIED", "PROBE_METADATA_ONLY"] };
    const reply = await this.#call("probe", {}, options.signal);
    if (!reply.probe || typeof reply.probe.available !== "boolean" || !Array.isArray(reply.probe.reasons) || reply.probe.reasons.length > 32
        || reply.probe.reasons.some((reason) => typeof reason !== "string" || !/^[A-Z0-9_]{1,80}$/.test(reason))
        || reply.probe.installedVersion !== undefined && (typeof reply.probe.installedVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(reply.probe.installedVersion))) fail("INVALID_NOTEPAD_RESPONSE");
    return { ...base, available: reply.probe.available, ...(reply.probe.installedVersion ? { installedVersion: reply.probe.installedVersion } : {}), reasons: [...new Set([...reply.probe.reasons, "PROBE_METADATA_ONLY", ...(!this.#profile.verified ? ["CANDIDATE_PROFILE_REQUIRES_EXPLICIT_VALIDATION"] : [])])] };
  }
  async open(input: { sourcePath: string; expectedSourceHash: string; signal: AbortSignal }): Promise<NotepadObservation> {
    if (!this.#profile) fail("CAPABILITY_UNAVAILABLE", "SAVE_COPY_PROFILE_UNVERIFIED");
    if (this.#session) fail("CAPABILITY_UNAVAILABLE", "DRIVER_ALREADY_OWNS_DOCUMENT");
    checkedPath(input.sourcePath, true);
    if (!/^[a-f0-9]{64}$/.test(input.expectedSourceHash) || createHash("sha256").update(fs.readFileSync(input.sourcePath)).digest("hex") !== input.expectedSourceHash) fail("SOURCE_CHANGED");
    const reply = await this.#call("open", { sourcePath: path.resolve(input.sourcePath), expectedSourceHash: input.expectedSourceHash }, input.signal);
    const observation = this.#observation(reply, input.sourcePath);
    const session = reply.session;
    try {
    if (!session || !Number.isSafeInteger(session.pid) || session.pid <= 0 || !/^\d+$/.test(session.startedTicks) || !/^\d+$/.test(session.hwnd)
        || !Array.isArray(session.documentRuntimeId) || !Array.isArray(session.tabRuntimeId) || !session.documentRuntimeId.length || !session.tabRuntimeId.length
        || [...session.documentRuntimeId, ...session.tabRuntimeId].some((id) => !Number.isSafeInteger(id))
        || typeof session.sourcePath !== "string" || !samePath(session.sourcePath, input.sourcePath) || session.sourceHash !== input.expectedSourceHash
        || !["none", "lf", "crlf"].includes(session.sourceNewline) || session.documentNewline !== session.sourceNewline
        || !samePath(session.documentPath, input.sourcePath) || session.pathEvidence !== "explicit-open" || observation.modified || observation.evidence.path !== "explicit-open"
        || observation.windowId !== `${session.pid}:${session.startedTicks}:${session.hwnd}` || observation.documentId !== `document:${session.documentRuntimeId.join(".")}:tab:${session.tabRuntimeId.join(".")}`) fail("INVALID_NOTEPAD_RESPONSE");
    await this.#guard!.bind({ pid: session.pid, startedTicks: session.startedTicks, hwnd: session.hwnd, documentRuntimeId: session.documentRuntimeId, tabRuntimeId: session.tabRuntimeId }); await this.#guard!.assertHealthy();
    this.#session = copy(session); return observation;
    } catch (error) { this.close(); if (error instanceof NativeNotepadError) throw error; fail(error instanceof NotepadGuardError ? error.code : "INVALID_NOTEPAD_RESPONSE"); }
  }
  async observe(binding: NotepadBinding, signal?: AbortSignal): Promise<NotepadObservation> {
    if (!this.#session) fail("NOTEPAD_BINDING_CHANGED");
    return this.#observation(await this.#call("observe", { binding }, signal), this.#session.documentPath, binding);
  }
  async edit(input: { binding: NotepadBinding; expected: NotepadObservation; expectedToken: string; replacementText: string; signal: AbortSignal }): Promise<NotepadObservation> {
    this.#checkExpected(input.binding, input.expected, input.expectedToken); checkedText(input.replacementText);
    const rest = input.replacementText.replaceAll("\r\n", "");
    if (rest.includes("\r") || input.replacementText.includes("\r\n") && rest.includes("\n")) fail("INVALID_NOTEPAD_INPUT");
    const newline = input.replacementText.includes("\r\n") ? "crlf" : input.replacementText.includes("\n") ? "lf" : "none";
    if (this.#session!.sourceNewline !== "none" && newline !== "none" && newline !== this.#session!.sourceNewline) fail("INVALID_NOTEPAD_INPUT");
    const observed = await this.#call("edit", { binding: input.binding, expected: input.expected, replacementText: input.replacementText }, input.signal);
    const result = this.#observation(observed, this.#session!.documentPath, input.binding);
    if (result.text !== input.replacementText || !result.modified) { this.close(); fail("NOTEPAD_EDIT_NOT_VERIFIED"); }
    this.#session!.documentNewline = newline;
    return result;
  }
  async saveCopy(input: { binding: NotepadBinding; expected: NotepadObservation; expectedToken: string; copyPath: string; encoding: NotepadEncoding; signal: AbortSignal }): Promise<NotepadObservation> {
    if (!this.#profile) fail("CAPABILITY_UNAVAILABLE", "SAVE_COPY_PROFILE_UNVERIFIED");
    this.#checkExpected(input.binding, input.expected, input.expectedToken); checkedPath(input.copyPath, false);
    if (input.encoding !== "utf8" || samePath(input.copyPath, this.#session!.documentPath)) fail("INVALID_NOTEPAD_INPUT");
    const reply = await this.#call("save-copy", { binding: input.binding, expected: input.expected, copyPath: path.resolve(input.copyPath), encoding: input.encoding }, input.signal);
    const result = this.#observation(reply, input.copyPath, input.binding);
    if (result.text !== input.expected.text || result.modified || result.evidence.path !== "save-copy-dialog") { this.close(); fail("NOTEPAD_SAVE_NOT_VERIFIED"); }
    this.#session!.documentPath = path.resolve(input.copyPath); this.#session!.pathEvidence = "save-copy-dialog"; return result;
  }
  close(): void { this.#closed = true; this.#current?.abort(); this.#guard?.close(); }
}

export function createWindowsNotepadDriver(options: ConstructorParameters<typeof WindowsNotepadDriver>[0] = {}): WindowsNotepadDriver { return new WindowsNotepadDriver(options); }
