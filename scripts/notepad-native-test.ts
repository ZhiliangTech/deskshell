/** Protocol tests only: every native call is replaced by an injected transport; no Windows UI is used. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWindowsNotepadDriver, NativeNotepadError, NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE } from "../packages/drivers/windows/notepad.ts";
import type { NotepadNativeTransport, TrustedNotepadProfile } from "../packages/drivers/windows/notepad.ts";
import { NotepadGuardError } from "../packages/drivers/windows/notepad-session-guard.ts";
import type { NotepadSessionGuard } from "../packages/drivers/windows/notepad-session-guard.ts";
import { notepadBufferToken } from "../packages/runtime/src/notepad-task.ts";
import type { NotepadBinding, NotepadObservation } from "../packages/runtime/src/notepad-task.ts";

const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-notepad-native-test-"));
const profile: TrustedNotepadProfile = { ...JSON.parse(JSON.stringify(NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE)), id: "offline-fixture-profile", verified: true };
const originalText = "Synthetic original.\r\n";
const replacementText = "Synthetic original.\r\nApproved addition.\r\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const binding = (value: NotepadObservation): NotepadBinding => ({ appId: value.appId, driverSessionId: value.driverSessionId, windowId: value.windowId, documentId: value.documentId });
let index = 0; let passed = 0;
function fakeGuard() {
  const controller = new AbortController(); const events: string[] = []; let bound = false;
  let endFailure: string | undefined;
  const healthy = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  const guard: NotepadSessionGuard = {
    signal: controller.signal, revision: () => "offline-guard", async start() { healthy(); events.push("start"); },
    async bind() { healthy(); bound = true; events.push("bind"); }, async assertHealthy() { healthy(); events.push("check"); },
    async withLease(kind, operation) { healthy(); assert.ok(kind === "open" ? !bound : bound); events.push(`begin:${kind}`); const result = await operation(controller.signal, { version: 1, pipe: "offline-guard", nonce: "offline-nonce", leaseId: "offline-lease", inputTick: 123 }); healthy(); if (endFailure) throw new NotepadGuardError(endFailure); events.push(`end:${kind}`); return result; },
    close() { if (!controller.signal.aborted) controller.abort(new NotepadGuardError("GUARD_CLOSED")); events.push("close"); },
  };
  return { guard, events, invalidate: () => controller.abort(new NotepadGuardError("GUARD_INPUT_CHANGED")), failEnd: (code: string) => { endFailure = code; } };
}
function fixture(override?: (request: Record<string, any>, next: () => unknown) => unknown | Promise<unknown>, timeoutMs = 500) {
  const root = path.join(parent, `case-${++index}`); fs.mkdirSync(root);
  const source = path.join(root, "source.txt"); fs.writeFileSync(source, originalText, { flag: "wx" });
  const output = path.join(root, "copy.txt"); const calls: Record<string, any>[] = [];
  let text = originalText; let currentPath = source; let modified = false; let pathEvidence: "explicit-open" | "save-copy-dialog" = "explicit-open";
  const observation = (request: Record<string, any>): NotepadObservation => ({
    appId: request.appId, driverSessionId: request.driverSessionId, windowId: "123:638973000000000000:456", documentId: "document:42.10:tab:42.20",
    documentPath: currentPath, windowTitle: modified ? "*fixture" : "fixture", text, modified, focused: true,
    evidence: { window: "native-window", document: "single-tab-marker", path: pathEvidence, buffer: "accessibility-text", bufferComplete: true, inputMode: "targeted" },
  });
  const transport: NotepadNativeTransport = async (raw) => {
    const request = raw as Record<string, any>; calls.push(clone(request));
    const next = (): unknown => {
      if (request.operation === "probe") return { ok: true, probe: { available: false, reasons: ["NO_OWNED_DOCUMENT_TO_PROBE"], installedVersion: profile.packageVersion } };
      if (request.operation === "open") return { ok: true, observation: observation(request), session: { pid: 123, startedTicks: "638973000000000000", hwnd: "456", documentRuntimeId: [42, 10], tabRuntimeId: [42, 20], documentPath: source, pathEvidence, sourcePath: source, sourceHash: digest(originalText), sourceNewline: "crlf", documentNewline: "crlf" } };
      if (request.operation === "edit") { text = request.replacementText; modified = true; }
      if (request.operation === "save-copy") { currentPath = request.copyPath; pathEvidence = "save-copy-dialog"; modified = false; fs.writeFileSync(currentPath, text, { flag: "wx" }); }
      return { ok: true, observation: observation(request) };
    };
    return override ? await override(request, next) : next();
  };
  const guard = fakeGuard(); const driver = createWindowsNotepadDriver({ profile, transport, guard: guard.guard, timeoutMs });
  const open = () => driver.open({ sourcePath: source, expectedSourceHash: digest(originalText), signal: new AbortController().signal });
  return { root, source, output, driver, calls, open, guard };
}
async function rejects(run: () => unknown, code: string, reason?: string) {
  await assert.rejects(async () => await run(), (error) => error instanceof NativeNotepadError && error.code === code && (reason === undefined || error.reason === reason));
}
async function test(name: string, run: () => unknown) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  await test("construction and the default read-only probe never invoke native transport", async () => {
    let calls = 0; const driver = createWindowsNotepadDriver({ transport: async () => { calls++; throw new Error("must not run"); } });
    const probe = await driver.probe(); assert.equal(calls, 0); assert.equal(probe.readOnly, true); assert.equal(probe.available, false);
    assert.equal(driver.capabilities.saveCopy, false); assert.ok(probe.reasons.includes("SAVE_COPY_PROFILE_UNVERIFIED")); assert.equal(probe.runtimeVerified, false); assert.equal(probe.profileVerified, false); assert.ok(probe.reasons.includes("PROBE_METADATA_ONLY"));
    await rejects(() => driver.open({ sourcePath: path.join(parent, "anything.txt"), expectedSourceHash: "0".repeat(64), signal: new AbortController().signal }), "CAPABILITY_UNAVAILABLE", "SAVE_COPY_PROFILE_UNVERIFIED"); driver.close();
  });
  await test("trusted profile validation rejects ambiguous controls and unverified configuration", async () => {
    assert.throws(() => createWindowsNotepadDriver({ profile: { ...profile, verified: false } as any }), (error) => error instanceof NativeNotepadError && error.code === "INVALID_NOTEPAD_PROFILE");
    assert.throws(() => createWindowsNotepadDriver({ profile: { ...profile, saveDialog: { ...profile.saveDialog, filenameId: 1148 } } as any }), (error) => error instanceof NativeNotepadError && error.code === "INVALID_NOTEPAD_PROFILE");
  });
  await test("profile probes are explicitly read-only and cannot upgrade to launch", async () => {
    const f = fixture(); try { const result = await f.driver.probe({ readOnly: true }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, "probe"); assert.equal(result.runtimeVerified, false); await rejects(() => f.driver.probe({ readOnly: false } as any), "INVALID_NOTEPAD_INPUT"); assert.equal(f.calls.length, 1); } finally { f.driver.close(); }
  });
  await test("source content hash is checked before any native launch request", async () => {
    const f = fixture(); try { fs.writeFileSync(f.source, "human change"); await rejects(f.open, "SOURCE_CHANGED"); assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(f.source, "utf8"), "human change"); } finally { f.driver.close(); }
  });
  await test("relative or non-text paths are rejected before native requests", async () => {
    const f = fixture(); try { await rejects(() => f.driver.open({ sourcePath: "relative.txt", expectedSourceHash: digest(originalText), signal: new AbortController().signal }), "INVALID_NOTEPAD_PATH"); await rejects(() => f.driver.open({ sourcePath: path.join(f.root, "source.exe"), expectedSourceHash: digest(originalText), signal: new AbortController().signal }), "INVALID_NOTEPAD_PATH"); assert.equal(f.calls.length, 0); } finally { f.driver.close(); }
  });
  await test("open binds the process start identity, native window, stable document and selected tab", async () => {
    const f = fixture(); try { const opened = await f.open(); assert.equal(opened.driverSessionId, f.driver.sessionId); assert.equal(opened.windowId, "123:638973000000000000:456"); assert.equal(opened.documentId, "document:42.10:tab:42.20"); assert.equal(opened.evidence.path, "explicit-open"); assert.equal(opened.text, originalText); await rejects(f.open, "CAPABILITY_UNAVAILABLE", "DRIVER_ALREADY_OWNS_DOCUMENT"); } finally { f.driver.close(); }
  });
  await test("helper output cannot silently change path, identity or machine-readable evidence", async () => {
    for (const change of ["path", "session", "document", "buffer", "native-state", "source-hash"]) {
      const f = fixture((request, next) => { const reply: any = next(); if (request.operation === "open") { if (change === "path") reply.observation.documentPath = path.join(parent, "other.txt"); if (change === "session") reply.observation.driverSessionId = "other"; if (change === "document") reply.observation.documentId = "wrong"; if (change === "buffer") reply.observation.evidence.bufferComplete = false; if (change === "native-state") reply.session.hwnd = "999"; if (change === "source-hash") reply.session.sourceHash = "f".repeat(64); } return reply; });
      try { await assert.rejects(f.open, (error) => error instanceof NativeNotepadError && ["NOTEPAD_BINDING_CHANGED", "INVALID_NOTEPAD_RESPONSE"].includes(error.code)); } finally { f.driver.close(); }
    }
  });
  await test("edit requires complete token and targeted evidence before sending input", async () => {
    const f = fixture(); try {
      const opened = await f.open(); const count = f.calls.length;
      await rejects(() => f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: "forged", replacementText, signal: new AbortController().signal }), "NOTEPAD_BINDING_CHANGED");
      const foreground = { ...opened, evidence: { ...opened.evidence, inputMode: "foreground" as const } };
      await rejects(() => f.driver.edit({ binding: binding(foreground), expected: foreground, expectedToken: notepadBufferToken(foreground), replacementText, signal: new AbortController().signal }), "NOTEPAD_BINDING_CHANGED");
      assert.equal(f.calls.length, count);
    } finally { f.driver.close(); }
  });
  await test("edit passes exact expected buffer to the helper and verifies the returned full text", async () => {
    const f = fixture(); try { const opened = await f.open(); const edited = await f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), replacementText, signal: new AbortController().signal }); assert.equal(edited.text, replacementText); assert.equal(edited.modified, true); assert.deepEqual(f.calls.at(-1)!.expected, opened); assert.equal(f.calls.at(-1)!.replacementText, replacementText); assert.equal(fs.readFileSync(f.source, "utf8"), originalText); } finally { f.driver.close(); }
  });
  await test("a helper-reported human buffer change fails without assuming an edit occurred", async () => {
    const f = fixture((request, next) => request.operation === "edit" ? { ok: false, code: "NOTEPAD_BUFFER_CHANGED", reason: "EXPECTED_OBSERVATION_CHANGED" } : next());
    try { const opened = await f.open(); await rejects(() => f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), replacementText, signal: new AbortController().signal }), "NOTEPAD_BUFFER_CHANGED"); assert.equal(fs.readFileSync(f.source, "utf8"), originalText); } finally { f.driver.close(); }
  });
  await test("save-copy rejects occupied destinations before invoking any save action", async () => {
    const f = fixture(); try { const opened = await f.open(); fs.writeFileSync(f.output, "human output", { flag: "wx" }); const count = f.calls.length; await rejects(() => f.driver.saveCopy({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), copyPath: f.output, encoding: "utf8", signal: new AbortController().signal }), "COPY_ALREADY_EXISTS"); assert.equal(f.calls.length, count); assert.equal(fs.readFileSync(f.output, "utf8"), "human output"); } finally { f.driver.close(); }
  });
  await test("save-copy keeps document binding and subsequent observations retain saved-path evidence", async () => {
    const f = fixture(); try {
      const opened = await f.open(); const edited = await f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), replacementText, signal: new AbortController().signal });
      const saved = await f.driver.saveCopy({ binding: binding(edited), expected: edited, expectedToken: notepadBufferToken(edited), copyPath: f.output, encoding: "utf8", signal: new AbortController().signal });
      assert.deepEqual(binding(saved), binding(opened)); assert.equal(saved.documentPath, f.output); assert.equal(saved.evidence.path, "save-copy-dialog"); assert.equal(saved.modified, false);
      assert.equal(notepadBufferToken(await f.driver.observe(binding(saved))), notepadBufferToken(saved)); assert.equal(f.calls.at(-1)!.session.pathEvidence, "save-copy-dialog");
      assert.equal(fs.readFileSync(f.source, "utf8"), originalText); assert.equal(fs.readFileSync(f.output, "utf8"), replacementText);
    } finally { f.driver.close(); }
  });
  await test("an overwrite or unexpected dialog is refused and never treated as save completion", async () => {
    const f = fixture((request, next) => request.operation === "save-copy" ? { ok: false, code: "NOTEPAD_SAVE_NOT_VERIFIED", reason: "OVERWRITE_OR_UNEXPECTED_DIALOG_REFUSED" } : next());
    try { const opened = await f.open(); await rejects(() => f.driver.saveCopy({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), copyPath: f.output, encoding: "utf8", signal: new AbortController().signal }), "NOTEPAD_SAVE_NOT_VERIFIED"); assert.equal(fs.existsSync(f.output), false); } finally { f.driver.close(); }
  });
  await test("pre-cancelled calls do not reach native transport", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    try { await rejects(() => f.driver.open({ sourcePath: f.source, expectedSourceHash: digest(originalText), signal: controller.signal }), "CANCELLED"); assert.equal(f.calls.length, 0); } finally { f.driver.close(); }
  });
  await test("timeout covers a transport which ignores abort and a late reply cannot bind a document", async () => {
    const f = fixture(async (_request, next) => { await new Promise((resolve) => setTimeout(resolve, 40)); return next(); }, 10);
    try { await rejects(f.open, "NOTEPAD_TIMEOUT"); await new Promise((resolve) => setTimeout(resolve, 50)); await rejects(() => f.driver.observe({ appId: f.driver.appId, driverSessionId: f.driver.sessionId, windowId: "123:638973000000000000:456", documentId: "document:42.10:tab:42.20" }), "NOTEPAD_BINDING_CHANGED"); await rejects(f.open, "NOTEPAD_DRIVER_CLOSED"); assert.equal(f.calls.length, 1); } finally { f.driver.close(); }
  });
  await test("close aborts in-flight IPC and errors never expose raw native diagnostics", async () => {
    const f = fixture(() => new Promise(() => {}));
    const running = f.open(); f.driver.close(); await rejects(() => running, "CANCELLED");
    const secretText = "synthetic sensitive buffer must not appear in errors";
    const g = fixture(() => { throw new Error(secretText); });
    try { await assert.rejects(g.open, (error) => error instanceof NativeNotepadError && !String(error).includes(secretText) && error.code === "NOTEPAD_OPERATION_FAILED"); } finally { g.driver.close(); }
  });
  await test("concurrent calls cannot interleave one driver session", async () => {
    let release!: () => void;
    const f = fixture(async (_request, next) => { await new Promise<void>((resolve) => { release = resolve; }); return next(); });
    try { const first = f.open(); await rejects(f.open, "NOTEPAD_DRIVER_BUSY"); release(); await first; assert.equal(f.calls.length, 1); } finally { f.driver.close(); }
  });
  await test("driver revision binds the actual helper and an immutable profile copy", () => {
    const value = clone(profile); const driver = createWindowsNotepadDriver({ profile: value, transport: async () => { throw new Error("unused"); } });
    try { const before = driver.revision(); (value.saveDialog as any).filenameId = 999; assert.equal(driver.revision(), before); assert.match(before, /^[a-f0-9]{64}$/); } finally { driver.close(); }
  });
  await test("cancelled input permanently closes the uncertain session before another request", async () => {
    const f = fixture((request, next) => request.operation === "edit" ? new Promise(() => {}) : next());
    const opened = await f.open(); const controller = new AbortController();
    const pending = f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), replacementText, signal: controller.signal }); await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort();
    try { await rejects(() => pending, "CANCELLED"); await rejects(() => f.driver.observe(binding(opened)), "NOTEPAD_DRIVER_CLOSED"); assert.equal(f.calls.length, 2); assert.equal(f.calls.at(-1)!.session.sourceHash, digest(originalText)); assert.equal(f.calls.at(-1)!.session.sourcePath, f.source); } finally { f.driver.close(); }
  });
  await test("probe data cannot forge runtime validation or leak arbitrary helper fields", async () => {
    const f = fixture(() => ({ ok: true, probe: { available: false, reasons: [], runtimeVerified: true, readOnly: false, text: "private buffer" } }));
    try { const result = await f.driver.probe(); assert.equal(result.runtimeVerified, false); assert.equal(result.readOnly, true); assert.equal(Object.hasOwn(result, "text"), false); } finally { f.driver.close(); }
  });
  await test("metadata probe never treats a cached owned session as fresh runtime validation", async () => {
    const f = fixture((request, next) => request.operation === "probe" ? { ok: true, probe: { available: true, reasons: [], installedVersion: profile.packageVersion, runtimeVerified: true, profileVerified: false } } : next());
    try {
      await f.open(); const guardEventCount = f.guard.events.length;
      const result = await f.driver.probe();
      assert.equal(result.available, true); assert.equal(result.profileVerified, true); assert.equal(result.runtimeVerified, false); assert.ok(result.reasons.includes("PROBE_METADATA_ONLY"));
      assert.deepEqual(f.calls.map((request) => request.operation), ["open", "probe"]); assert.deepEqual(f.guard.events.slice(guardEventCount), ["check", "check"]);
      f.guard.invalidate(); await rejects(() => f.driver.probe(), "GUARD_INPUT_CHANGED"); assert.equal(f.calls.length, 2);
    } finally { f.driver.close(); }
  });
  await test("read cancellation interrupts uncooperative transport and a late observation cannot reopen the driver", async () => {
    let release!: () => void;
    const f = fixture((request, next) => request.operation === "observe" ? new Promise((resolve) => { release = () => resolve(next()); }) : next());
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const opened = await f.open(); const before = new AbortController(); before.abort();
      await rejects(() => f.driver.observe(binding(opened), before.signal), "CANCELLED"); assert.equal(f.calls.length, 1);
      const controller = new AbortController(); const pending = f.driver.observe(binding(opened), controller.signal); await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort();
      const bounded = Promise.race([pending, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Read cancellation did not settle promptly")), 100); })]);
      await rejects(() => bounded, "CANCELLED"); clearTimeout(deadline);
      release(); await new Promise<void>((resolve) => setImmediate(resolve));
      await rejects(() => f.driver.observe(binding(opened)), "NOTEPAD_DRIVER_CLOSED"); await rejects(() => f.driver.probe(), "NOTEPAD_DRIVER_CLOSED");
      assert.equal(f.calls.length, 2); assert.equal(fs.readFileSync(f.source, "utf8"), originalText);
    } finally { clearTimeout(deadline); release?.(); f.driver.close(); }
  });
  await test("candidate profiles require a separate explicit laboratory opt-in", async () => {
    assert.throws(() => createWindowsNotepadDriver({ profile: NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE }), (error) => error instanceof NativeNotepadError && error.code === "INVALID_NOTEPAD_PROFILE");
    const driver = createWindowsNotepadDriver({ profile: NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE, allowUnverifiedProfile: true, transport: async () => ({ ok: true, probe: { available: false, reasons: [] } }) });
    try { const result = await driver.probe(); assert.equal(result.runtimeVerified, false); assert.equal(result.profileVerified, false); assert.ok(result.reasons.includes("PROBE_METADATA_ONLY")); assert.equal(driver.capabilities.inputMode, "targeted"); } finally { driver.close(); }
  });
  await test("targeted background edit retains every binding and buffer check while ignoring focus alone", async () => {
    const f = fixture((request, next) => { const value = next() as any; if (value.observation) value.observation.focused = false; return value; });
    try { const opened = await f.open(); assert.equal(opened.focused, false); const edited = await f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), replacementText, signal: new AbortController().signal }); assert.equal(edited.text, replacementText); assert.equal(edited.focused, false); assert.ok(f.guard.events.includes("bind")); assert.equal(f.calls.at(-1)!.guard.inputTick, 123); assert.ok(f.guard.events.includes("end:edit")); } finally { f.driver.close(); }
  });
  await test("mixed newline, lone CR and changed newline conventions are rejected before any native edit", async () => {
    const f = fixture(); try { const opened = await f.open(); const count = f.calls.length; for (const replacement of ["a\rb", "a\r\nb\n", "a\nb\n"]) await rejects(() => f.driver.edit({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), replacementText: replacement, signal: new AbortController().signal }), "INVALID_NOTEPAD_INPUT"); assert.equal(f.calls.length, count); } finally { f.driver.close(); }
  });
  await test("an invalid open session closes the guard and cannot launch another window", async () => {
    const f = fixture((request, next) => { const value = next() as any; if (request.operation === "open") value.session.hwnd = "999"; return value; });
    try { await rejects(f.open, "INVALID_NOTEPAD_RESPONSE"); await rejects(f.open, "NOTEPAD_DRIVER_CLOSED"); assert.equal(f.calls.length, 1); assert.equal(f.guard.guard.signal.aborted, true); } finally { f.driver.close(); }
  });
  await test("guard invalidation prevents the next helper request and retains its fixed error", async () => {
    const f = fixture(); try { const opened = await f.open(); f.guard.invalidate(); await rejects(() => f.driver.observe(binding(opened)), "GUARD_INPUT_CHANGED"); assert.equal(f.calls.length, 1); await rejects(() => f.driver.observe(binding(opened)), "NOTEPAD_DRIVER_CLOSED"); } finally { f.driver.close(); }
  });
  await test("helper C# and raw-CR conversion compile and check offline without running native methods", () => {
    const helper = path.resolve(import.meta.dirname, "../packages/drivers/windows/notepad.ps1");
    assert.ok([...fs.readFileSync(helper)].every((byte) => byte < 128), "PowerShell 5.1 helper must remain ASCII without a BOM");
    const helperSource = fs.readFileSync(helper, "utf8");
    assert.match(helperSource, /\$info\.UseShellExecute = \$true/);
    assert.doesNotMatch(helperSource, /\$info\.(?:Arguments|ArgumentList)\s*=/, "Application activation must not receive user command arguments");
    if (process.platform !== "win32") return;
    const command = "$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$tokens,[ref]$errors);if($errors.Count){throw 'SYNTAX'};$cs=$ast.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.Contains('public static class DeskshellNotepadNative')},$true);if($cs.Count -ne 1){throw 'CS_SOURCE'};Add-Type -TypeDefinition $cs[0].Value;foreach($name in @('Fail','Newline-Of','Canonical-Text','Raw-Text')){$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f[0].Extent.Text};$cr=[string][char]13;$lf=[string][char]10;if((Canonical-Text ('a'+$cr+'b') 'crlf') -cne ('a'+$cr+$lf+'b')){throw 'CRLF'};if((Canonical-Text ('a'+$cr+'b') 'lf') -cne ('a'+$lf+'b')){throw 'LF'};if((Raw-Text ('a'+$cr+$lf+'b')) -cne ('a'+$cr+'b')){throw 'RAW'};$rejected=$false;try{Canonical-Text ('a'+$lf) 'lf'|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'RAW_LF_ACCEPTED'};'OFFLINE_COMPILE_AND_NEWLINE_OK'";
    const script = path.join(parent, "compile-helper.ps1"); fs.writeFileSync(script, command);
    const result = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, helper], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.match(result, /OFFLINE_COMPILE_AND_NEWLINE_OK/);
  });
  await test("a helper failure is decoded before lease end so an open dialog cannot mask its original code", async () => {
    const f = fixture((request, next) => request.operation === "save-copy" ? { ok: false, code: "NOTEPAD_FILENAME_READ_FAILED", reason: "NATIVE_CHECK_FAILED" } : next());
    try {
      const opened = await f.open(); f.guard.failEnd("GUARD_DIALOG_LEFT_OPEN");
      await rejects(() => f.driver.saveCopy({ binding: binding(opened), expected: opened, expectedToken: notepadBufferToken(opened), copyPath: f.output, encoding: "utf8", signal: new AbortController().signal }), "NOTEPAD_FILENAME_READ_FAILED", "NATIVE_CHECK_FAILED");
      assert.equal(f.guard.events.includes("end:save-copy"), false); assert.equal(f.guard.guard.signal.aborted, true); assert.equal(fs.existsSync(f.output), false);
    } finally { f.driver.close(); }
  });
  await test("encoding discovery skips other combo contents and refuses duplicate signatures and CB_ERR", () => {
    if (process.platform !== "win32") return;
    const helper = path.resolve(import.meta.dirname, "../packages/drivers/windows/notepad.ps1");
    const mock = `using System; public static class DeskshellNotepadNative {
      public static bool Duplicate=false; public static int LabelReads=0; public static ulong CountError=0;
      public static IntPtr[] Children(IntPtr h){return Duplicate ? new[]{(IntPtr)1,(IntPtr)2,(IntPtr)3,(IntPtr)4}:new[]{(IntPtr)1,(IntPtr)2,(IntPtr)3};}
      public static string ClassOf(IntPtr h){return "ComboBox";} public static int GetDlgCtrlID(IntPtr h){return 0;}
      public static bool IsWindowVisible(IntPtr h){return true;} public static bool IsWindowEnabled(IntPtr h){return true;}
      public static uint Pid(IntPtr h){return 123;} public static bool IsChild(IntPtr p,IntPtr h){return true;}
      public static ulong Message(IntPtr h,uint m,IntPtr w,IntPtr l){if(m==0x0146){if(h==(IntPtr)1&&CountError!=0)return CountError;return h==(IntPtr)1?0UL:h==(IntPtr)2?2UL:6UL;}if(m==0x0147 && (h==(IntPtr)3||h==(IntPtr)4))return 3;throw new Exception("UNEXPECTED_CALL");}
      public static string ComboText(IntPtr h,int i){if(h!=(IntPtr)3&&h!=(IntPtr)4)throw new Exception("OTHER_COMBO_TEXT_READ");LabelReads++;return new[]{"ANSI","UTF-16 LE","UTF-16 BE","UTF-8","UTF-8 BOM","GB18030"}[i];}
    }`;
    const mockFile = path.join(parent, "encoding-mock.cs"); fs.writeFileSync(mockFile, mock);
    const command = "$ErrorActionPreference='Stop';Add-Type -Path $args[1];$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$tokens,[ref]$errors);if($errors.Count){throw 'SYNTAX'};foreach($name in @('Fail','Eq','Assert-Encoding')){$f=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f[0].Extent.Text};function Assert-Dialog($d,$s){};$dialog=@{Current=@{NativeWindowHandle=99}};$session=@{pid=123};Assert-Encoding $dialog $session;if([DeskshellNotepadNative]::LabelReads -ne 6){throw 'UNEXPECTED_LABEL_READS'};[DeskshellNotepadNative]::Duplicate=$true;$rejected=$false;try{Assert-Encoding $dialog $session}catch{if($_.Exception.Message -notlike '*ENCODING_PROFILE_AMBIGUOUS*'){throw};$rejected=$true};if(-not $rejected){throw 'AMBIGUOUS_ACCEPTED'};[DeskshellNotepadNative]::Duplicate=$false;foreach($errorCount in @([uint32]::MaxValue,[uint64]::MaxValue)){[DeskshellNotepadNative]::CountError=$errorCount;[DeskshellNotepadNative]::LabelReads=0;$rejected=$false;try{Assert-Encoding $dialog $session}catch{if($_.Exception.Message -notlike '*NOTEPAD_ENCODING_READ_FAILED|ENCODING_COUNT_INVALID*'){throw};$rejected=$true};if(-not $rejected -or [DeskshellNotepadNative]::LabelReads -ne 0){throw 'CB_ERR_ACCEPTED_OR_READ'}};'OFFLINE_ENCODING_OK'";
    const script = path.join(parent, "encoding-check.ps1"); fs.writeFileSync(script, command);
    const result = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, helper, mockFile], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.match(result, /OFFLINE_ENCODING_OK/);
  });
  console.log(`Notepad native protocol checks passed: ${passed}`);
} finally {
  if (path.dirname(path.resolve(parent)) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith("deskshell-notepad-native-test-")) throw new Error("Unsafe cleanup scope");
  fs.rmSync(parent, { recursive: true, force: true });
}
