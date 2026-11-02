/** Real IPC and CLI with an explicitly synthetic editor. No native UI or network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startAgentService } from "../packages/agent/src/service.ts";
import { callHost, IpcError } from "../packages/agent/src/ipc.ts";
import { DeepSeekBackend } from "../packages/models/src/deepseek.ts";
import { createNotepadFixture } from "../packages/runtime/src/notepad-task.ts";
import { FixtureNotepadDriver } from "./lib/notepad-fixture.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-app-service-"));
const run = promisify(execFile);
const services = new Set<Awaited<ReturnType<typeof startAgentService>>>();
const hasCode = (code: string) => (error: unknown) => error instanceof IpcError && error.code === code;
let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); passed++; }
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function setup(options: { modelGate?: ReturnType<typeof gate>; limit?: number; driver?: FixtureNotepadDriver } = {}) {
  const f = createNotepadFixture(temporary); const stateDir = path.join(f.fixture, "agent-state");
  const driver = options.driver ?? new FixtureNotepadDriver(); const outbound: string[] = [];
  const started = gate();
  const service = await startAgentService({ root: f.root, stateDir, budgetDir: stateDir, notepadDriver: driver,
    backendFactory: budget => new DeepSeekBackend({ apiKey: "sk-offline-not-a-real-credential", budget,
      limits: { maxRequests: 6, maxInputBytes: 16_384, maxOutputTokens: 512, timeoutMs: 30_000, maxEstimatedCostUsd: 0.05 },
      fetch: async (_url, init) => {
        const body = String(init!.body); outbound.push(body); started.resolve(); if (options.modelGate) await options.modelGate.promise;
        const request = JSON.parse(body); const user = JSON.parse(request.messages[1].content);
        const context = JSON.parse(user.intent);
        const step = context.observation.nextStep;
        return new Response(JSON.stringify({ id: `app-fixture-${outbound.length}`, model: "deepseek-flash", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "p1", type: "function", function: { name: "propose_skill", arguments: JSON.stringify({ skillId: "notepad-next-step", version: "1", args: { step }, goalCriteria: { alreadyApproved: true } }) } }] } }] }), { headers: { "Content-Type": "application/json" } });
      },
    }),
  }); services.add(service);
  if (options.limit) await callHost(stateDir, "budget.configure", { maxRequests: options.limit, maxEstimatedCostUsd: 0.1 }, { control: true });
  const base = { root: f.root };
  const prepare = () => callHost(stateDir, "notepad.prepare", { ...base, sourcePath: f.sourcePath, copyPath: f.copyPath, desired: { expectedText: f.expectedText } });
  const session = (plan: any) => callHost(stateDir, "sessions.prepare", { ...base, planId: plan.planId, intent: "Perform the fixed approved synthetic document copy.", cloud: true, maxRounds: 6 });
  return { ...f, stateDir, driver, outbound, started, service, base, prepare, session };
}
async function stop(service: Awaited<ReturnType<typeof startAgentService>>) { await service.stop(); services.delete(service); }
try {
  await test("Notepad preview is local and exact control approval verifies a new copy", async () => {
    const f = await setup(); const plan = await f.prepare();
    assert.deepEqual(f.driver.calls, []); assert.equal(f.outbound.length, 0);
    await assert.rejects(callHost(f.stateDir, "notepad.apply", { ...f.base, planId: plan.planId, digest: plan.digest }), hasCode("CONTROL_REQUIRED"));
    await assert.rejects(callHost(f.stateDir, "notepad.apply", { ...f.base, planId: plan.planId, digest: "wrong" }, { control: true }), hasCode("DIGEST_MISMATCH"));
    const result = await callHost(f.stateDir, "notepad.apply", { ...f.base, planId: plan.planId, digest: plan.digest }, { control: true });
    assert.equal(result.status, "succeeded"); assert.equal(fs.readFileSync(f.copyPath, "utf8"), f.expectedText); assert.equal(fs.readFileSync(f.sourcePath, "utf8"), f.sourceText);
    const count = f.driver.calls.length;
    assert.deepEqual(await callHost(f.stateDir, "notepad.apply", { ...f.base, planId: plan.planId, digest: plan.digest }, { control: true }), result); assert.equal(f.driver.calls.length, count);
    await stop(f.service);
  });
  await test("three model rounds advance one approved document and expose no document content to the model", async () => {
    const f = await setup(); const plan = await f.prepare();
    await assert.rejects(callHost(f.stateDir, "sessions.prepare", { ...f.base, planId: plan.planId, intent: "copy" }), hasCode("INVALID_REQUEST"));
    const s = await f.session(plan);
    await assert.rejects(callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: s.digest }), hasCode("CONTROL_REQUIRED"));
    await assert.rejects(callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: "wrong" }, { control: true }), hasCode("DIGEST_MISMATCH"));
    const result = await callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: s.digest }, { control: true });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error)); assert.equal(f.outbound.length, 3);
    assert.deepEqual(result.rounds.map((r: any) => r.proposal?.args.step), ["open", "edit", "save-copy"]);
    for (const body of f.outbound) { assert.ok(!body.includes(f.marker)); assert.ok(!body.includes(f.sourcePath)); assert.ok(!body.includes(f.expectedText)); assert.ok(!body.includes("sk-offline")); }
    assert.equal((await callHost(f.stateDir, "budget.get")).usedRequests, 3);
    const before = f.driver.calls.length;
    assert.equal((await callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: s.digest }, { control: true })).status, "succeeded"); assert.equal(f.driver.calls.length, before);
    await stop(f.service);
    const restarted = await startAgentService({ root: f.root, stateDir: f.stateDir, budgetDir: f.stateDir, notepadDriver: new FixtureNotepadDriver() }); services.add(restarted);
    assert.equal((await callHost(f.stateDir, "sessions.get", { ...f.base, sessionId: s.sessionId })).status, "succeeded");
    assert.equal((await callHost(f.stateDir, "budget.get")).usedRequests, 3);
    await stop(restarted);
  });
  await test("daily budget exhaustion prevents further document effects and survives service restart", async () => {
    const f = await setup({ limit: 1 }); const s = await f.session(await f.prepare());
    const result = await callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: s.digest }, { control: true });
    assert.notEqual(result.status, "succeeded"); assert.equal(f.outbound.length, 1); assert.ok(!f.driver.calls.includes("edit")); assert.ok(!fs.existsSync(f.copyPath));
    assert.equal((await callHost(f.stateDir, "budget.get")).usedRequests, 1); await stop(f.service);
  });
  await test("session cancellation rejects a late model proposal without opening Notepad", async () => {
    const block = gate(); const f = await setup({ modelGate: block }); const s = await f.session(await f.prepare());
    const running = callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: s.digest }, { control: true });
    await f.started.promise;
    const cancellation = await callHost(f.stateDir, "sessions.cancel", { ...f.base, sessionId: s.sessionId }); assert.ok(["cancelling", "cancelled"].includes(cancellation.status));
    block.resolve(); const result = await running; assert.equal(result.status, "cancelled"); assert.deepEqual(f.driver.calls, []); await stop(f.service);
  });
  await test("one host mutation lock excludes concurrent application execution", async () => {
    const block = gate(); const started = gate(); const driver = new FixtureNotepadDriver(); driver.beforeOpen = async () => { started.resolve(); await block.promise; };
    const f = await setup({ driver }); const first = await f.prepare();
    const other = await callHost(f.stateDir, "notepad.prepare", { ...f.base, sourcePath: f.sourcePath, copyPath: path.join(f.root, "other-copy.txt"), desired: { expectedText: f.expectedText } });
    const running = callHost(f.stateDir, "notepad.apply", { ...f.base, planId: first.planId, digest: first.digest }, { control: true }); await started.promise;
    await assert.rejects(callHost(f.stateDir, "notepad.apply", { ...f.base, planId: other.planId, digest: other.digest }, { control: true }), hasCode("HOST_BUSY"));
    await callHost(f.stateDir, "notepad.cancel", { ...f.base, taskId: first.taskId }); block.resolve(); assert.notEqual((await running).status, "succeeded");
    assert.ok(!fs.existsSync(f.copyPath)); await stop(f.service);
  });
  await test("CLI prepares and applies through the existing private host", async () => {
    const f = await setup(); const textFile = path.join(f.fixture, "expected.txt"); fs.writeFileSync(textFile, f.expectedText);
    const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, ["apps/agent/cli.ts", ...args], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true })).stdout);
    const base = ["--root", f.root, "--state", f.stateDir];
    const plan = await cli("notepad-plan", ...base, "--source", f.sourcePath, "--copy", f.copyPath, "--text-file", textFile);
    assert.ok(plan.nextCommand.includes("notepad-apply")); assert.equal((await cli("notepad-apply", ...base, "--plan", plan.planId, "--digest", plan.digest)).status, "succeeded");
    assert.equal((await cli("notepad-status", ...base, "--task", plan.taskId)).status, "succeeded"); await stop(f.service);
  });
  await test("unsupported capabilities fail before UI and unauthorized roots are refused", async () => {
    const driver = new FixtureNotepadDriver(); driver.capabilities.saveCopy = false; const f = await setup({ driver });
    await assert.rejects(f.prepare(), hasCode("CAPABILITY_UNAVAILABLE")); assert.deepEqual(driver.calls, []);
    await assert.rejects(callHost(f.stateDir, "notepad.list", { root: temporary }), hasCode("PLAN_SCOPE_MISMATCH"));
    assert.equal((await callHost(f.stateDir, "notepad.probe", f.base)).capabilities.saveCopy, false); await stop(f.service);
  });
  await test("shutdown does not lazily initialize another controller while an application is draining", async () => {
    const block = gate(); const opened = gate(); const driver = new FixtureNotepadDriver(); driver.beforeOpen = async () => { opened.resolve(); await block.promise; };
    const f = await setup({ driver }); const plan = await f.prepare();
    const running = callHost(f.stateDir, "notepad.apply", { ...f.base, planId: plan.planId, digest: plan.digest }, { control: true }); await opened.promise;
    const stopping = f.service.stop().then(() => null, error => error);
    await assert.rejects(callHost(f.stateDir, "sessions.list", f.base), hasCode("HOST_STOPPING"));
    assert.equal(fs.existsSync(path.join(f.stateDir, "autonomy")), false);
    block.resolve(); await running; const stopped = await stopping;
    if (stopped) { assert.ok(hasCode("HOST_STOP_INCOMPLETE")(stopped)); await new Promise(resolve => setTimeout(resolve, 30)); await f.service.stop(); }
    services.delete(f.service);
  });
  await test("unknown in-flight effect rejects all concurrent stops and later control shutdown can retry", async () => {
    const block = gate(); const opened = gate(); const driver = new FixtureNotepadDriver(); driver.beforeOpen = async () => { opened.resolve(); await block.promise; };
    const f = await setup({ driver }); const s = await f.session(await f.prepare());
    const running = callHost(f.stateDir, "sessions.run", { ...f.base, sessionId: s.sessionId, digest: s.digest }, { control: true }); await opened.promise;
    const first = f.service.stop(); const second = f.service.stop();
    const attempts = await Promise.allSettled([first, second]); assert.ok(attempts.every(r => r.status === "rejected" && hasCode("HOST_STOP_INCOMPLETE")(r.reason)));
    assert.equal((await running).status, "needs_attention");
    assert.equal((await callHost(f.stateDir, "health")).shutdownError, "HOST_STOP_INCOMPLETE");
    block.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await callHost(f.stateDir, "host.shutdown", {}, { control: true })).stopping, true);
    await f.service.closed; services.delete(f.service);
    assert.equal(fs.existsSync(path.join(f.stateDir, "host-endpoint.json")), false);
  });
  console.log(`Application service checks passed: ${passed}`);
} finally {
  for (const service of services) await service.stop();
  const resolved = path.resolve(temporary); if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("deskshell-app-service-")) throw new Error("Invalid cleanup scope");
  fs.rmSync(resolved, { recursive: true, force: true });
}
