/** Isolated SQLite and injected-transport checks. Never reads credentials or calls a model service. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelBudget, BudgetError, DEFAULT_DAILY_MODEL_LIMITS } from "../packages/models/src/budget.ts";
import type { ModelBudgetHook, ModelBudgetReservation } from "../packages/models/src/budget.ts";
import { DeepSeekBackend, ModelError } from "../packages/models/src/deepseek.ts";
import type { ProposalRequest } from "../packages/models/src/deepseek.ts";

const reserve = (reservationToken: string, estimatedCostUsd = 0.02): ModelBudgetReservation => ({ reservationToken, estimatedCostUsd, provider: "deepseek", model: "deepseek-flash" });
if (process.argv[2] === "--reserve-worker") {
  const budget = new ModelBudget(process.argv[3]);
  process.send?.({ ready: true });
  process.once("message", () => {
    let result: { ok: boolean; code?: string };
    try { budget.reserve(reserve(process.argv[4])); result = { ok: true }; }
    catch (error) { result = { ok: false, code: error instanceof BudgetError ? error.code : "UNEXPECTED" }; }
    finally { budget.close(); }
    process.send?.(result, () => process.exit(0));
  });
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-model-budget-check-"));
  let passed = 0; let sequence = 0;
  const dir = (): string => path.join(temp, `case-${++sequence}`);
  const open = (where: string, maxRequests = 10, maxEstimatedCostUsd = 0.10, now?: () => Date): ModelBudget => new ModelBudget(where, { initialLimits: { maxRequests, maxEstimatedCostUsd }, ...(now ? { now } : {}) });
  function rejects(action: () => unknown, code: string): void {
    assert.throws(action, (error) => error instanceof BudgetError && error.code === code);
  }
  async function modelRejects(action: () => unknown, code: string): Promise<void> {
    await assert.rejects(async () => await action(), (error) => {
      assert.ok(error instanceof ModelError); assert.equal(error.code, code);
      assert.ok(!String(error).includes(fixtureKey)); return true;
    });
  }
  async function test(name: string, run: () => unknown): Promise<void> { await run(); passed++; console.log(`PASS ${name}`); }
  const fixtureKey = "sk-budget_fixture_only_not_a_real_key_123456";
  const limits = { maxRequests: 1, maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 1000, maxEstimatedCostUsd: 0.01 };
  const request: ProposalRequest = { intent: "Prepare a synthetic fixture", skills: [{ id: "fixture", version: "1", description: "Synthetic proposal only", argsSchema: { type: "object", properties: {}, additionalProperties: false } }] };
  const response = (usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) => new Response(JSON.stringify({
    id: "request-fixture", model: "deepseek-flash", usage,
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ type: "function", function: { name: "propose_skill", arguments: JSON.stringify({ skillId: "fixture", version: "1", args: {}, goalCriteria: {} }) } }] } }],
  }));
  const model = (budget: ModelBudgetHook, transport: typeof fetch, extra = {}) => new DeepSeekBackend({ apiKey: fixtureKey, limits: { ...limits, ...extra }, budget, fetch: transport });
  try {
    await test("defaults are persistent UTC limits with no initial usage", () => {
      const budget = new ModelBudget(dir());
      try { const state = budget.snapshot(); assert.deepEqual(state.limits, DEFAULT_DAILY_MODEL_LIMITS); assert.equal(state.timezone, "UTC"); assert.equal(state.usedRequests, 0); assert.equal(state.remainingRequests, 10); assert.equal(state.recentRequests.length, 0); }
      finally { budget.close(); }
    });
    await test("reopening a budget does not reset requests, cost or orphan reservations", () => {
      const where = dir(); let budget = open(where); budget.reserve(reserve("persistent")); budget.close();
      budget = new ModelBudget(where);
      try { const state = budget.snapshot(); assert.equal(state.usedRequests, 1); assert.equal(state.reservedCostUsd, 0.02); assert.equal(state.inFlightRequests, 1); assert.equal(state.recentRequests[0].status, "reserved"); }
      finally { budget.close(); }
    });
    await test("request and cost admission reject without adding another request", () => {
      const one = open(dir(), 1, 0.1); const money = open(dir(), 10, 0.03);
      try { one.reserve(reserve("one")); rejects(() => one.reserve(reserve("two")), "DAILY_BUDGET_EXCEEDED"); money.reserve(reserve("one")); rejects(() => money.reserve(reserve("two")), "DAILY_BUDGET_EXCEEDED"); assert.equal(one.snapshot().usedRequests, 1); assert.equal(money.snapshot().reservedCostUsd, 0.02); }
      finally { one.close(); money.close(); }
    });
    await test("reservation tokens are idempotent and conflicting reuse is rejected", () => {
      const budget = open(dir());
      try { const ticket = budget.reserve(reserve("same")); assert.deepEqual(budget.reserve(reserve("same")), ticket); assert.equal(budget.snapshot().usedRequests, 1); rejects(() => budget.reserve(reserve("same", 0.03)), "BUDGET_RESERVATION_CONFLICT"); rejects(() => budget.settle({ ...ticket, reservationToken: "missing" }, { status: "unknown", estimatedCostUsd: 0.02 }), "BUDGET_RESERVATION_NOT_FOUND"); }
      finally { budget.close(); }
    });
    await test("settlement never refunds and exact retries cannot charge twice", () => {
      const budget = open(dir());
      try {
        const ticket = budget.reserve(reserve("settle")); const outcome = { status: "succeeded" as const, estimatedCostUsd: 0.01, requestId: "remote-1", model: "deepseek-flash", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
        assert.equal(budget.settle(ticket, outcome).accountedCostUsd, 0.02); budget.settle(ticket, outcome);
        assert.equal(budget.snapshot().reservedCostUsd, 0.02); assert.equal(budget.snapshot().inFlightRequests, 0);
        rejects(() => budget.settle(ticket, { ...outcome, estimatedCostUsd: 0.03 }), "BUDGET_SETTLEMENT_CONFLICT");
      } finally { budget.close(); }
    });
    await test("reported overage is retained even above the cap and blocks later requests", () => {
      const budget = open(dir(), 10, 0.03);
      try { const ticket = budget.reserve(reserve("over")); const result = budget.settle(ticket, { status: "succeeded", estimatedCostUsd: 0.04 }); assert.equal(result.dailyLimitExceeded, true); assert.equal(budget.snapshot().reservedCostUsd, 0.04); assert.equal(budget.snapshot().remainingEstimatedCostUsd, 0); rejects(() => budget.reserve(reserve("later", 0.001)), "DAILY_BUDGET_EXCEEDED"); }
      finally { budget.close(); }
    });
    await test("decimal reservations round conservatively and tickets settle without rounding drift", () => {
      const budget = open(dir());
      try { for (const [index, cost] of [0.0008271, 0.0000001, 0.0000000001, 0.014, 0.030000000000000002].entries()) { const ticket = budget.reserve(reserve(`decimal-${index}`, cost)); assert.ok(ticket.estimatedCostUsd >= cost); budget.settle(ticket, { status: "unknown", estimatedCostUsd: ticket.estimatedCostUsd }); } assert.equal(budget.snapshot().usedRequests, 5); }
      finally { budget.close(); }
    });
    await test("unknown, failed and cancelled calls retain their full reservations", () => {
      const budget = open(dir());
      try { for (const status of ["unknown", "failed", "cancelled"] as const) { const ticket = budget.reserve(reserve(status)); budget.settle(ticket, { status, estimatedCostUsd: 0, errorCode: "TEST_FAILURE" }); } assert.equal(budget.snapshot().usedRequests, 3); assert.equal(budget.snapshot().reservedCostUsd, 0.06); assert.equal(budget.snapshot().inFlightRequests, 0); }
      finally { budget.close(); }
    });
    await test("UTC rollover gets a fresh day while late settlement remains on its original day", () => {
      let now = new Date("2026-10-31T23:59:59.000Z"); const budget = open(dir(), 1, 0.10, () => now);
      try { const old = budget.reserve(reserve("old")); now = new Date("2026-11-01T00:00:00.000Z"); assert.equal(budget.snapshot().usedRequests, 0); budget.reserve(reserve("new")); budget.settle(old, { status: "succeeded", estimatedCostUsd: 0.04 }); const state = budget.snapshot(); assert.equal(state.billingDay, "2026-11-01"); assert.equal(state.usedRequests, 1); assert.equal(state.reservedCostUsd, 0.02); assert.equal(state.recentRequests.find((item) => item.reservationToken === "old")!.accountedCostUsd, 0.04); }
      finally { budget.close(); }
    });
    await test("clock rollback cannot reuse expired day allowance, including after restart", () => {
      const where = dir(); let now = new Date("2026-10-31T12:00:00Z"); let budget = open(where, 1, 0.1, () => now);
      budget.reserve(reserve("october")); now = new Date("2026-11-01T00:00:00Z"); budget.reserve(reserve("november")); budget.close();
      now = new Date("2026-10-30T23:00:00Z"); budget = new ModelBudget(where, { now: () => now });
      try { const state = budget.snapshot(); assert.equal(state.billingDay, "2026-11-01"); assert.equal(state.clockRollbackDetected, true); assert.equal(state.usedRequests, 1); rejects(() => budget.reserve(reserve("rollback")), "DAILY_BUDGET_EXCEEDED"); }
      finally { budget.close(); }
    });
    await test("a denied request still persists the observed UTC day high-water mark", () => {
      let now = new Date("2026-10-31T12:00:00Z"); const budget = open(dir(), 0, 0, () => now);
      try { now = new Date("2026-11-01T00:00:00Z"); rejects(() => budget.reserve(reserve("denied")), "DAILY_BUDGET_EXCEEDED"); now = new Date("2026-10-31T13:00:00Z"); assert.equal(budget.snapshot().billingDay, "2026-11-01"); assert.equal(budget.snapshot().clockRollbackDetected, true); }
      finally { budget.close(); }
    });
    await test("constructor configuration cannot reset limits and explicit changes preserve usage", () => {
      const where = dir(); let budget = open(where, 1, 0.05); budget.reserve(reserve("before-config")); budget.close();
      rejects(() => open(where, 10, 0.1), "BUDGET_CONFIG_MISMATCH"); budget = new ModelBudget(where);
      try { const changed = budget.configure({ maxRequests: 2, maxEstimatedCostUsd: 0.08 }); assert.equal(changed.usedRequests, 1); assert.equal(changed.reservedCostUsd, 0.02); budget.reserve(reserve("after-config")); assert.equal(budget.configure({ maxRequests: 1, maxEstimatedCostUsd: 0.01 }).usedRequests, 2); rejects(() => budget.reserve(reserve("lowered")), "DAILY_BUDGET_EXCEEDED"); }
      finally { budget.close(); }
      budget = new ModelBudget(where); try { assert.deepEqual(budget.snapshot().limits, { maxRequests: 1, maxEstimatedCostUsd: 0.01 }); assert.equal(budget.snapshot().usedRequests, 2); } finally { budget.close(); }
    });
    await test("unsupported fields and malformed values never enter the ledger", () => {
      const budget = open(dir());
      try { rejects(() => budget.reserve({ ...reserve("bad"), prompt: "private" } as ModelBudgetReservation), "INVALID_BUDGET_ARGUMENT"); rejects(() => budget.configure({ maxRequests: -1, maxEstimatedCostUsd: 0.1 }), "INVALID_BUDGET_ARGUMENT"); const ticket = budget.reserve(reserve("normal")); rejects(() => budget.settle(ticket, { status: "succeeded", estimatedCostUsd: 0.02, usage: { promptTokens: 20, completionTokens: 3, totalTokens: 2 } }), "INVALID_BUDGET_ARGUMENT"); assert.equal(budget.snapshot().inFlightRequests, 1); assert.ok(!JSON.stringify(budget.snapshot()).includes("private")); }
      finally { budget.close(); }
    });
    await test("unrelated or unreadable stores fail closed with sanitized errors", () => {
      const where = dir(); fs.mkdirSync(where); fs.writeFileSync(path.join(where, "model-budget.sqlite"), "not a SQLite database"); rejects(() => new ModelBudget(where), "BUDGET_STORE_FAILED"); const budget = open(dir()); budget.close(); rejects(() => budget.reserve(reserve("closed")), "BUDGET_STORE_FAILED");
    });
    await test("two real child processes compete for the final daily request", async () => {
      const where = dir(); const budget = open(where, 1, 0.1); budget.close();
      const children = ["worker-one", "worker-two"].map((token) => {
        const child = spawn(process.execPath, [import.meta.filename, "--reserve-worker", where, token], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        let output = ""; child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", () => undefined);
        let readyResolve: () => void; let resultResolve: (result: { ok: boolean; code?: string }) => void;
        const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
        const result = new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
          resultResolve = resolve; const timer = setTimeout(() => { child.kill(); reject(new Error("Worker timed out")); }, 20_000);
          child.on("error", reject); child.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Worker failed ${code}: ${output}`)); });
        });
        child.on("message", (message: { ready?: boolean; ok: boolean; code?: string }) => { if (message.ready) readyResolve(); else resultResolve(message); });
        return { child, ready, result };
      });
      await Promise.all(children.map((child) => child.ready)); children.forEach(({ child }) => child.send("go"));
      const results = await Promise.all(children.map((child) => child.result));
      assert.equal(results.filter((result) => result.ok).length, 1); assert.equal(results.find((result) => !result.ok)?.code, "DAILY_BUDGET_EXCEEDED");
      const reopened = new ModelBudget(where); try { assert.equal(reopened.snapshot().usedRequests, 1); assert.equal(reopened.snapshot().reservedCostUsd, 0.02); } finally { reopened.close(); }
    });
    await test("adapter persists admission before HTTP and settles only bounded metadata", async () => {
      const budget = open(dir()); let calls = 0;
      try { await model(budget, async () => { calls++; assert.equal(budget.snapshot().inFlightRequests, 1); assert.equal(budget.snapshot().usedRequests, 1); return response(); }).propose(request); const state = budget.snapshot(); assert.equal(calls, 1); assert.equal(state.inFlightRequests, 0); assert.equal(state.recentRequests[0].status, "succeeded"); assert.deepEqual(state.recentRequests[0].usage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 }); assert.equal(state.recentRequests[0].requestId, "request-fixture"); assert.ok(!JSON.stringify(state).includes(fixtureKey)); assert.ok(!JSON.stringify(state).includes(request.intent)); }
      finally { budget.close(); }
    });
    await test("daily exhaustion and store failure both prevent HTTP", async () => {
      const budget = open(dir(), 0, 0); let calls = 0;
      const transport = async () => { calls++; return response(); };
      try { await modelRejects(() => model(budget, transport).propose(request), "DAILY_BUDGET_EXCEEDED"); budget.close(); await modelRejects(() => model(budget, transport).propose(request), "BUDGET_STORE_FAILED"); assert.equal(calls, 0); }
      finally { budget.close(); }
    });
    await test("adapter cancellation and ambiguous transport failure retain charged reservations", async () => {
      const budget = open(dir()); const controller = new AbortController();
      try {
        await modelRejects(() => model(budget, async () => { controller.abort(); return response(); }).propose({ ...request, signal: controller.signal }), "CANCELLED");
        await modelRejects(() => model(budget, async () => { throw new Error(fixtureKey); }).propose(request), "TRANSPORT_ERROR");
        const state = budget.snapshot(); assert.equal(state.usedRequests, 2); assert.ok(state.reservedCostUsd > 0); assert.deepEqual(new Set(state.recentRequests.map((row) => row.status)), new Set(["cancelled", "unknown"])); assert.equal(state.inFlightRequests, 0);
      } finally { budget.close(); }
    });
    await test("pre-cancellation consumes neither persistent nor instance admission", async () => {
      const budget = open(dir()); const controller = new AbortController(); controller.abort(); let calls = 0;
      try { const backend = model(budget, async () => { calls++; return response(); }); await modelRejects(() => backend.propose({ ...request, signal: controller.signal }), "CANCELLED"); assert.equal(calls, 0); assert.equal(budget.snapshot().usedRequests, 0); assert.equal(backend.getBudget().requests, 0); }
      finally { budget.close(); }
    });
    await test("post-request settlement failure is sanitized and restart retains reservation", async () => {
      const where = dir(); let budget = open(where);
      await modelRejects(() => model(budget, async () => { budget.close(); return response(); }).propose(request), "BUDGET_SETTLEMENT_FAILED");
      budget = new ModelBudget(where); try { const state = budget.snapshot(); assert.equal(state.usedRequests, 1); assert.equal(state.inFlightRequests, 1); assert.ok(state.reservedCostUsd > 0); } finally { budget.close(); }
    });
    await test("reported model usage can top up a reservation and deny the proposal at the daily cap", async () => {
      const budget = open(dir(), 10, 0.001);
      try { await modelRejects(() => model(budget, async () => response({ prompt_tokens: 5000, completion_tokens: 20, total_tokens: 5020 })).propose(request), "DAILY_BUDGET_EXCEEDED"); const state = budget.snapshot(); assert.ok(state.reservedCostUsd > 0.001); assert.equal(state.recentRequests[0].usage!.promptTokens, 5000); }
      finally { budget.close(); }
    });
    await test("HTTP rejection is recorded without retaining provider body or secret error text", async () => {
      const budget = open(dir());
      try { await modelRejects(() => model(budget, async () => new Response(fixtureKey, { status: 401 })).propose(request), "AUTH_FAILED"); const record = budget.snapshot().recentRequests[0]; assert.equal(record.status, "failed"); assert.equal(record.errorCode, "AUTH_FAILED"); assert.equal(record.usage, null); assert.ok(!JSON.stringify(record).includes(fixtureKey)); }
      finally { budget.close(); }
    });
    await test("cancellation observed during settlement cannot return a late proposal", async () => {
      const budget = open(dir()); const controller = new AbortController();
      const hook: ModelBudgetHook = { reserve: (input) => budget.reserve(input), settle: (ticket, outcome) => { const settled = budget.settle(ticket, outcome); controller.abort(); return settled; } };
      try { await modelRejects(() => model(hook, async () => response()).propose({ ...request, signal: controller.signal }), "CANCELLED"); assert.equal(budget.snapshot().usedRequests, 1); assert.equal(budget.snapshot().inFlightRequests, 0); }
      finally { budget.close(); }
    });
    console.log(`Model budget checks passed: ${passed}`);
  } finally {
    if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith("deskshell-model-budget-check-")) throw new Error("Unsafe cleanup scope");
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
