/** Protocol and lifecycle tests use synthetic metadata only. No native guard is started. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createNotepadSessionGuard, notepadSessionGuardRevision, NotepadGuardOperationError } from "../packages/drivers/windows/notepad-session-guard.ts";
import type { NotepadGuardTransport, NotepadGuardOptions } from "../packages/drivers/windows/notepad-session-guard.ts";

const binding = { pid: 123, startedTicks: "123456789", hwnd: "321", documentRuntimeId: [1, 2], tabRuntimeId: [3, 4] };
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
class SyntheticMonitor {
  events?: Parameters<NotepadGuardTransport>[0];
  nonce = ""; sequence = 0; inputTick = 8675309; closed = false; bound = false; currentLease: string | undefined;
  requests: Record<string, any>[] = [];
  heartbeat?: ReturnType<typeof setInterval>;
  onCommand?: (value: Record<string, any>) => boolean;
  transport: NotepadGuardTransport = (events) => {
    this.events = events;
    return { write: (line) => {
      const value = JSON.parse(line); this.requests.push(value);
      if (value.command === "start") {
        this.nonce = value.nonce;
        queueMicrotask(() => { this.emit("ready"); this.heartbeat = setInterval(() => this.emit("heartbeat"), 10); }); return;
      }
      if (this.onCommand?.(value)) return;
      if (value.command === "bind") this.bound = true;
      if (value.command === "begin") this.currentLease = value.leaseId;
      if (value.command === "end") this.currentLease = undefined;
      queueMicrotask(() => this.emit("reply", { requestId: value.requestId, ok: true }));
    }, close: () => { this.closed = true; clearInterval(this.heartbeat); } };
  };
  emit(type: string, fields: Record<string, unknown> = {}) {
    if (!this.closed) this.events!.data(JSON.stringify({ version: 1, nonce: this.nonce, sequence: ++this.sequence, type, inputTick: this.inputTick, ...fields }) + "\n");
  }
  humanInput() { this.emit("invalid", { code: "GUARD_INPUT_CHANGED" }); }
}
function setup(options: NotepadGuardOptions = {}) {
  const monitor = new SyntheticMonitor();
  const guard = createNotepadSessionGuard({ transport: monitor.transport, commandTimeoutMs: 100, heartbeatTimeoutMs: 100, startupTimeoutMs: 100, ...options });
  return { monitor, guard };
}
async function opened(guard: ReturnType<typeof createNotepadSessionGuard>) { await guard.start(); await guard.withLease("open", async () => true); await guard.bind(binding); }
let passed = 0;
async function test(name: string, action: () => Promise<void>) { await action(); passed++; console.log(`PASS ${name}`); }

await test("construction is inert and opening binds one continuously monitored generation", async () => {
  const { monitor, guard } = setup();
  try {
    assert.equal(monitor.events, undefined); assert.match(guard.revision(), /^[a-f0-9]{64}$/); assert.equal(guard.revision(), notepadSessionGuardRevision());
    await Promise.all([guard.start(), guard.start()]); assert.equal(monitor.requests.filter((r) => r.command === "start").length, 1);
    const output = await guard.withLease("open", async (signal, proof) => {
      assert.equal(signal.aborted, false); assert.equal(proof.inputTick, monitor.inputTick); assert.equal(proof.version, 1); assert.match(proof.pipe, /^deskshell-notepad-guard-/);
      assert.equal(Object.isFrozen(proof), true); assert.equal(proof.leaseId, monitor.currentLease); return "opened";
    });
    assert.equal(output, "opened"); await guard.bind(binding); await guard.assertHealthy();
    assert.equal(monitor.bound, true); assert.equal(guard.signal.aborted, false);
    assert.equal(monitor.requests.some((request) => Object.hasOwn(request, "text") || Object.hasOwn(request, "sourcePath")), false);
  } finally { guard.close(); }
});

await test("leases bind each operation and cannot overlap, reopen, or rebind a document", async () => {
  const { monitor, guard } = setup(); const gate = deferred<void>();
  try {
    await opened(guard); const active = guard.withLease("edit", async () => { await gate.promise; }); await tick();
    await assert.rejects(guard.withLease("save-copy", async () => {}), hasCode("GUARD_LEASE_STATE"));
    gate.resolve(); await active;
    await guard.withLease("observe", async () => {}); await guard.withLease("save-copy", async () => {});
    await assert.rejects(guard.withLease("open", async () => {}), hasCode("GUARD_LEASE_STATE"));
    await assert.rejects(guard.bind(binding), hasCode("GUARD_BINDING_STATE"));
    assert.deepEqual(monitor.requests.filter((r) => r.command === "begin").map((r) => r.kind), ["open", "edit", "observe", "save-copy"]);
  } finally { gate.resolve(); guard.close(); }
});

await test("manual input between open and bind permanently rejects cached path continuity", async () => {
  const { monitor, guard } = setup();
  try { await guard.withLease("open", async () => {}); monitor.humanInput(); await assert.rejects(guard.bind(binding), hasCode("GUARD_INPUT_CHANGED")); assert.equal(guard.signal.aborted, true); assert.equal(monitor.closed, true); }
  finally { guard.close(); }
});

await test("input during a save lease aborts its helper and is never forgiven by lease completion", async () => {
  const { monitor, guard } = setup(); const gate = deferred<void>(); let helperSignal: AbortSignal | undefined;
  try {
    await opened(guard); const operation = guard.withLease("save-copy", async (signal) => { helperSignal = signal; await gate.promise; return "late effect"; });
    await tick(); monitor.humanInput(); await assert.rejects(operation, hasCode("GUARD_INPUT_CHANGED")); assert.equal(helperSignal?.aborted, true);
    gate.resolve(); await tick(); await assert.rejects(guard.assertHealthy(), hasCode("GUARD_INPUT_CHANGED"));
    assert.equal(monitor.requests.filter((r) => r.command === "end").length, 1, "Only the earlier open lease ended");
  } finally { gate.resolve(); guard.close(); }
});

await test("an unleased modal, replaced window, lost hook or pump gap invalidates subsequent input", async () => {
  for (const reason of ["GUARD_UNLEASED_EVENT", "GUARD_UNEXPECTED_DIALOG", "GUARD_WINDOW_CHANGED", "GUARD_PROCESS_CHANGED", "GUARD_HOOK_FAILED", "GUARD_PUMP_GAP"]) {
    const { monitor, guard } = setup(); let executed = false;
    try { await opened(guard); monitor.emit("invalid", { code: reason }); await assert.rejects(guard.withLease("edit", async () => { executed = true; }), hasCode(reason)); assert.equal(executed, false); }
    finally { guard.close(); }
  }
});

await test("missing heartbeats and process exit fail closed even when a helper promise never settles", async () => {
  for (const reason of ["silence", "exit"]) {
    const { monitor, guard } = setup({ heartbeatTimeoutMs: 40 });
    try {
      await opened(guard); const operation = guard.withLease("edit", async () => new Promise(() => {})); await tick();
      if (reason === "exit") monitor.events!.closed(); else clearInterval(monitor.heartbeat);
      await assert.rejects(operation, hasCode(reason === "exit" ? "GUARD_EXITED" : "GUARD_HEARTBEAT_LOST")); assert.equal(guard.signal.aborted, true);
    } finally { guard.close(); }
  }
});

await test("sequence gaps, wrong generations and malformed frames cannot renew monitoring health", async () => {
  for (const scenario of ["gap", "nonce", "malformed", "unknown-request", "tick-change"]) {
    const { monitor, guard } = setup();
    try {
      await opened(guard);
      if (scenario === "gap") { monitor.sequence++; monitor.emit("heartbeat"); }
      if (scenario === "nonce") monitor.emit("heartbeat", { nonce: "different-generation" });
      if (scenario === "malformed") monitor.events!.data("not-json\n");
      if (scenario === "unknown-request") monitor.emit("reply", { ok: true, requestId: "never-issued" });
      if (scenario === "tick-change") { monitor.inputTick--; monitor.emit("heartbeat"); }
      await assert.rejects(guard.assertHealthy(), hasCode(scenario === "tick-change" ? "GUARD_INPUT_CHANGED" : "GUARD_PROTOCOL_FAILED"));
    } finally { guard.close(); }
  }
});

await test("checkpoint timeout, lease expiry and helper rejection cannot leave a reusable guard", async () => {
  for (const scenario of ["timeout", "expiry", "helper-rejection"]) {
    const { monitor, guard } = setup();
    try {
      await opened(guard);
      if (scenario === "timeout") { monitor.onCommand = (value) => value.command === "check"; await assert.rejects(guard.assertHealthy(), hasCode("GUARD_COMMAND_TIMEOUT")); }
      if (scenario === "expiry") { const pending = guard.withLease("edit", async () => new Promise(() => {})); await tick(); monitor.emit("invalid", { code: "GUARD_LEASE_EXPIRED" }); await assert.rejects(pending, hasCode("GUARD_LEASE_EXPIRED")); }
      if (scenario === "helper-rejection") await assert.rejects(guard.withLease("edit", async () => { throw new Error("PRIVATE_HELPER_MESSAGE"); }), hasCode("GUARD_OPERATION_FAILED"));
      assert.equal(guard.signal.aborted, true); await assert.rejects(guard.start());
    } finally { guard.close(); }
  }
});

await test("close aborts an active helper without controlling or closing the application", async () => {
  const { monitor, guard } = setup(); let signal: AbortSignal | undefined;
  await opened(guard); const pending = guard.withLease("edit", async (value) => { signal = value; return await new Promise(() => {}); }); await tick(); guard.close(); guard.close();
  await assert.rejects(pending, hasCode("GUARD_CLOSED")); assert.equal(signal?.aborted, true); assert.equal(monitor.closed, true);
  assert.equal(monitor.requests.some((value) => /kill|close-window|terminate-app/.test(value.command)), false);
});

await test("trusted operation failure survives cleanup while a prior guard failure keeps precedence", async () => {
  for (const priorGuardFailure of [false, true]) {
    const { monitor, guard } = setup();
    const original = new NotepadGuardOperationError("NOTEPAD_SAVE_NOT_VERIFIED");
    try {
      await opened(guard);
      const operation = guard.withLease("save-copy", async () => {
        if (priorGuardFailure) monitor.humanInput();
        throw original;
      });
      if (priorGuardFailure) await assert.rejects(operation, hasCode("GUARD_INPUT_CHANGED"));
      else await assert.rejects(operation, (error) => error === original);
      assert.equal(guard.signal.aborted, true); assert.equal(monitor.closed, true);
      assert.equal(monitor.requests.filter((request) => request.command === "end").length, 1, "Failed save never proceeds to end/checkpoint and masks the original cause");
      await assert.rejects(guard.assertHealthy(), hasCode(priorGuardFailure ? "GUARD_INPUT_CHANGED" : "GUARD_OPERATION_FAILED"));
    } finally { guard.close(); }
  }
  assert.throws(() => new NotepadGuardOperationError("arbitrary private message"), hasCode("GUARD_INVALID_OPERATION"));
});

await test("native product monitor compiles without running or querying the desktop", async () => {
  if (process.platform !== "win32") return;
  const root = path.resolve(import.meta.dirname, "..");
  const guardSource = path.join(root, "packages/drivers/windows/notepad-session-guard.cs");
  const guardScript = path.join(root, "packages/drivers/windows/notepad-session-guard.ps1");
  const command = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -Path $args[0] -ReferencedAssemblies @('System.Windows.Forms','System.Web.Extensions','System.Core','System.Security'); $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($args[1],[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){throw 'Parse failed'}; Write-Output 'COMPILED_ONLY'";
  // Arguments are passed as an array; code paths contain no document data or UI calls.
  const escapedSource = guardSource.replaceAll("'", "''"); const escapedScript = guardScript.replaceAll("'", "''");
  const compile = command.replace("$args[0]", `'${escapedSource}'`).replace("$args[1]", `'${escapedScript}'`);
  const result = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", compile], { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, "Offline monitor compilation failed"); assert.equal(result.stdout.trim(), "COMPILED_ONLY");
  const code = fs.readFileSync(guardSource, "utf8"); assert.equal(code.includes("GetWindowText"), false); assert.equal(code.includes("GetAsyncKeyState"), false); assert.equal(code.includes("UIAutomation"), false);
});

console.log(`Notepad session guard checks passed: ${passed}`);
