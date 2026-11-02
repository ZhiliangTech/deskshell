/** Offline state-machine tests only. This fake driver never opens or controls a real application. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../packages/storage/src/task-store.ts";
import { createNotepadFixture, createNotepadTaskHost, notepadBufferToken, NotepadTaskError } from "../packages/runtime/src/notepad-task.ts";
import type { NotepadBinding, NotepadDriver, NotepadEncoding, NotepadObservation } from "../packages/runtime/src/notepad-task.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-notepad-check-"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const code = (value: string) => (error: unknown): boolean => !!error && typeof error === "object" && "code" in error && error.code === value;
let passed = 0;
async function test(name: string, action: () => unknown | Promise<unknown>) { await action(); passed++; console.log(`PASS ${name}`); }
function bytes(text: string, encoding: NotepadEncoding): Buffer {
  return encoding === "utf16le-bom" ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")])
    : encoding === "utf8-bom" ? Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)]) : Buffer.from(text);
}
function decoded(file: string): string {
  const buffer = fs.readFileSync(file);
  return buffer[0] === 255 && buffer[1] === 254 ? buffer.subarray(2).toString("utf16le")
    : buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191 ? buffer.subarray(3).toString("utf8") : buffer.toString("utf8");
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
class FakeNotepad implements NotepadDriver {
  readonly appId = "fixture-notepad";
  readonly sessionId = randomUUID();
  readonly capabilities: NotepadDriver["capabilities"] = { readBuffer: true, compareBeforeInput: true, saveCopy: true };
  revisionValue = "fixture-driver-v1";
  calls: string[] = [];
  state: NotepadObservation | undefined;
  beforeEdit?: () => void;
  afterEdit?: () => void;
  beforeSave?: () => void;
  afterSave?: () => void;
  onObserve?: (count: number) => void;
  openGate?: Promise<void>;
  observeGate?: Promise<void>;
  observationSignal?: AbortSignal;
  saveEncoding?: NotepadEncoding;
  badEvidence = false;
  private observes = 0;
  revision() { return this.revisionValue; }
  private checked(binding: NotepadBinding, expectedToken?: string) {
    if (!this.state || Object.entries(binding).some(([name, value]) => this.state![name as keyof NotepadObservation] !== value)
        || expectedToken !== undefined && notepadBufferToken(this.state) !== expectedToken) throw new NotepadTaskError("DRIVER_PRECONDITION_FAILED", "Fake driver detected an intervening document change");
    return this.state;
  }
  async open({ sourcePath }: Parameters<NotepadDriver["open"]>[0]): Promise<NotepadObservation> {
    this.calls.push("open"); if (this.openGate) await this.openGate;
    this.state = { appId: this.appId, driverSessionId: this.sessionId, windowId: "fixture-window", documentId: `document:${randomUUID()}:tab:${randomUUID()}`,
      documentPath: sourcePath, windowTitle: "source.txt", text: decoded(sourcePath), modified: false, focused: true,
      evidence: { window: "driver-opaque", document: "driver-session-document", path: "explicit-open", buffer: "accessibility-text", bufferComplete: true },
    };
    if (this.capabilities.inputMode) this.state.evidence.inputMode = this.capabilities.inputMode;
    if (this.badEvidence) (this.state.evidence as any).buffer = "screenshot";
    return clone(this.state);
  }
  async observe(binding: NotepadBinding, signal?: AbortSignal): Promise<NotepadObservation> {
    this.calls.push("observe"); this.observationSignal = signal; this.onObserve?.(++this.observes);
    if (this.observeGate) await this.observeGate;
    return clone(this.checked(binding));
  }
  async edit(input: Parameters<NotepadDriver["edit"]>[0]): Promise<NotepadObservation> {
    this.calls.push("edit"); this.beforeEdit?.(); const current = this.checked(input.binding, input.expectedToken);
    if (input.signal.aborted) throw new NotepadTaskError("CANCELLED", "Fake input cancelled");
    current.text = input.replacementText; current.modified = true; current.windowTitle = "*source.txt";
    this.afterEdit?.(); return clone(current);
  }
  async saveCopy(input: Parameters<NotepadDriver["saveCopy"]>[0]): Promise<NotepadObservation> {
    this.calls.push("save-copy"); this.beforeSave?.(); const current = this.checked(input.binding, input.expectedToken);
    if (input.signal.aborted) throw new NotepadTaskError("CANCELLED", "Fake save cancelled");
    fs.writeFileSync(input.copyPath, bytes(current.text, this.saveEncoding ?? input.encoding), { flag: "wx" });
    current.documentPath = input.copyPath; current.modified = false; current.windowTitle = "approved-copy.txt"; current.evidence.path = "save-copy-dialog";
    this.afterSave?.(); return clone(current);
  }
}
function setup(options: Parameters<typeof createNotepadFixture>[1] = {}, stepTimeoutMs?: number) {
  const fixture = createNotepadFixture(temporary, options); const driver = new FakeNotepad();
  const settings = { dataDir: fixture.stateDir, allowedRoots: [fixture.root], driver, ...(stepTimeoutMs ? { stepTimeoutMs } : {}) };
  const host = createNotepadTaskHost(settings);
  const prepare = () => host.tasks.prepare({ sourcePath: fixture.sourcePath, copyPath: fixture.copyPath, desired: { expectedText: fixture.expectedText } });
  return { ...fixture, driver, settings, host, prepare };
}
async function approved(f: ReturnType<typeof setup>) {
  const plan = await f.prepare(); const receipt = f.host.approvals.approve(plan.planId, plan.digest);
  return { plan, request: { planId: plan.planId, digest: plan.digest, approvalReceiptId: receipt.approvalId } };
}

try {
  await test("preview is UI-free and an exact approval produces a verified new copy without changing source", async () => {
    const f = setup(); let host = f.host;
    try {
      const original = fs.readFileSync(f.sourcePath); const { plan, request } = await approved(f);
      assert.deepEqual(f.driver.calls, []); assert.equal(fs.existsSync(f.copyPath), false);
      assert.equal("approve" in host.tasks, false); assert.equal(plan.source.newline, "crlf"); assert.equal(plan.source.encoding, "utf8");
      const result = await host.tasks.execute(request);
      assert.equal(result.status, "succeeded"); assert.equal(result.goal?.satisfied, true); assert.equal(result.goal?.sourceUnchanged, true);
      assert.equal(result.journal.length, 3); assert.ok(result.journal.every((event) => event.phase === "verified"));
      assert.equal(fs.readFileSync(f.copyPath).equals(Buffer.from(f.expectedText)), true); assert.equal(fs.readFileSync(f.sourcePath).equals(original), true);
      const calls = f.driver.calls.length; assert.deepEqual(await host.tasks.execute(request), result);
      host.close(); host = createNotepadTaskHost(f.settings);
      assert.deepEqual(host.tasks.get(plan.taskId), result); assert.deepEqual(await host.tasks.execute(request), result); assert.equal(f.driver.calls.length, calls);
    } finally { host.close(); }
  });
  await test("append and full expected text preserve UTF-8 BOM, UTF-16LE BOM and LF bytes", async () => {
    for (const encoding of ["utf8-bom", "utf16le-bom"] as const) {
      const f = setup({ encoding, newline: "lf" });
      try {
        const plan = await f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: f.copyPath, desired: { appendText: "追加内容\n" } });
        const receipt = f.host.approvals.approve(plan.planId, plan.digest);
        const result = await f.host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: receipt.approvalId });
        assert.equal(result.status, "succeeded"); assert.equal(result.goal?.encoding, encoding); assert.equal(result.goal?.newline, "lf");
        assert.equal(fs.readFileSync(f.copyPath).equals(bytes(`${f.sourceText}追加内容\n`, encoding)), true);
      } finally { f.host.close(); }
    }
  });
  await test("forged approvals, changed digests and caller mutations cannot authorize a different plan", async () => {
    const f = setup();
    try {
      const plan = await f.prepare();
      await assert.rejects(f.host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: "forged" }), code("APPROVAL_REQUIRED"));
      assert.throws(() => f.host.approvals.approve(plan.planId, "wrong"), code("DIGEST_MISMATCH"));
      const receipt = f.host.approvals.approve(plan.planId, plan.digest); plan.expectedText = "caller changed return value";
      const result = await f.host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: receipt.approvalId });
      assert.equal(result.status, "succeeded"); assert.equal(decoded(f.copyPath), f.expectedText);
    } finally { f.host.close(); }
  });
  await test("source bytes changing after approval prevent any UI operation", async () => {
    const f = setup();
    try {
      const { request } = await approved(f); fs.writeFileSync(f.sourcePath, "human updated source\r\n");
      await assert.rejects(f.host.tasks.execute(request), code("SOURCE_CHANGED"));
      assert.deepEqual(f.driver.calls, []); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { f.host.close(); }
  });
  await test("same-byte source replacement is detected through file identity", async () => {
    const f = setup();
    try {
      const { request } = await approved(f); const stat = fs.statSync(f.sourcePath); const original = fs.readFileSync(f.sourcePath);
      fs.renameSync(f.sourcePath, path.join(f.fixture, "old-source")); fs.writeFileSync(f.sourcePath, original); fs.utimesSync(f.sourcePath, stat.atime, stat.mtime);
      await assert.rejects(f.host.tasks.execute(request), code("SOURCE_CHANGED")); assert.deepEqual(f.driver.calls, []);
    } finally { f.host.close(); }
  });
  await test("save-copy cannot target source, existing files or an unauthorized root", async () => {
    const f = setup();
    try {
      await assert.rejects(f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: f.sourcePath, desired: { expectedText: f.expectedText } }), code("PERMISSION_DENIED"));
      await assert.rejects(f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: path.join(f.fixture, "outside.txt"), desired: { expectedText: f.expectedText } }), code("PERMISSION_DENIED"));
      fs.writeFileSync(f.copyPath, "existing target"); await assert.rejects(f.prepare(), code("DESTINATION_EXISTS"));
      assert.equal(decoded(f.copyPath), "existing target"); assert.deepEqual(f.driver.calls, []);
    } finally { f.host.close(); }
  });
  await test("a destination created after approval is preserved without starting UI", async () => {
    const f = setup();
    try {
      const { request } = await approved(f); fs.writeFileSync(f.copyPath, "other application copy");
      await assert.rejects(f.host.tasks.execute(request), code("DESTINATION_EXISTS")); assert.equal(decoded(f.copyPath), "other application copy"); assert.deepEqual(f.driver.calls, []);
    } finally { f.host.close(); }
  });
  await test("unsupported encodings and mixed line endings fail before UI", async () => {
    for (const [content, expected] of [[Buffer.from([128, 255]), "UNSUPPORTED_ENCODING"], [Buffer.from("one\r\ntwo\n"), "UNSUPPORTED_NEWLINE"], [Buffer.from("binary\0text"), "UNSUPPORTED_TEXT"]] as const) {
      const f = setup();
      try { fs.writeFileSync(f.sourcePath, content); await assert.rejects(f.prepare(), code(expected)); assert.deepEqual(f.driver.calls, []); }
      finally { f.host.close(); }
    }
  });
  await test("desired changes cannot silently alter the newline convention or exceed text limits", async () => {
    const f = setup();
    try {
      await assert.rejects(f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: f.copyPath, desired: { expectedText: "all LF\n" } }), code("NEWLINE_CHANGED"));
      await assert.rejects(f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: f.copyPath, desired: { appendText: "x".repeat(256 * 1024 + 1) } }), code("UNSUPPORTED_TEXT"));
      await assert.rejects(f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: f.copyPath, desired: { appendText: "" } }), code("NO_CHANGE"));
      assert.deepEqual(f.driver.calls, []);
    } finally { f.host.close(); }
  });
  await test("missing machine-readable capability is rejected before open and screenshot evidence is never accepted", async () => {
    const f = setup();
    try {
      f.driver.capabilities.readBuffer = false; await assert.rejects(f.prepare(), code("CAPABILITY_UNAVAILABLE")); assert.deepEqual(f.driver.calls, []);
      f.driver.capabilities.readBuffer = true; f.driver.badEvidence = true; const { request } = await approved(f);
      const result = await f.host.tasks.execute(request);
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "CAPABILITY_UNAVAILABLE");
      assert.deepEqual(f.driver.calls, ["open"]); assert.equal(result.journal[0].phase, "intent"); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { f.host.close(); }
  });
  await test("window or document replacement prevents editing the wrong application resource", async () => {
    for (const name of ["windowId", "documentId", "driverSessionId", "appId"] as const) {
      const f = setup();
      try {
        const { request } = await approved(f); f.driver.onObserve = () => { f.driver.state![name] = "replaced-resource"; };
        const result = await f.host.tasks.execute(request);
        assert.equal(result.status, "needs_attention"); assert.equal(f.driver.calls.includes("edit"), false); assert.equal(fs.existsSync(f.copyPath), false);
      } finally { f.host.close(); }
    }
  });
  await test("human edits observed before editing are preserved and never overwritten", async () => {
    const f = setup();
    try {
      const { request } = await approved(f); f.driver.onObserve = (count) => { if (count === 1) { f.driver.state!.text = "human unsaved change"; f.driver.state!.modified = true; } };
      const result = await f.host.tasks.execute(request);
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "BUFFER_CHANGED");
      assert.equal(f.driver.state!.text, "human unsaved change"); assert.equal(f.driver.calls.includes("edit"), false);
    } finally { f.host.close(); }
  });
  await test("driver-side compare immediately before input catches edits after host observation", async () => {
    const f = setup();
    try {
      const { request } = await approved(f); f.driver.beforeEdit = () => { f.driver.state!.text = "human race before real input"; };
      const result = await f.host.tasks.execute(request);
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "DRIVER_PRECONDITION_FAILED");
      assert.equal(f.driver.state!.text, "human race before real input"); assert.equal(f.driver.calls.includes("save-copy"), false);
      assert.equal(result.journal[1].phase, "intent");
    } finally { f.host.close(); }
  });
  await test("human changes between editing and saving stop save-copy and preserve the buffer", async () => {
    const f = setup();
    try {
      const { request } = await approved(f); f.driver.onObserve = (count) => { if (count === 2) f.driver.state!.text += "human later text"; };
      const result = await f.host.tasks.execute(request);
      assert.equal(result.status, "needs_attention"); assert.equal(f.driver.calls.includes("save-copy"), false);
      assert.ok(f.driver.state!.text.endsWith("human later text")); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { f.host.close(); }
  });
  await test("saving incorrect encoding cannot be reported as successful", async () => {
    const f = setup();
    try {
      f.driver.saveEncoding = "utf8-bom"; const { request } = await approved(f); const result = await f.host.tasks.execute(request);
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "COPY_NOT_VERIFIED"); assert.equal(result.goal, undefined);
      assert.equal(fs.existsSync(f.copyPath), true); assert.equal(decoded(f.sourcePath), f.sourceText); assert.equal(result.journal[2].phase, "intent");
    } finally { f.host.close(); }
  });
  await test("uncertain save failure preserves its copy and never retries or blindly undoes", async () => {
    const f = setup();
    try {
      f.driver.afterSave = () => { throw new Error("untrusted application exception body"); }; const { request, plan } = await approved(f);
      const result = await f.host.tasks.execute(request); const calls = f.driver.calls.length;
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "UI_OPERATION_UNCERTAIN"); assert.equal(result.goal, undefined);
      assert.equal(decoded(f.copyPath), f.expectedText); assert.equal(result.journal[2].phase, "intent");
      assert.ok(!JSON.stringify(result).includes("untrusted application exception body"));
      assert.deepEqual(await f.host.tasks.execute(request), result); assert.equal(f.driver.calls.length, calls);
      assert.equal(f.host.tasks.get(plan.taskId).status, "needs_attention");
    } finally { f.host.close(); }
  });
  await test("cancel before execution is persistent and has no UI effects", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f); assert.equal(f.host.tasks.cancel(plan.taskId).status, "cancelled");
      assert.equal((await f.host.tasks.execute(request)).status, "cancelled"); assert.deepEqual(f.driver.calls, []); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { f.host.close(); }
  });
  await test("cancel during a pending UI action preserves uncertainty and drops late observations", async () => {
    const f = setup(); const waiting = gate<void>();
    try {
      f.driver.openGate = waiting.promise; const { request, plan } = await approved(f);
      const running = f.host.tasks.execute(request);
      while (!f.driver.calls.includes("open")) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.throws(() => f.host.close(), code("HOST_BUSY")); assert.equal(f.host.tasks.cancel(plan.taskId).status, "cancelling");
      const result = await running; assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "CANCELLED");
      waiting.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(f.driver.calls, ["open"]); assert.equal(fs.existsSync(f.copyPath), false); assert.equal(f.host.tasks.get(plan.taskId).journal[0].phase, "intent");
    } finally { waiting.resolve(); f.host.close(); }
  });
  await test("UI timeout has bounded return and never starts a later effect", async () => {
    const f = setup({}, 20); const waiting = gate<void>();
    try {
      f.driver.openGate = waiting.promise; const { request } = await approved(f); const result = await f.host.tasks.execute(request);
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "UI_TIMEOUT");
      waiting.resolve(); await new Promise<void>((resolve) => setImmediate(resolve)); assert.deepEqual(f.driver.calls, ["open"]); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { waiting.resolve(); f.host.close(); }
  });
  await test("driver revision or session changes invalidate pending approvals", async () => {
    const f = setup(); let host = f.host;
    try {
      const { request } = await approved(f); f.driver.revisionValue = "fixture-driver-v2";
      await assert.rejects(host.tasks.execute(request), code("DRIVER_CHANGED")); assert.deepEqual(f.driver.calls, []);
      f.driver.revisionValue = "fixture-driver-v1"; host.close(); host = createNotepadTaskHost({ ...f.settings, driver: new FakeNotepad() });
      await assert.rejects(host.tasks.execute(request), code("DRIVER_CHANGED"));
    } finally { host.close(); }
  });
  await test("startup converts a durable interrupted claim to attention without opening Notepad", async () => {
    const f = setup(); const { request, plan } = await approved(f); const prior = f.host.tasks.get(plan.taskId); f.host.close();
    const store = new TaskStore(f.stateDir);
    try {
      store.claim(plan.planId, plan.digest, request.approvalReceiptId, plan.taskId, { ...prior, status: "running", stage: "open" });
      store.putEffect(`notepad:${plan.taskId}`, plan.taskId, 0, { operationId: `notepad:${plan.taskId}`, taskId: plan.taskId, index: 0, phase: "intent", step: "open", before: null, intendedAt: Date.now() });
    } finally { store.close(); }
    const host = createNotepadTaskHost(f.settings);
    try {
      const recovered = host.tasks.get(plan.taskId); assert.equal(recovered.status, "needs_attention"); assert.equal(recovered.error?.code, "INTERRUPTED"); assert.equal(recovered.journal[0].phase, "intent");
      assert.deepEqual(await host.tasks.execute(request), recovered); assert.deepEqual(f.driver.calls, []);
    } finally { host.close(); }
  });
  await test("state scope and ownership checks protect document directories", () => {
    const f = createNotepadFixture(temporary); const driver = new FakeNotepad();
    assert.throws(() => createNotepadTaskHost({ dataDir: f.root, allowedRoots: [f.root], driver }), code("INVALID_STATE_SCOPE"));
    fs.mkdirSync(f.stateDir); fs.writeFileSync(path.join(f.stateDir, "human.txt"), "keep");
    assert.throws(() => createNotepadTaskHost({ dataDir: f.stateDir, allowedRoots: [f.root], driver }), code("STATE_DIRECTORY_NOT_APP_OWNED"));
    assert.equal(fs.existsSync(path.join(f.root, "notepad-state.json")), false); assert.equal(fs.readFileSync(path.join(f.stateDir, "human.txt"), "utf8"), "keep");
  });
  await test("three explicit advances each perform one approved phase and reuse one private approval", async () => {
    const f = setup();
    try {
      const { plan, request } = await approved(f);
      const receipt = f.host.approvals.approve(plan.planId, plan.digest);
      assert.equal(receipt.approvalId, request.approvalReceiptId);
      assert.equal((await f.host.tasks.observe(plan.taskId)).goal.satisfied, false); assert.deepEqual(f.driver.calls, []);
      const opened = await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      assert.equal(opened.status, "running"); assert.equal(opened.stage, "open"); assert.equal(opened.nextPhase, "edit");
      assert.deepEqual(f.driver.calls, ["open"]); assert.equal(opened.journal.length, 1);
      assert.equal((await f.host.tasks.observe(plan.taskId)).conflict, undefined);
      assert.deepEqual(f.host.approvals.approve(plan.planId, plan.digest), receipt);
      const edited = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(edited.status, "running"); assert.equal(edited.nextPhase, "save-copy"); assert.equal(edited.journal.length, 2);
      assert.equal(fs.existsSync(f.copyPath), false); assert.equal(f.driver.calls.filter((call) => call === "edit").length, 1);
      assert.deepEqual(f.host.approvals.approve(plan.planId, plan.digest), receipt);
      const saved = await f.host.tasks.advance({ ...request, expectedPhase: "save-copy" });
      assert.equal(saved.status, "succeeded"); assert.equal(saved.nextPhase, null); assert.equal(saved.journal.length, 3);
      const verified = await f.host.tasks.observe(plan.taskId);
      assert.equal(verified.goal.satisfied, true); assert.equal(verified.conflict, undefined);
      assert.equal(verified.observation?.text, f.expectedText); assert.equal(saved.output?.hash, plan.expectedHash);
      assert.equal(JSON.stringify(f.host.tasks.get(plan.taskId)).includes(receipt.approvalId), false);
      assert.equal(JSON.stringify(f.host.tasks.list()).includes(receipt.approvalId), false);
      assert.equal(f.driver.calls.filter((call) => call === "open").length, 1);
      assert.equal(f.driver.calls.filter((call) => call === "save-copy").length, 1);
    } finally { f.host.close(); }
  });
  await test("concurrent or repeated requests for the same phase cannot advance a later phase", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f);
      const settled = await Promise.allSettled([f.host.tasks.advance({ ...request, expectedPhase: "open" }), f.host.tasks.advance({ ...request, expectedPhase: "open" })]);
      assert.equal(settled[0].status, "fulfilled"); assert.equal(settled[1].status, "rejected");
      assert.ok(settled[1].status === "rejected" && code("PHASE_MISMATCH")(settled[1].reason));
      assert.deepEqual(f.driver.calls, ["open"]); assert.equal(f.host.tasks.get(plan.taskId).nextPhase, "edit");
      await assert.rejects(f.host.tasks.advance({ ...request, approvalReceiptId: "forged", expectedPhase: "edit" }), code("APPROVAL_REQUIRED"));
      assert.deepEqual(f.driver.calls, ["open"]);
    } finally { f.host.close(); }
  });
  await test("fresh observation detects a human edit between rounds without writing or changing task history", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f); await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      f.driver.state!.text += "human unsaved addition"; f.driver.state!.modified = true;
      const prior = f.host.tasks.get(plan.taskId); const current = await f.host.tasks.observe(plan.taskId);
      assert.equal(current.goal.satisfied, false); assert.equal(current.conflict?.code, "BUFFER_CHANGED");
      assert.deepEqual(f.host.tasks.get(plan.taskId), prior); assert.equal(f.driver.calls.includes("edit"), false);
      const stopped = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(stopped.status, "needs_attention"); assert.equal(stopped.nextPhase, null);
      assert.ok(f.driver.state!.text.endsWith("human unsaved addition")); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { f.host.close(); }
  });
  await test("cancel between rounds preserves the opened document and prevents further input", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f); await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      const cancelled = f.host.tasks.cancel(plan.taskId);
      assert.equal(cancelled.status, "needs_attention"); assert.equal(cancelled.error?.code, "CANCELLED"); assert.equal(cancelled.nextPhase, null);
      assert.deepEqual(await f.host.tasks.advance({ ...request, expectedPhase: "edit" }), cancelled);
      assert.deepEqual(f.driver.calls, ["open"]); assert.equal(f.driver.state!.text, f.sourceText);
    } finally { f.host.close(); }
  });
  await test("startup does not resume a verified but incomplete UI phase", async () => {
    const f = setup(); let host = f.host;
    try {
      const { request, plan } = await approved(f); await host.tasks.advance({ ...request, expectedPhase: "open" });
      host.close(); host = createNotepadTaskHost(f.settings);
      const recovered = host.tasks.get(plan.taskId);
      assert.equal(recovered.status, "needs_attention"); assert.equal(recovered.nextPhase, null); assert.equal(recovered.journal[0].phase, "verified");
      assert.equal((await host.tasks.observe(plan.taskId)).conflict?.code, "INTERRUPTED");
      assert.deepEqual(await host.tasks.advance({ ...request, expectedPhase: "edit" }), recovered); assert.deepEqual(f.driver.calls, ["open"]);
    } finally { host.close(); }
  });
  await test("completed goals are independently rechecked against source bytes and target bytes", async () => {
    for (const target of ["sourcePath", "copyPath"] as const) {
      const f = setup();
      try {
        const { request, plan } = await approved(f); await f.host.tasks.execute(request);
        fs.writeFileSync(f[target], "human edit after completion\r\n");
        const current = await f.host.tasks.observe(plan.taskId);
        assert.equal(current.task.status, "succeeded"); assert.equal(current.goal.satisfied, false);
        assert.equal(current.conflict?.code, target === "sourcePath" ? "SOURCE_CHANGED" : "COPY_NOT_VERIFIED");
        assert.equal(decoded(f[target]), "human edit after completion\r\n");
      } finally { f.host.close(); }
    }
  });
  await test("same-byte replacement of the saved copy invalidates its recorded identity", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f); await f.host.tasks.execute(request);
      const stat = fs.statSync(f.copyPath); const original = fs.readFileSync(f.copyPath);
      fs.renameSync(f.copyPath, path.join(f.fixture, "old-copy")); fs.writeFileSync(f.copyPath, original); fs.utimesSync(f.copyPath, stat.atime, stat.mtime);
      const current = await f.host.tasks.observe(plan.taskId);
      assert.equal(current.goal.satisfied, false); assert.equal(current.conflict?.code, "COPY_NOT_VERIFIED");
    } finally { f.host.close(); }
  });
  await test("completed task observation rejects changed UI even when the saved bytes still match", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f); await f.host.tasks.execute(request);
      f.driver.state!.text += "human unsaved after success"; f.driver.state!.modified = true;
      const current = await f.host.tasks.observe(plan.taskId);
      assert.equal(current.goal.satisfied, false); assert.equal(current.conflict?.code, "BUFFER_CHANGED");
      assert.equal(decoded(f.copyPath), f.expectedText); assert.ok(f.driver.state!.text.endsWith("human unsaved after success"));
    } finally { f.host.close(); }
  });
  await test("a destination created during model thinking is preserved before the next phase", async () => {
    const f = setup();
    try {
      const { request, plan } = await approved(f); await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      fs.writeFileSync(f.copyPath, "human reserved target");
      assert.equal((await f.host.tasks.observe(plan.taskId)).conflict?.code, "DESTINATION_EXISTS");
      const result = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "DESTINATION_EXISTS");
      assert.equal(decoded(f.copyPath), "human reserved target"); assert.equal(f.driver.calls.includes("edit"), false);
    } finally { f.host.close(); }
  });
  await test("source and target changes during intent persistence are checked before any UI input", async () => {
    for (const target of ["sourcePath", "copyPath"] as const) {
      const f = setup(); const originalPutEffect = TaskStore.prototype.putEffect;
      try {
        const { request } = await approved(f); let injected = false;
        TaskStore.prototype.putEffect = function (this: TaskStore, ...args: Parameters<TaskStore["putEffect"]>) {
          const result = originalPutEffect.apply(this, args);
          if (!injected && args[3].phase === "intent") { injected = true; fs.writeFileSync(f[target], "human change at durable boundary\r\n"); }
          return result;
        };
        const result = await f.host.tasks.advance({ ...request, expectedPhase: "open" });
        assert.equal(injected, true); assert.equal(result.status, "needs_attention");
        assert.equal(result.error?.code, target === "sourcePath" ? "SOURCE_CHANGED" : "DESTINATION_EXISTS");
        assert.deepEqual(f.driver.calls, []); assert.equal(result.journal[0].phase, "intent");
        assert.equal(decoded(f[target]), "human change at durable boundary\r\n");
      } finally { TaskStore.prototype.putEffect = originalPutEffect; f.host.close(); }
    }
  });
  await test("an unresolved timed-out driver retains ownership and blocks another application task", async () => {
    const f = setup({}, 20); const waiting = gate<void>();
    try {
      f.driver.openGate = waiting.promise; const { request, plan } = await approved(f);
      assert.equal((await f.host.tasks.advance({ ...request, expectedPhase: "open" })).error?.code, "UI_TIMEOUT");
      assert.throws(() => f.host.assertIdle(), code("HOST_BUSY"));
      assert.throws(() => f.host.close(), code("HOST_BUSY"));
      assert.equal((await f.host.tasks.observe(plan.taskId)).conflict?.code, "UI_OPERATION_PENDING");
      const next = await f.host.tasks.prepare({ sourcePath: f.sourcePath, copyPath: path.join(f.root, "another-copy.txt"), desired: { expectedText: f.expectedText } });
      const receipt = f.host.approvals.approve(next.planId, next.digest);
      await assert.rejects(f.host.tasks.advance({ planId: next.planId, digest: next.digest, approvalReceiptId: receipt.approvalId, expectedPhase: "open" }), code("UI_OPERATION_PENDING"));
      assert.deepEqual(f.driver.calls, ["open"]); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { waiting.resolve(); await new Promise<void>((resolve) => setImmediate(resolve)); f.host.assertIdle(); f.host.close(); }
  });
  await test("observation cancellation returns promptly, propagates to the driver and retains unresolved read ownership", async () => {
    for (const mode of ["external-signal", "task-cancel"] as const) {
      const f = setup(); const waiting = gate<void>(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { request, plan } = await approved(f); await f.host.tasks.advance({ ...request, expectedPhase: "open" });
        const aborted = new AbortController(); aborted.abort();
        assert.equal((await f.host.tasks.observe(plan.taskId, aborted.signal)).conflict?.code, "CANCELLED");
        assert.deepEqual(f.driver.calls, ["open"]);
        assert.throws(() => f.host.tasks.observe(plan.taskId, {} as AbortSignal), code("INVALID_REQUEST"));
        f.driver.observeGate = waiting.promise;
        const controller = new AbortController(); const prior = f.host.tasks.get(plan.taskId);
        const observing = f.host.tasks.observe(plan.taskId, controller.signal);
        while (!f.driver.calls.includes("observe")) await new Promise<void>((resolve) => setImmediate(resolve));
        if (mode === "external-signal") controller.abort(); else assert.equal(f.host.tasks.cancel(plan.taskId).status, "needs_attention");
        const result = await Promise.race([observing, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Observation cancellation waited for the driver timeout")), 1000);
        })]);
        assert.equal(result.conflict?.code, "CANCELLED"); assert.equal(result.goal.satisfied, false);
        assert.equal(f.driver.observationSignal?.aborted, true); assert.throws(() => f.host.assertIdle(), code("HOST_BUSY"));
        assert.equal(fs.existsSync(f.copyPath), false); assert.deepEqual(f.driver.calls, ["open", "observe"]);
        if (mode === "external-signal") assert.deepEqual(result.task, prior);
        else { assert.equal(result.task.status, "needs_attention"); assert.equal(result.task.error?.code, "CANCELLED"); }
      } finally {
        clearTimeout(timer); waiting.resolve(); await new Promise<void>((resolve) => setImmediate(resolve)); f.host.assertIdle(); f.host.close();
      }
    }
  });
  await test("foreground remains the default and focus loss still prevents input", async () => {
    const f = setup();
    try {
      const { plan, request } = await approved(f); assert.equal(plan.driver.inputMode, "foreground");
      await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      const oldToken = notepadBufferToken(f.driver.state!); f.driver.state!.focused = false;
      assert.notEqual(notepadBufferToken(f.driver.state!), oldToken);
      const result = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "BUFFER_CHANGED");
      assert.equal(f.driver.calls.includes("edit"), false); assert.equal(fs.existsSync(f.copyPath), false);
    } finally { f.host.close(); }
  });
  await test("explicit targeted input tolerates focus changes while preserving truthful observations", async () => {
    const f = setup();
    try {
      f.driver.capabilities.inputMode = "targeted";
      const { plan, request } = await approved(f); assert.equal(plan.driver.inputMode, "targeted");
      await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      const oldToken = notepadBufferToken(f.driver.state!); f.driver.state!.focused = false;
      assert.equal(notepadBufferToken(f.driver.state!), oldToken);
      const current = await f.host.tasks.observe(plan.taskId);
      assert.equal(current.conflict, undefined); assert.equal(current.observation?.focused, false);
      f.driver.beforeEdit = () => { f.driver.state!.focused = true; };
      const edited = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(edited.nextPhase, "save-copy"); assert.equal(edited.journal[1].before?.focused, false); assert.equal(edited.journal[1].after?.focused, true);
      f.driver.state!.focused = false;
      const saved = await f.host.tasks.advance({ ...request, expectedPhase: "save-copy" });
      assert.equal(saved.status, "succeeded"); assert.equal(saved.journal[2].after?.focused, false);
      const final = await f.host.tasks.observe(plan.taskId); assert.equal(final.goal.satisfied, true); assert.equal(final.observation?.focused, false);
      assert.equal(decoded(f.sourcePath), f.sourceText); assert.equal(decoded(f.copyPath), f.expectedText);
    } finally { f.host.close(); }
  });
  await test("targeted input still rejects changed window, selected tab, document, path, content, dirty state or title", async () => {
    for (const field of ["windowId", "selectedTab", "documentId", "documentPath", "text", "modified", "windowTitle"] as const) {
      const f = setup();
      try {
        f.driver.capabilities.inputMode = "targeted"; const { request, plan } = await approved(f);
        await f.host.tasks.advance({ ...request, expectedPhase: "open" });
        f.driver.state!.focused = false; const oldToken = notepadBufferToken(f.driver.state!);
        if (field === "selectedTab") f.driver.state!.documentId = f.driver.state!.documentId.replace(/:tab:.*/, ":tab:another-selected-tab");
        else if (field === "modified") f.driver.state!.modified = true;
        else f.driver.state![field] += "-changed";
        assert.notEqual(notepadBufferToken(f.driver.state!), oldToken);
        assert.ok((await f.host.tasks.observe(plan.taskId)).conflict);
        const result = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
        assert.equal(result.status, "needs_attention"); assert.equal(f.driver.calls.includes("edit"), false); assert.equal(fs.existsSync(f.copyPath), false);
      } finally { f.host.close(); }
    }
  });
  await test("input mode is fixed by trusted capability and matching evidence, never inferred from goal text", async () => {
    const f = setup();
    try {
      const { plan, request } = await approved(f); f.driver.capabilities.inputMode = "targeted";
      await assert.rejects(f.host.tasks.advance({ ...request, expectedPhase: "open" }), code("DRIVER_CHANGED"));
      assert.deepEqual(f.driver.calls, []); assert.equal(f.host.tasks.inspect(plan.planId).driver.inputMode, "foreground");
      f.driver.capabilities.inputMode = "foreground";
      await f.host.tasks.advance({ ...request, expectedPhase: "open" });
      f.driver.state!.evidence.inputMode = "targeted"; f.driver.state!.focused = false;
      const result = await f.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(result.status, "needs_attention"); assert.equal(result.error?.code, "INPUT_MODE_MISMATCH"); assert.equal(f.driver.calls.includes("edit"), false);
    } finally { f.host.close(); }
    const other = setup();
    try {
      other.driver.capabilities.inputMode = "targeted"; const { request } = await approved(other);
      await other.host.tasks.advance({ ...request, expectedPhase: "open" }); delete other.driver.state!.evidence.inputMode;
      const result = await other.host.tasks.advance({ ...request, expectedPhase: "edit" });
      assert.equal(result.error?.code, "INPUT_MODE_MISMATCH"); assert.equal(other.driver.calls.includes("edit"), false);
    } finally { other.host.close(); }
  });
  console.log(`Notepad task checks passed: ${passed}`);
} finally {
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("deskshell-notepad-check-")) throw new Error("Unsafe Notepad test cleanup path");
  fs.rmSync(temporary, { recursive: true, force: true });
}
