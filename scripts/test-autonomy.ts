import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { AutonomyError, createAutonomyHost } from "../packages/agent/src/autonomy.ts";
import type { AutonomyAdapter, AutonomyBackend, AutonomyEnvelope, AutonomyRunRequest } from "../packages/agent/src/autonomy.ts";
import { createTaskHost } from "../packages/runtime/src/host.ts";
import { BudgetError, ModelBudget } from "../packages/models/src/budget.ts";
import { DeepSeekBackend, ModelError } from "../packages/models/src/deepseek.ts";
import { NotepadTaskError } from "../packages/runtime/src/notepad-task.ts";
import type { ModelProposal, ProposalRequest, ProposalResult } from "../packages/models/src/deepseek.ts";

const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const proposal = (): ModelProposal => ({ skillId: "increment", version: "1", args: { amount: 1 }, goalCriteria: { satisfied: true, target: 0 } });
const result = (value = proposal()): ProposalResult => ({ proposal: value, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }, model: "synthetic", requestId: "synthetic-request", estimatedCostUsd: 0, budget: { requests: 1, reservedCostUsd: 0 } });
const backend: AutonomyBackend = { propose: async () => result() };
function adapterFor(file: string, overrides: Partial<AutonomyAdapter> = {}): AutonomyAdapter {
  return {
    id: "synthetic-counter", version: "1", revision: () => "synthetic-code-v1",
    skills: [{ id: "increment", version: "1", description: "Increment an approved counter", argsSchema: { type: "object", properties: { amount: { type: "integer", minimum: 1, maximum: 2 } }, required: ["amount"], additionalProperties: false } }],
    observe: () => ({ state: { counter: Number(fs.readFileSync(file, "utf8")), localSecret: "LOCAL_ONLY_SENTINEL" }, modelContext: { counter: Number(fs.readFileSync(file, "utf8")) } }),
    verify: ({ envelope, observation }) => ({ satisfied: (observation.state as { counter: number }).counter === (envelope.goal.criteria as { target: number }).target, detail: "Local counter equality checked" }),
    validate: ({ proposal: value }) => ({ capabilities: ["counter.write"], resourceIds: ["counter"], outputIds: ["counter"], effect: "write", payload: { amount: value.args.amount } }),
    execute: ({ envelope, action }) => {
      assert.equal((envelope.resources.counter as { file: string }).file, file);
      const value = Number(fs.readFileSync(file, "utf8")) + (action.payload as { amount: number }).amount;
      fs.writeFileSync(file, String(value));
      return { outcome: "completed", evidence: { file, value, privateDetail: "EVIDENCE_ONLY_SENTINEL" }, modelFeedback: { counterChanged: true } };
    }, ...overrides,
  };
}
function envelopeFor(file: string, overrides: Partial<AutonomyEnvelope> = {}): AutonomyEnvelope {
  return { workflow: { id: "synthetic-counter", version: "1" }, goal: { intent: "Reach the approved counter target", criteria: { target: 2, localOnly: "CRITERIA_ONLY_SENTINEL" } }, resources: { counter: { file, localOnly: "RESOURCE_ONLY_SENTINEL" } }, allowedCapabilities: ["counter.write"], allowedOutputs: ["counter"], maxRounds: 4, maxDurationMs: 10_000, ...overrides };
}
type Host = ReturnType<typeof createAutonomyHost>;
function authorized(host: Host, envelope: AutonomyEnvelope): AutonomyRunRequest {
  const plan = host.sessions.prepare(envelope);
  return { sessionId: plan.sessionId, digest: plan.digest, approvalReceiptId: host.approvals.approve(plan.sessionId, plan.digest).approvalId };
}
function guardedTemp(file: string): void {
  const parent = path.dirname(path.dirname(file));
  if (path.dirname(parent) !== path.resolve(os.tmpdir()) || !path.basename(parent).startsWith("deskshell-autonomy-")) throw new Error("Requires a uniquely isolated temporary fixture");
}
if (process.argv[2] === "--child") {
  const [mode, file, state, requestJson] = process.argv.slice(3); guardedTemp(file);
  if (mode === "lock") {
    try { const h = createAutonomyHost({ dataDir: state, adapter: adapterFor(file), backend }); h.close(); process.exit(2); }
    catch (error) { process.exit(hasCode("HOST_IN_USE")(error) ? 0 : 3); }
  }
  const adapter = adapterFor(file);
  const execute = adapter.execute;
  adapter.execute = (input) => {
    if (mode === "before") process.exit(71);
    execute(input); process.exit(72);
  };
  const host = createAutonomyHost({ dataDir: state, adapter, backend });
  await host.sessions.run(JSON.parse(requestJson));
  host.close(); throw new Error("The requested fault was not reached");
}

