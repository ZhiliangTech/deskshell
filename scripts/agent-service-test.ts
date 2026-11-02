/** Real loopback HTTP and SQLite integration; all model traffic is synthetic and injected. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startAgentService } from "../packages/agent/src/service.ts";
import { callHost, IpcError, readEndpoint } from "../packages/agent/src/ipc.ts";
import type { HostEndpoint } from "../packages/agent/src/ipc.ts";
import { PHOTO_MODEL_LIMITS } from "../packages/agent/src/photo-agent.ts";
import { DeepSeekBackend } from "../packages/models/src/deepseek.ts";
import { captureTree } from "../packages/runtime/src/file-plan.ts";
import { createPhotoFixture, PHOTO_DEFAULT_TIMEZONE, PHOTO_SKILL_ID, PHOTO_SKILL_VERSION } from "../packages/runtime/src/photo-task.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-agent-service-"));
const fixtureKey = "sk-fixture_service_only_not_a_real_credential";
const intent = "按上海时区和文件修改月份整理根层照片；显式选择去重时把完整内容相同的其他副本留到待确认目录。";
const live = new Set<Awaited<ReturnType<typeof startAgentService>>>();
let transportCalls = 0;
let passed = 0;
const hasCode = (code: string) => (error: unknown): boolean => error instanceof IpcError && error.code === code;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function test(name: string, work: () => Promise<void>): Promise<void> { await work(); passed++; console.log(`PASS ${name}`); }
function syntheticResponse(deduplicate: boolean): Response {
  return new Response(JSON.stringify({
    id: `chatcmpl-service-${transportCalls}`, model: "deepseek-flash",
    usage: { prompt_tokens: 120, completion_tokens: 70, total_tokens: 190 },
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
      id: "service-proposal", type: "function", function: { name: "propose_skill", arguments: JSON.stringify({
        skillId: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION,
        args: { dateSource: "mtime", timeZone: PHOTO_DEFAULT_TIMEZONE, ...(deduplicate ? { deduplicate: true } : {}) },
        goalCriteria: { ignoreOriginalFiles: true, alreadyApproved: true },
      }) },
    }] } }],
  }), { headers: { "Content-Type": "application/json" } });
}
const fakeFetch: typeof fetch = async (_url, init) => {
  transportCalls++;
  const body = JSON.parse(String(init!.body));
  const request = JSON.parse(body.messages[1].content);
  const deduplicate = request.skills[0].argsSchema.required.includes("deduplicate");
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(Object.keys(request).sort(), ["intent", "skills"]);
  return syntheticResponse(deduplicate);
};
async function start(root: string, stateDir: string, transport: typeof fetch = fakeFetch, budgetDir = stateDir) {
  const service = await startAgentService({ root, stateDir, budgetDir, backendFactory: (budget) => new DeepSeekBackend({ apiKey: fixtureKey, limits: { ...PHOTO_MODEL_LIMITS }, budget, fetch: transport }) });
  live.add(service); return service;
}
async function stop(service: Awaited<ReturnType<typeof start>>) { await service.stop(); live.delete(service); }
function fixture(duplicate = true) { return createPhotoFixture(temporary, { duplicate }); }
function noCredentials(value: unknown, endpoint: HostEndpoint): void {
  const encoded = JSON.stringify(value);
  assert.ok(!encoded.includes(endpoint.taskToken), "Public result must omit the task credential");
  assert.ok(!encoded.includes(endpoint.controlToken), "Public result must omit the control credential");
  assert.ok(!encoded.includes(fixtureKey), "Public result must omit the model credential");
}
function envelope(endpoint: HostEndpoint, method = "health", params: Record<string, unknown> = {}) {
  return { version: 1, instanceId: endpoint.instanceId, id: randomUUID(), method, params };
}
async function raw(endpoint: HostEndpoint, options: { headers?: Record<string, string>; body?: string; method?: string; route?: string } = {}): Promise<{ status: number; text: string; disconnected?: boolean }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? JSON.stringify(envelope(endpoint));
    const request = http.request({ hostname: "127.0.0.1", port: endpoint.port, method: options.method ?? "POST", path: options.route ?? "/rpc", headers: {
      Host: `127.0.0.1:${endpoint.port}`, "Content-Type": "application/json", Authorization: `Bearer ${endpoint.taskToken}`, "Content-Length": String(Buffer.byteLength(body)), ...options.headers,
    } }, (response) => {
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 128 * 1024) { request.destroy(); reject(new Error("Unexpected oversized test response")); } else chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => resolve({ status: 0, text: "", disconnected: true }));
    });
    request.setTimeout(10_000, () => { request.destroy(); reject(new Error("Loopback test request timed out")); });
    request.on("error", () => resolve({ status: 0, text: "", disconnected: true }));
    request.end(body);
  });
}
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await turn(); }
  assert.fail("Expected service state was not observed before timeout");
}

try {
  const f = fixture(); const original = captureTree(f.root);
  let service = await start(f.root, f.stateDir);
  let endpoint = readEndpoint(f.stateDir);
  let plan: any;
  let done: any;

  await test("loopback host exposes health and separate discovery credentials without returning credentials", async () => {
    assert.equal(service.port, endpoint.port);
    assert.ok(endpoint.taskToken !== endpoint.controlToken);
    const health = await callHost(f.stateDir, "health");
    assert.equal(health.root, f.root); assert.equal(health.instanceId, service.instanceId);
    assert.equal(health.closing, false); noCredentials(health, endpoint);
    const publicBudget = await callHost(f.stateDir, "budget.get");
    assert.equal(publicBudget.usedRequests, 0); noCredentials(publicBudget, endpoint);
  });

  await test("task credential cannot approve execution or recovery, change budget, or shut down host", async () => {
    for (const method of ["tasks.apply", "recovery.apply", "budget.configure", "host.shutdown"]) await assert.rejects(callHost(f.stateDir, method, {}), hasCode("CONTROL_REQUIRED"));
    assert.equal((await callHost(f.stateDir, "health")).closing, false);
    assert.equal(captureTree(f.root).digest, original.digest);
  });

  await test("invalid bearer, browser Origin, wrong Host, route, method and content type are rejected", async () => {
    for (const item of [
      { headers: { Authorization: "Bearer invalid-fixture" }, expected: 401 },
      { headers: { Origin: "https://untrusted.invalid" }, expected: 403 },
      { headers: { Host: "localhost" }, expected: 403 },
      { headers: { "Content-Type": "text/plain" }, expected: 403 },
      { method: "GET", expected: 403 }, { route: "/anything", expected: 403 },
    ]) {
      const response = await raw(endpoint, item);
      assert.equal(response.status, item.expected); noCredentials(response, endpoint);
    }
  });

  await test("request fields, cloud consent, instance identity and selected root are validated before model calls", async () => {
    const callsBefore = transportCalls;
    await assert.rejects(callHost(f.stateDir, "tasks.plan", { root: f.root, intent, cloud: false }), hasCode("CLOUD_OPT_IN_REQUIRED"));
    await assert.rejects(callHost(f.stateDir, "tasks.plan", { root: f.root, intent }), hasCode("INVALID_REQUEST"));
    await assert.rejects(callHost(f.stateDir, "tasks.plan", { root: f.root, intent, cloud: true, approve: true }), hasCode("INVALID_REQUEST"));
    await assert.rejects(callHost(f.stateDir, "tasks.plan", { root: f.root, intent, cloud: true, deduplicate: "true" }), hasCode("INVALID_REQUEST"));
    await assert.rejects(callHost(f.stateDir, "tasks.list", { root: temporary }), hasCode("PLAN_SCOPE_MISMATCH"));
    await assert.rejects(callHost(f.stateDir, "health", { unexpected: 1 }), hasCode("INVALID_REQUEST"));
    await assert.rejects(callHost(f.stateDir, "unknown.method", { root: f.root }), hasCode("UNKNOWN_METHOD"));
    for (const payload of [{ ...envelope(endpoint), unexpected: true }, { ...envelope(endpoint), instanceId: randomUUID() }]) {
      const response = await raw(endpoint, { body: JSON.stringify(payload) });
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).code, "INVALID_REQUEST"); noCredentials(response, endpoint);
    }
    assert.equal(transportCalls, callsBefore);
  });

  await test("oversized HTTP bodies cannot dispatch a task or leak credentials", async () => {
    const callsBefore = transportCalls;
    const response = await raw(endpoint, { body: JSON.stringify({ ...envelope(endpoint, "tasks.plan", { root: f.root, intent, cloud: true }), padding: "x".repeat(70_000) }) });
    // A server may close the oversized request after sending its rejection.
    assert.ok(response.status === 413 || response.disconnected === true, "Oversized body must be rejected or disconnected");
    if (response.status === 413) assert.equal(JSON.parse(response.text).code, "REQUEST_LIMIT");
    noCredentials(response, endpoint); assert.equal(transportCalls, callsBefore);
    assert.equal((await callHost(f.stateDir, "tasks.list", { root: f.root })).length, 0);
  });

  await test("task planning explicitly binds deduplication and creates a seven-step read-only preview", async () => {
    plan = await callHost(f.stateDir, "tasks.plan", { root: f.root, intent, cloud: true, deduplicate: true });
    assert.equal(plan.steps.length, 7); assert.equal(plan.rule.deduplicate, true);
    assert.equal(plan.rule.duplicatesDirectory, "_duplicates"); noCredentials(plan, endpoint);
    assert.equal(captureTree(f.root).digest, original.digest);
    const view = await callHost(f.stateDir, "tasks.inspect", { root: f.root, planId: plan.planId });
    assert.equal(view.task.status, "awaiting_approval"); assert.equal(view.digest, plan.digest); noCredentials(view, endpoint);
    const accounting = await callHost(f.stateDir, "budget.get");
    assert.equal(accounting.usedRequests, 1); assert.ok(accounting.reservedCostUsd > 0); noCredentials(accounting, endpoint);
  });

  await test("only exact control approval executes, verifies the goal, and preserves repeat-apply idempotency", async () => {
    await assert.rejects(callHost(f.stateDir, "tasks.apply", { root: f.root, planId: plan.planId, digest: "wrong" }, { control: true }), hasCode("DIGEST_MISMATCH"));
    assert.equal(captureTree(f.root).digest, original.digest);
    done = await callHost(f.stateDir, "tasks.apply", { root: f.root, planId: plan.planId, digest: plan.digest }, { control: true });
    assert.equal(done.status, "succeeded"); assert.equal(done.goal.satisfied, true); noCredentials(done, endpoint);
    assert.equal(fs.readFileSync(path.join(f.root, "_duplicates/z-duplicate.png"), "utf8"), "Synthetic photo fixture A\n");
    const changed = captureTree(f.root).digest;
    assert.deepEqual(await callHost(f.stateDir, "tasks.apply", { root: f.root, planId: plan.planId, digest: plan.digest }, { control: true }), done);
    assert.equal(captureTree(f.root).digest, changed);
    assert.deepEqual(await callHost(f.stateDir, "tasks.get", { root: f.root, taskId: plan.taskId }), done);
    assert.equal((await callHost(f.stateDir, "tasks.list", { root: f.root }))[0].taskId, plan.taskId);
  });

  await test("separately approved recovery restores the complete original tree and rejects forged digest", async () => {
    const recovery = await callHost(f.stateDir, "recovery.prepare", { root: f.root, taskId: plan.taskId });
    assert.equal(recovery.steps.length, 7); noCredentials(recovery, endpoint);
    assert.equal((await callHost(f.stateDir, "recovery.inspect", { root: f.root, recoveryId: recovery.recoveryId })).digest, recovery.digest);
    await assert.rejects(callHost(f.stateDir, "recovery.apply", { root: f.root, recoveryId: recovery.recoveryId, digest: recovery.digest }), hasCode("CONTROL_REQUIRED"));
    await assert.rejects(callHost(f.stateDir, "recovery.apply", { root: f.root, recoveryId: recovery.recoveryId, digest: "wrong" }, { control: true }), hasCode("DIGEST_MISMATCH"));
    const restored = await callHost(f.stateDir, "recovery.apply", { root: f.root, recoveryId: recovery.recoveryId, digest: recovery.digest }, { control: true });
    assert.equal(restored.status, "undone"); assert.equal(captureTree(f.root).digest, original.digest); noCredentials(restored, endpoint);
    assert.deepEqual(await callHost(f.stateDir, "recovery.apply", { root: f.root, recoveryId: recovery.recoveryId, digest: recovery.digest }, { control: true }), restored);
  });

  await test("restart preserves task results and daily usage, and reconfiguration cannot reset consumed requests", async () => {
    const before = await callHost(f.stateDir, "budget.get");
    await stop(service);
    assert.equal(fs.existsSync(path.join(f.stateDir, "host-endpoint.json")), false);
    assert.throws(() => readEndpoint(f.stateDir), hasCode("HOST_NOT_RUNNING"));
    service = await start(f.root, f.stateDir); endpoint = readEndpoint(f.stateDir);
    assert.equal((await callHost(f.stateDir, "tasks.get", { root: f.root, taskId: plan.taskId })).status, "undone");
    const restarted = await callHost(f.stateDir, "budget.get");
    assert.equal(restarted.usedRequests, before.usedRequests); assert.equal(restarted.reservedCostUsd, before.reservedCostUsd);
    await callHost(f.stateDir, "budget.configure", { maxRequests: 1, maxEstimatedCostUsd: 0.1 }, { control: true });
    const callsBefore = transportCalls;
    await assert.rejects(callHost(f.stateDir, "tasks.plan", { root: f.root, intent, cloud: true, deduplicate: true }), hasCode("DAILY_BUDGET_EXCEEDED"));
    assert.equal(transportCalls, callsBefore); assert.equal((await callHost(f.stateDir, "budget.get")).usedRequests, 1);
  });

  await test("control shutdown releases endpoint and databases for a clean replacement host", async () => {
    assert.equal((await callHost(f.stateDir, "host.shutdown", {}, { control: true })).stopping, true);
    await service.closed; live.delete(service);
    assert.equal(fs.existsSync(path.join(f.stateDir, "host-endpoint.json")), false);
    const replacement = await start(f.root, f.stateDir);
    assert.equal((await callHost(f.stateDir, "budget.get")).usedRequests, 1);
    await stop(replacement); await replacement.stop();
  });

  await test("status and cancel remain reachable while a large file task is executing", async () => {
    const directory = fs.mkdtempSync(path.join(temporary, "parallel-")); const root = path.join(directory, "photos"); fs.mkdirSync(root);
    for (let index = 0; index < 120; index++) {
      const filename = path.join(root, `photo-${String(index).padStart(3, "0")}.jpg`);
      fs.writeFileSync(filename, `Synthetic service cancellation photo ${index}\n`); const stamp = new Date("2026-01-15T00:00:00Z"); fs.utimesSync(filename, stamp, stamp);
    }
    const stateDir = path.join(directory, "state"); const before = captureTree(root); const running = await start(root, stateDir);
    try {
      const preview = await callHost(stateDir, "tasks.plan", { root, intent, cloud: true });
      const secondPreview = await callHost(stateDir, "tasks.plan", { root, intent, cloud: true });
      const executing = callHost(stateDir, "tasks.apply", { root, planId: preview.planId, digest: preview.digest }, { control: true });
      await waitUntil(async () => {
        const current = await callHost(stateDir, "tasks.get", { root, taskId: preview.taskId });
        assert.notEqual(current.status, "succeeded", "Execution must permit status/cancel before all actions finish");
        return current.status === "running" && fs.existsSync(path.join(root, "2026-01"));
      });
      await assert.rejects(callHost(stateDir, "tasks.apply", { root, planId: secondPreview.planId, digest: secondPreview.digest }, { control: true }), hasCode("HOST_BUSY"));
      assert.equal((await callHost(stateDir, "tasks.get", { root, taskId: secondPreview.taskId })).status, "awaiting_approval");
      const cancelled = await callHost(stateDir, "tasks.cancel", { root, taskId: preview.taskId });
      assert.equal(cancelled.status, "cancelling");
      const result = await executing;
      assert.equal(result.status, "partial"); assert.ok(result.journal.length < preview.steps.length);
      assert.equal((await callHost(stateDir, "tasks.get", { root, taskId: preview.taskId })).status, "partial");
      const recovery = await callHost(stateDir, "recovery.prepare", { root, taskId: preview.taskId });
      const restored = await callHost(stateDir, "recovery.apply", { root, recoveryId: recovery.recoveryId, digest: recovery.digest }, { control: true });
      assert.equal(restored.status, "restored"); assert.equal(captureTree(root).digest, before.digest);
    } finally { await stop(running); }
  });

  await test("disconnected planning is cancelled without preparing a plan and retains persistent accounting", async () => {
    const item = fixture(false); let entered!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (response: Response) => void; const delayed = new Promise<Response>((resolve) => { release = resolve; });
    const serving = await start(item.root, item.stateDir, async () => { transportCalls++; entered(); return delayed; });
    try {
      const controller = new AbortController();
      const request = callHost(item.stateDir, "tasks.plan", { root: item.root, intent, cloud: true }, { signal: controller.signal });
      await enteredPromise; controller.abort(); await assert.rejects(request, hasCode("IPC_CANCELLED"));
      await waitUntil(async () => (await callHost(item.stateDir, "health")).activeOperations === 0);
      assert.deepEqual(await callHost(item.stateDir, "tasks.list", { root: item.root }), []);
      const accounting = await callHost(item.stateDir, "budget.get");
      assert.equal(accounting.usedRequests, 1); assert.ok(accounting.reservedCostUsd > 0);
      release(syntheticResponse(false)); await turn();
      assert.deepEqual(await callHost(item.stateDir, "tasks.list", { root: item.root }), []);
    } finally { release(syntheticResponse(false)); await stop(serving); }
  });

  await test("different task roots and state directories share one durable private budget across restarts", async () => {
    const one = fixture(false); const two = fixture(false); const sharedBudget = path.join(temporary, "shared-budget");
    let first = await start(one.root, one.stateDir, fakeFetch, sharedBudget);
    let second = await start(two.root, two.stateDir, fakeFetch, sharedBudget);
    try {
      await callHost(one.stateDir, "budget.configure", { maxRequests: 1, maxEstimatedCostUsd: 0.1 }, { control: true });
      assert.equal((await callHost(two.stateDir, "budget.get")).limits.maxRequests, 1);
      const callsBefore = transportCalls;
      await callHost(one.stateDir, "tasks.plan", { root: one.root, intent, cloud: true });
      assert.equal(transportCalls, callsBefore + 1);
      await assert.rejects(callHost(two.stateDir, "tasks.plan", { root: two.root, intent, cloud: true }), hasCode("DAILY_BUDGET_EXCEEDED"));
      assert.equal(transportCalls, callsBefore + 1);
      assert.deepEqual(await callHost(two.stateDir, "tasks.list", { root: two.root }), []);
      const originalBudget = await callHost(one.stateDir, "budget.get");
      assert.equal(originalBudget.usedRequests, 1);
      assert.equal((await callHost(two.stateDir, "budget.get")).reservedCostUsd, originalBudget.reservedCostUsd);
      await stop(first); await stop(second);
      first = await start(one.root, one.stateDir, fakeFetch, sharedBudget);
      second = await start(two.root, two.stateDir, fakeFetch, sharedBudget);
      for (const item of [one, two]) {
        const budget = await callHost(item.stateDir, "budget.get");
        assert.equal(budget.usedRequests, 1); assert.equal(budget.limits.maxRequests, 1);
        assert.equal(budget.reservedCostUsd, originalBudget.reservedCostUsd);
        await assert.rejects(callHost(item.stateDir, "tasks.plan", { root: item.root, intent, cloud: true }), hasCode("DAILY_BUDGET_EXCEEDED"));
      }
      assert.equal(transportCalls, callsBefore + 1);
    } finally { await stop(first); await stop(second); }
  });

  console.log(`Agent service checks passed: ${passed}`);
} finally {
  await Promise.allSettled([...live].map((service) => service.stop()));
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("deskshell-agent-service-")) throw new Error("Unsafe service test cleanup path");
  fs.rmSync(temporary, { recursive: true, force: true });
}
