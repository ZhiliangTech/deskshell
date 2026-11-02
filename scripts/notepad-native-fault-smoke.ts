/** Opt-in real-UI disturbances, strictly limited to new synthetic fixtures and their bound windows. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNotepadFixture, createNotepadTaskHost } from "../packages/runtime/src/notepad-task.ts";
import type { NotepadObservation } from "../packages/runtime/src/notepad-task.ts";
import { createWindowsNotepadDriver, NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE } from "../packages/drivers/windows/notepad.ts";
import { createNotepadSessionGuard } from "../packages/drivers/windows/notepad-session-guard.ts";

const scenarios = ["buffer-change", "external-dialog", "driver-closed", "guard-crashed"] as const;
const selectedScenario = process.argv[3] === "--scenario" ? process.argv[4] : undefined;
if (process.platform !== "win32" || !(process.argv.length === 3 || process.argv.length === 5 && scenarios.includes(selectedScenario as any)) || process.argv[2] !== "--native-faults") {
  throw new Error("Use --native-faults [--scenario buffer-change|external-dialog|driver-closed|guard-crashed] on Windows; only new synthetic windows, no cloud calls.");
}
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-native-faults-"));
const helper = fileURLToPath(new URL("./lib/notepad-native-fault.ps1", import.meta.url));
const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
async function perturb(operation: string, marker: string, expected: NotepadObservation, dialogHandle?: string): Promise<{ dialogHandle?: string }> {
  // Keep the parent event loop responsive: the real guard must deliver its events while the fault occurs.
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", helper], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let text = ""; let done = false;
    const finish = (error?: Error): void => { if (done) return; done = true; clearTimeout(timer); if (error) { child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); reject(error); } else resolve(text); };
    const timer = setTimeout(() => finish(new Error("SYNTHETIC_FAULT_TIMEOUT")), 15_000);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { text += chunk; if (Buffer.byteLength(text) > 8192) finish(new Error("SYNTHETIC_FAULT_OUTPUT_LIMIT")); });
    child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
    child.on("error", () => finish(new Error("SYNTHETIC_FAULT_TRANSPORT_FAILED"))); child.stdin.on("error", () => finish(new Error("SYNTHETIC_FAULT_TRANSPORT_FAILED")));
    child.on("close", (code) => finish(code === 0 ? undefined : new Error("SYNTHETIC_FAULT_FAILED")));
    child.stdin.end(JSON.stringify({ operation, marker, expected, dialogHandle }), "utf8");
  });
  const reply = JSON.parse(output.replace(/^\uFEFF/, "")); assert.equal(reply.ok, true); return reply;
}
const results: Record<string, unknown>[] = [];
for (const scenario of scenarios.filter((name) => !selectedScenario || name === selectedScenario)) {
  const fixture = createNotepadFixture(parent);
  let guardProcess: ChildProcessWithoutNullStreams | undefined;
  const guard = scenario === "guard-crashed" ? createNotepadSessionGuard({ transport(events) {
    const script = fileURLToPath(new URL("../packages/drivers/windows/notepad-session-guard.ps1", import.meta.url));
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    guardProcess = child;
    child.stdout.on("data", events.data); child.stderr.on("data", (chunk: Buffer) => chunk.fill(0));
    child.on("close", events.closed); child.on("error", events.error); child.stdin.on("error", events.error);
    return { write: (line) => { child.stdin.write(line); }, close: () => { child.kill(); } };
  } }) : undefined;
  const driver = createWindowsNotepadDriver({ profile: NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE, allowUnverifiedProfile: true, ...(guard ? { guard } : {}) });
  const host = createNotepadTaskHost({ dataDir: fixture.stateDir, allowedRoots: [fixture.root], driver });
  let observed: NotepadObservation | undefined;
  let dialogMayHaveOpened = false; let dialogHandle: string | undefined;
  const proof: Record<string, unknown> = { scenario, fixture: fixture.fixture, passed: false };
  try {
    const plan = await host.tasks.prepare({ sourcePath: fixture.sourcePath, copyPath: fixture.copyPath, desired: { expectedText: fixture.expectedText } });
    const approved = { planId: plan.planId, digest: plan.digest, approvalReceiptId: host.approvals.approve(plan.planId, plan.digest).approvalId };
    const opened = await host.tasks.advance({ ...approved, expectedPhase: "open" });
    assert.equal(opened.stage, "open"); assert.equal(opened.status, "running");
    observed = opened.journal.at(-1)!.after!; assert.ok(observed);
    if (scenario === "buffer-change") await perturb("change-buffer", fixture.marker, observed);
    if (scenario === "external-dialog") { dialogMayHaveOpened = true; dialogHandle = (await perturb("open-save-dialog", fixture.marker, observed)).dialogHandle; assert.ok(dialogHandle); }
    if (scenario === "driver-closed") driver.close();
    if (scenario === "guard-crashed") {
      assert.ok(guardProcess && guard);
      const aborted = new Promise<void>((resolve) => guard.signal.addEventListener("abort", () => resolve(), { once: true }));
      assert.equal(guardProcess.kill(), true, "Only the monitor process created by this fixture is terminated");
      await Promise.race([aborted, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("GUARD_CRASH_NOT_DETECTED")), 2500); timer.unref(); })]);
    }
    const stopped = await host.tasks.advance({ ...approved, expectedPhase: "edit" });
    proof.observedStatus = stopped.status; proof.observedCode = stopped.error?.code ?? null;
    assert.equal(stopped.status, "needs_attention");
    const expectedCodes = scenario === "buffer-change" ? ["BUFFER_CHANGED", "NOTEPAD_BUFFER_CHANGED"]
      : scenario === "external-dialog" ? ["GUARD_UNLEASED_EVENT", "GUARD_UNEXPECTED_DIALOG", "GUARD_DIALOG_LEFT_OPEN"]
      : scenario === "driver-closed" ? ["NOTEPAD_DRIVER_CLOSED"] : ["GUARD_EXITED"];
    assert.ok(expectedCodes.includes(stopped.error?.code ?? ""), `Unrelated failure cannot pass ${scenario}`);
    assert.ok(stopped.journal.every((effect) => effect.step === "open"), "No edit intent should be issued after fresh observation fails");
    assert.equal(fs.existsSync(fixture.copyPath), false);
    assert.equal(fs.readFileSync(fixture.sourcePath, "utf8"), fixture.sourceText);
    if (scenario === "buffer-change") await perturb("verify-changed-buffer", fixture.marker, observed);
    Object.assign(proof, { passed: true, status: stopped.status, code: stopped.error?.code, sourceUnchanged: true, noOutput: true,
      ...(scenario === "buffer-change" ? { humanBufferPreserved: true } : {}) });
  } catch (error) {
    proof.code = error && typeof error === "object" && "code" in error ? String(error.code) : "NATIVE_FAULT_ACCEPTANCE_FAILED";
    process.exitCode = 1;
  } finally {
    if (dialogMayHaveOpened && observed) {
      try { assert.ok(dialogHandle); await perturb("cancel-save-dialog", fixture.marker, observed, dialogHandle); }
      catch { proof.dialogCleanupUncertain = true; proof.passed = false; process.exitCode = 1; }
    }
    driver.close();
    try { host.close(); } catch { proof.shutdownIncomplete = true; proof.passed = false; process.exitCode = 1; }
    results.push(proof);
    fs.writeFileSync(path.join(fixture.fixture, "fault-verification.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
    console.log(JSON.stringify(proof));
  }
  if (!proof.passed) break;
}
fs.writeFileSync(path.join(parent, "native-faults-verification.json"), JSON.stringify({ parent, results }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ parent, passed: results.filter((r) => r.passed).length, total: results.length }));