const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-autonomy-")); let passed = 0;
function fixture() {
  const root = fs.mkdtempSync(path.join(parent, "case-")); const file = path.join(root, "counter.txt"); fs.writeFileSync(file, "0");
  return { file, state: path.join(root, "state"), root };
}
async function test(name: string, action: () => Promise<void>) { await action(); passed++; console.log(`PASS ${name}`); }
function child(mode: string, f: ReturnType<typeof fixture>, input?: AutonomyRunRequest) {
  return spawnSync(process.execPath, [import.meta.filename, "--child", mode, f.file, f.state, JSON.stringify(input ?? {})], { windowsHide: true, timeout: 20_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  await test("multiple rounds use local goal verification and retain before/after evidence without leaking local bindings", async () => {
    const f = fixture(); const requests: ProposalRequest[] = [];
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend: { propose: async (request) => { requests.push(request); return result(); } } });
    try {
      const input = authorized(host, envelopeFor(f.file)); const done = await host.sessions.run(input);
      assert.equal(done.status, "succeeded"); assert.equal(done.rounds.length, 2); assert.equal(done.goal?.satisfied, true);
      assert.equal((done.rounds[0].observation?.state as { counter: number }).counter, 0);
      assert.equal((done.rounds[0].afterObservation?.state as { counter: number }).counter, 1);
      assert.equal(done.events.filter((event) => event.type === "effect_intent").length, 2);
      assert.equal(new Set(done.rounds.map((round) => round.operationId)).size, 2);
      const sent = JSON.stringify(requests.map(({ signal: _, ...request }) => request));
      for (const privateValue of [f.file, "LOCAL_ONLY_SENTINEL", "EVIDENCE_ONLY_SENTINEL", "RESOURCE_ONLY_SENTINEL", "CRITERIA_ONLY_SENTINEL"]) assert.equal(sent.includes(privateValue), false);
      assert.deepEqual(JSON.parse(requests[1].intent).previousStepFeedback, { counterChanged: true });
      assert.deepEqual(await host.sessions.run(input), done); assert.equal(requests.length, 2);
    } finally { host.close(); }
  });

  await test("an already achieved local goal stops before creating a backend or proposing", async () => {
    const f = fixture(); fs.writeFileSync(f.file, "2"); let calls = 0;
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backendFactory: async () => { calls++; return backend; } });
    try { const done = await host.sessions.run(authorized(host, envelopeFor(f.file))); assert.equal(done.status, "succeeded"); assert.equal(calls, 0); assert.equal(done.hasEffects, false); }
    finally { host.close(); }
  });

  await test("exact trusted approval is required and returned envelope mutations cannot widen scope", async () => {
    const f = fixture(); let calls = 0;
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend: { propose: async () => { calls++; return result(); } } });
    try {
      const prepared = host.sessions.prepare(envelopeFor(f.file)); const digest = prepared.digest;
      prepared.envelope.allowedOutputs.push("outside"); prepared.envelope.goal.criteria = { target: 0 };
      assert.equal("approve" in host.sessions, false);
      assert.throws(() => host.approvals.approve(prepared.sessionId, "wrong"), hasCode("DIGEST_MISMATCH"));
      await assert.rejects(host.sessions.run({ sessionId: prepared.sessionId, digest, approvalReceiptId: "forged" }), hasCode("APPROVAL_REQUIRED"));
      const input = { sessionId: prepared.sessionId, digest, approvalReceiptId: host.approvals.approve(prepared.sessionId, digest).approvalId };
      await assert.rejects(host.sessions.run({ ...input, digest: "wrong" }), hasCode("DIGEST_MISMATCH")); assert.equal(calls, 0);
      const done = await host.sessions.run(input); assert.equal(done.status, "succeeded"); assert.equal(fs.readFileSync(f.file, "utf8"), "2");
      assert.deepEqual(done.prepared.envelope.allowedOutputs, ["counter"]);
    } finally { host.close(); }
  });

  await test("unknown tools, versions, arguments and independent capability/resource/output escapes never execute", async () => {
    for (const kind of ["unknown", "version", "args", "capability", "resource", "output", "write-no-output", "read-output"]) {
      const f = fixture(); let effects = 0; const adapter = adapterFor(f.file); const validate = adapter.validate;
      adapter.validate = async (input) => {
        const action = await validate(input);
        if (kind === "capability") action.capabilities = ["shell.execute"];
        if (kind === "resource") action.resourceIds = ["outside"];
        if (kind === "output") action.outputIds = ["outside"];
        if (kind === "write-no-output") action.outputIds = [];
        if (kind === "read-output") action.effect = "read";
        return action;
      };
      adapter.execute = () => { effects++; throw new Error("Must not execute rejected action"); };
      const value = proposal(); if (kind === "unknown") value.skillId = "shell"; if (kind === "version") value.version = "99"; if (kind === "args") value.args.root = "outside";
      const host = createAutonomyHost({ dataDir: f.state, adapter, backend: { propose: async () => result(value) } });
      try { const done = await host.sessions.run(authorized(host, envelopeFor(f.file, { maxRounds: 1 }))); assert.equal(done.status, "exhausted", kind); assert.equal(done.rounds[0].status, "rejected", kind); assert.equal(effects, 0); assert.equal(fs.readFileSync(f.file, "utf8"), "0"); }
      finally { host.close(); }
    }
  });

  await test("rejected proposal feedback can produce a later valid step without changing trusted goal", async () => {
    const f = fixture(); const requests: ProposalRequest[] = []; let count = 0;
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend: { propose: async (request) => { requests.push(request); const value = proposal(); if (++count === 1) value.skillId = "unknown"; return result(value); } } });
    try { const done = await host.sessions.run(authorized(host, envelopeFor(f.file))); assert.equal(done.status, "succeeded"); assert.equal(done.rounds.length, 3); assert.equal(JSON.parse(requests[1].intent).previousStepFeedback.code, "INVALID_PROPOSAL"); }
    finally { host.close(); }
  });

  await test("round exhaustion persists and repeated run cannot restart effects", async () => {
    const f = fixture(); let host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend });
    const input = authorized(host, envelopeFor(f.file, { maxRounds: 1 }));
    try {
      const stopped = await host.sessions.run(input); assert.equal(stopped.status, "exhausted"); assert.equal(stopped.error?.code, "ROUND_LIMIT"); assert.equal(stopped.hasEffects, true);
      host.close(); host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend });
      assert.deepEqual(await host.sessions.run(input), stopped); assert.equal(fs.readFileSync(f.file, "utf8"), "1");
    } finally { host.close(); }
  });

  await test("advance pauses at a verified boundary and restart resumes with original approval and remaining rounds", async () => {
    const f = fixture(); const remaining: number[] = []; const factory = async ({ remainingRounds }: { remainingRounds: number }) => { remaining.push(remainingRounds); await tick(); return backend; };
    let host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backendFactory: factory });
    const input = authorized(host, envelopeFor(f.file));
    try {
      const first = await host.sessions.advance(input); assert.equal(first.status, "paused"); assert.equal(first.rounds.length, 1);
      host.close(); host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backendFactory: factory });
      const done = await host.sessions.advance(input); assert.equal(done.status, "succeeded"); assert.equal(done.startedAt, first.startedAt); assert.equal(done.deadlineAt, first.deadlineAt); assert.deepEqual(remaining, [4, 3]); assert.equal(fs.readFileSync(f.file, "utf8"), "2");
    } finally { host.close(); }
  });

  await test("duration includes paused time and hanging backend requests are stopped without effects", async () => {
    const f = fixture(); const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend });
    try { const input = authorized(host, envelopeFor(f.file, { maxDurationMs: 150 })); const first = await host.sessions.advance(input); assert.equal(first.status, "paused"); await delay(Math.max(1, first.deadlineAt! - Date.now() + 10)); const done = await host.sessions.run(input); assert.equal(done.status, "partial"); assert.equal(done.error?.code, "DURATION_LIMIT"); assert.equal(done.rounds.length, 1); assert.equal(fs.readFileSync(f.file, "utf8"), "1"); }
    finally { host.close(); }
    const g = fixture(); const other = createAutonomyHost({ dataDir: g.state, adapter: adapterFor(g.file), backend: { propose: () => new Promise(() => {}) } });
    try { const done = await other.sessions.run(authorized(other, envelopeFor(g.file, { maxDurationMs: 30 }))); assert.equal(done.status, "exhausted"); assert.equal(done.error?.code, "DURATION_LIMIT"); assert.equal(done.hasEffects, false); }
    finally { other.close(); }
  });

  await test("pre-abort and cancellation during a late model response preserve no-effects state", async () => {
    const f = fixture(); let calls = 0; let late!: (value: ProposalResult) => void;
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend: { propose: () => { calls++; return new Promise((resolve) => { late = resolve; }); } } });
    try {
      const pre = new AbortController(); pre.abort(); assert.equal((await host.sessions.run(authorized(host, envelopeFor(f.file)), pre.signal)).status, "cancelled"); assert.equal(calls, 0);
      const input = authorized(host, envelopeFor(f.file)); const promise = host.sessions.run(input);
      while (!late) await tick(); setImmediate(() => host.sessions.cancel(input.sessionId));
      const done = await promise; assert.equal(done.status, "cancelled"); late(result()); await tick(); assert.equal(fs.readFileSync(f.file, "utf8"), "0"); assert.equal(host.sessions.inspect(input.sessionId).status, "cancelled");
    } finally { host.close(); }
  });

  await test("in-flight uncertain effect cancellation blocks new work and late completion is never replayed", async () => {
    const f = fixture(); let complete!: () => void; const adapter = adapterFor(f.file); const perform = adapter.execute;
    adapter.execute = (input) => new Promise((resolve) => { complete = () => resolve(perform(input)); });
    const host = createAutonomyHost({ dataDir: f.state, adapter, backend });
    try {
      const input = authorized(host, envelopeFor(f.file)); const running = host.sessions.run(input);
      while (!complete) await tick(); setImmediate(() => host.sessions.cancel(input.sessionId));
      const done = await running; assert.equal(done.status, "needs_attention"); assert.equal(done.error?.code, "EFFECT_OUTCOME_UNKNOWN");
      assert.throws(() => host.assertIdle(), hasCode("AUTONOMY_HOST_BUSY"));
      assert.throws(() => host.close(), hasCode("AUTONOMY_HOST_BUSY"));
      await assert.rejects(host.sessions.run(authorized(host, envelopeFor(f.file))), hasCode("AUTONOMY_HOST_BUSY"));
      complete(); await tick(); host.assertIdle(); assert.equal(fs.readFileSync(f.file, "utf8"), "1"); assert.deepEqual(await host.sessions.run(input), done);
    } finally { if (complete) { await tick(); } host.close(); }
  });

  await test("known not-applied effects can replan while unknown outcomes and exceptions stop without replay", async () => {
    for (const mode of ["not_applied", "unknown", "throw"]) {
      const f = fixture(); const adapter = adapterFor(f.file); const perform = adapter.execute; let calls = 0;
      adapter.execute = (input) => { if (++calls !== 1) return perform(input); if (mode === "throw") throw new Error("PRIVATE_ERROR_SENTINEL"); return { outcome: mode as "unknown" | "not_applied", evidence: null }; };
      const host = createAutonomyHost({ dataDir: f.state, adapter, backend });
      try { const input = authorized(host, envelopeFor(f.file)); const done = await host.sessions.run(input); assert.equal(done.status, mode === "not_applied" ? "succeeded" : "needs_attention"); assert.equal(calls, mode === "not_applied" ? 3 : 1); assert.equal(JSON.stringify(done).includes("PRIVATE_ERROR_SENTINEL"), false); await host.sessions.run(input); assert.equal(calls, mode === "not_applied" ? 3 : 1); }
      finally { host.close(); }
    }
  });

  await test("real process termination before or after an effect is quarantined on restart", async () => {
    for (const mode of ["before", "after"]) {
      const f = fixture(); let host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend });
      const input = authorized(host, envelopeFor(f.file)); host.close(); const terminated = child(mode, f, input);
      assert.equal(terminated.error, undefined); assert.equal(terminated.status, mode === "before" ? 71 : 72);
      host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend });
      try { const stopped = host.sessions.inspect(input.sessionId); assert.equal(stopped.status, "needs_attention"); assert.equal(stopped.error?.code, "INTERRUPTED"); assert.equal(stopped.rounds[0].action?.effect, "write"); assert.deepEqual(await host.sessions.run(input), stopped); assert.equal(fs.readFileSync(f.file, "utf8"), mode === "before" ? "0" : "1"); }
      finally { host.close(); }
    }
  });

  await test("file and autonomy hosts share one owner while duplicate and foreign owners are rejected", async () => {
    const f = fixture(); const fileRoot = path.join(f.root, "files"); fs.mkdirSync(fileRoot);
    const files = createTaskHost({ dataDir: f.state, allowedRoots: [fileRoot], granted: ["fs.read", "fs.write"], skills: [] }); let filesClosed = false;
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend });
    try {
      assert.throws(() => createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend }), hasCode("AUTONOMY_HOST_BUSY"));
      const first = child("lock", f); assert.equal(first.status, 0, "Live host rejects a foreign process");
      files.close(); filesClosed = true; assert.equal(child("lock", f).status, 0, "Remaining autonomy connection retains process ownership");
      assert.equal((await host.sessions.run(authorized(host, envelopeFor(f.file)))).status, "succeeded");
    } finally { host.close(); if (!filesClosed) files.close(); }
    assert.equal(child("lock", f).status, 2, "After both close another process can own state");
  });

  await test("adapter revision changes invalidate approvals and unsupported persistent formats are not adopted", async () => {
    const f = fixture(); let revision = "v1"; const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file, { revision: () => revision }), backend });
    try { const input = authorized(host, envelopeFor(f.file)); revision = "v2"; await assert.rejects(host.sessions.run(input), hasCode("STALE_SESSION")); assert.equal(fs.readFileSync(f.file, "utf8"), "0"); }
    finally { host.close(); }
    const db = new DatabaseSync(path.join(f.state, "autonomy.sqlite")); db.exec("PRAGMA user_version=999"); db.close();
    assert.throws(() => createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backend }), hasCode("UNSUPPORTED_AUTONOMY_STORE"));
    const check = new DatabaseSync(path.join(f.state, "autonomy.sqlite")); try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 999); } finally { check.close(); }
  });

  await test("injected DeepSeek transport preserves the persistent budget across separate round backends", async () => {
    const f = fixture(); const budget = new ModelBudget(path.join(f.root, "budget"), { initialLimits: { maxRequests: 1, maxEstimatedCostUsd: 0.10 } }); let requests = 0;
    const fakeFetch = async () => { requests++; return new Response(JSON.stringify({ id: "synthetic-budget", model: "deepseek-flash", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "synthetic-call", type: "function", function: { name: "propose_skill", arguments: JSON.stringify(proposal()) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), { status: 200, headers: { "content-type": "application/json" } }); };
    const host = createAutonomyHost({ dataDir: f.state, adapter: adapterFor(f.file), backendFactory: async () => new DeepSeekBackend({ apiKey: "sk-synthetic-only-0000000000000000", fetch: fakeFetch, limits: { maxRequests: 4, maxInputBytes: 8192, maxOutputTokens: 128, timeoutMs: 1000, maxEstimatedCostUsd: .01 }, budget }) });
    try { const input = authorized(host, envelopeFor(f.file)); assert.equal((await host.sessions.advance(input)).status, "paused"); const done = await host.sessions.advance(input); assert.equal(done.status, "needs_attention"); assert.equal(done.error?.code, "DAILY_BUDGET_EXCEEDED"); assert.equal(requests, 1); assert.equal(fs.readFileSync(f.file, "utf8"), "1"); assert.equal(budget.snapshot().usedRequests, 1); }
    finally { host.close(); budget.close(); }
  });

  await test("only known diagnostic classes and codes survive while all original secret messages are discarded", async () => {
    const secret = "sk-synthetic-private-error-message-never-persist";
    const cases: Array<{ error: Error; expected: string; observe?: boolean }> = [
      { error: new ModelError("DAILY_BUDGET_EXCEEDED", secret), expected: "DAILY_BUDGET_EXCEEDED" },
      { error: new ModelError("AUTH_FAILED", secret), expected: "AUTH_FAILED" },
      { error: new BudgetError("DAILY_BUDGET_EXCEEDED", secret), expected: "DAILY_BUDGET_EXCEEDED" },
      { error: new NotepadTaskError("BUFFER_CHANGED", secret), expected: "BUFFER_CHANGED", observe: true },
      { error: new NotepadTaskError("GUARD_INPUT_CHANGED", secret), expected: "GUARD_INPUT_CHANGED", observe: true },
      { error: new NotepadTaskError("GUARD_INPUT_ACTIVITY_DETECTED", secret), expected: "GUARD_INPUT_ACTIVITY_DETECTED", observe: true },
      { error: new NotepadTaskError("GUARD_UNAVAILABLE", secret), expected: "GUARD_UNAVAILABLE", observe: true },
      { error: new NotepadTaskError("GUARD_HEARTBEAT_LOST", secret), expected: "GUARD_HEARTBEAT_LOST", observe: true },
      { error: new NotepadTaskError("GUARD_UNRECOGNIZED_PRIVATE_CODE", secret), expected: "ADAPTER_OPERATION_FAILED", observe: true },
      { error: Object.assign(new Error(secret), { code: "DAILY_BUDGET_EXCEEDED" }), expected: "MODEL_REQUEST_FAILED" },
      { error: new AutonomyError("UNRECOGNIZED_PRIVATE_CODE", secret), expected: "MODEL_REQUEST_FAILED" },
      { error: new ModelError("UNRECOGNIZED_PRIVATE_CODE", secret), expected: "MODEL_REQUEST_FAILED" },
      { error: new TypeError(secret), expected: "ADAPTER_OPERATION_FAILED", observe: true },
    ];
    for (const scenario of cases) {
      const f = fixture(); const adapter = adapterFor(f.file); if (scenario.observe) adapter.observe = () => { throw scenario.error; };
      const host = createAutonomyHost({ dataDir: f.state, adapter, backend: { propose: async () => { throw scenario.error; } } });
      try {
        const done = await host.sessions.run(authorized(host, envelopeFor(f.file))); assert.equal(done.status, "needs_attention"); assert.equal(done.error?.code, scenario.expected);
        const stored = JSON.stringify(done); assert.equal(stored.includes(secret), false); assert.equal(stored.includes("UNRECOGNIZED_PRIVATE_CODE"), false);
      } finally { host.close(); }
    }
  });

  console.log(`Autonomy checks passed: ${passed}`);
} finally {
  const resolved = fs.realpathSync.native(parent);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("deskshell-autonomy-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
