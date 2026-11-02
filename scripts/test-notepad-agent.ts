/** Offline integration: fake HTTP + synthetic driver, no real credentials or UI. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNotepadFixture, createNotepadTaskHost } from "../packages/runtime/src/notepad-task.ts";
import { createNotepadAutonomyAdapter, notepadEnvelope } from "../packages/agent/src/notepad-agent.ts";
import { createAutonomyHost } from "../packages/agent/src/autonomy.ts";
import type { AutonomyEnvelope, AutonomyRunRequest } from "../packages/agent/src/autonomy.ts";
import { DeepSeekBackend } from "../packages/models/src/deepseek.ts";
import { ModelBudget } from "../packages/models/src/budget.ts";
import { FixtureNotepadDriver, fixtureNotepadText } from "./lib/notepad-fixture.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-notepad-agent-")); let passed = 0;
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function test(name: string, action: () => Promise<void>) { await action(); passed++; console.log(`PASS ${name}`); }
function response(step: string) {
  return new Response(JSON.stringify({ id: "synthetic-notepad-response", model: "deepseek-flash", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "synthetic-call", type: "function", function: { name: "propose_skill", arguments: JSON.stringify({ skillId: "notepad-next-step", version: "1", args: { step }, goalCriteria: { satisfied: true, sourceUnchanged: false, mayOverwrite: true } }) } }] } }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } }), { status: 200, headers: { "content-type": "application/json" } });
}
async function setup(options: { budget?: ModelBudget; choose?: (next: string, count: number) => string; beforeResponse?: (count: number) => Promise<void>; large?: boolean } = {}) {
  const fixture = createNotepadFixture(temporary); const driver = new FixtureNotepadDriver();
  let expectedText = fixture.expectedText;
  if (options.large) { const original = `PRIVATE_LARGE_BODY_SENTINEL\r\n${"x".repeat(192 * 1024)}\r\n`; fs.writeFileSync(fixture.sourcePath, original); expectedText = `${original}approved addition\r\n`; }
  const taskHost = createNotepadTaskHost({ dataDir: fixture.stateDir, allowedRoots: [fixture.root], driver, stepTimeoutMs: 2000 });
  const plan = await taskHost.tasks.prepare({ sourcePath: fixture.sourcePath, copyPath: fixture.copyPath, desired: { expectedText } });
  const bodies: string[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = String(init?.body); bodies.push(body);
    const request = JSON.parse(JSON.parse(body).messages[1].content);
    const observation = JSON.parse(request.intent).observation;
    const next = observation.nextStep;
    await options.beforeResponse?.(bodies.length);
    return response(options.choose?.(next, bodies.length) ?? next);
  };
  const autonomy = createAutonomyHost({ dataDir: path.join(fixture.fixture, "autonomy-state"), adapter: createNotepadAutonomyAdapter(taskHost, fixture.root),
    backendFactory: async ({ remainingRounds }) => new DeepSeekBackend({ apiKey: "sk-synthetic-notepad-0000000000000000", fetch,
      limits: { maxRequests: remainingRounds, maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 1000, maxEstimatedCostUsd: .05 }, ...(options.budget ? { budget: options.budget } : {}) }) });
  const envelope = notepadEnvelope(plan, "Apply the approved change and verify the saved copy");
  const approve = (value: AutonomyEnvelope = envelope): AutonomyRunRequest => {
    const prepared = autonomy.sessions.prepare(value); return { sessionId: prepared.sessionId, digest: prepared.digest, approvalReceiptId: autonomy.approvals.approve(prepared.sessionId, prepared.digest).approvalId };
  };
  return { ...fixture, expectedText, driver, plan, taskHost, autonomy, bodies, envelope, approve,
    close: () => { autonomy.close(); taskHost.close(); } };
}

try {
  await test("approved open, edit, save-copy complete in three separately observed model rounds", async () => {
    const f = await setup();
    try {
      const original = fs.readFileSync(f.sourcePath); const input = f.approve(); const done = await f.autonomy.sessions.run(input);
      assert.equal(done.status, "succeeded"); assert.equal(done.goal?.satisfied, true); assert.equal(done.rounds.length, 3); assert.equal(f.bodies.length, 3);
      assert.deepEqual(done.rounds.map((round) => round.proposal?.args.step), ["open", "edit", "save-copy"]);
      assert.deepEqual(f.driver.calls.filter((call) => call !== "observe"), ["open", "edit", "save-copy"]);
      assert.equal(fixtureNotepadText(f.copyPath), f.expectedText); assert.deepEqual(fs.readFileSync(f.sourcePath), original);
      assert.equal(f.taskHost.tasks.get(f.plan.taskId).goal?.sourceUnchanged, true);
      const calls = f.driver.calls.length; assert.deepEqual(await f.autonomy.sessions.run(input), done); assert.equal(f.driver.calls.length, calls); assert.equal(f.bodies.length, 3);
    } finally { f.close(); }
  });

  await test("a wrong next step receives bounded feedback and replans without skipping application stages", async () => {
    const f = await setup({ choose: (next, count) => count === 1 ? "save-copy" : next });
    try {
      const done = await f.autonomy.sessions.run(f.approve()); assert.equal(done.status, "succeeded"); assert.equal(done.rounds.length, 4);
      assert.equal(done.rounds[0].status, "rejected"); assert.equal(done.rounds[0].errorCode, "VALIDATION_REJECTED");
      const second = JSON.parse(JSON.parse(f.bodies[1]).messages[1].content);
      assert.equal(JSON.parse(second.intent).previousStepFeedback.code, "VALIDATION_REJECTED");
      assert.deepEqual(f.driver.calls.filter((call) => call !== "observe"), ["open", "edit", "save-copy"]);
    } finally { f.close(); }
  });

  await test("cloud payload contains only explicit intent and stage feedback, never local document data or bindings", async () => {
    const f = await setup();
    try {
      assert.equal((await f.autonomy.sessions.run(f.approve())).status, "succeeded"); const sent = f.bodies.join("\n");
      for (const privateValue of [f.sourcePath, f.copyPath, f.marker, f.sourceText, f.expectedText, path.basename(f.sourcePath), path.basename(f.copyPath), f.plan.source.hash, f.plan.expectedHash, f.plan.planId, f.plan.taskId, f.driver.sessionId, "PRIVATE_WINDOW_TITLE_SENTINEL"]) assert.equal(sent.includes(privateValue), false);
      for (const body of f.bodies) {
        const modelRequest = JSON.parse(JSON.parse(body).messages[1].content); assert.deepEqual(Object.keys(modelRequest).sort(), ["intent", "skills"]);
        const context = JSON.parse(modelRequest.intent); assert.deepEqual(Object.keys(context.observation).sort(), ["goalSatisfied", "nextStep", "stage", "status", "task"]);
      }
    } finally { f.close(); }
  });

  await test("changing resources, local goal criteria, or delegated grants is rejected before API or application access", async () => {
    for (const part of ["copy", "source", "plan", "criteria", "capabilities", "outputs", "duration"]) {
      const f = await setup();
      try {
        const envelope = clone(f.envelope);
        if (part === "copy") envelope.resources.copy = { path: path.join(f.root, "unauthorized.txt"), hash: f.plan.expectedHash };
        if (part === "source") envelope.resources.source = { path: f.copyPath, hash: f.plan.source.hash };
        if (part === "plan") (envelope.resources.plan as { digest: string }).digest = "wrong";
        if (part === "criteria") envelope.goal.criteria = { satisfied: true };
        if (part === "capabilities") envelope.allowedCapabilities.push("shell.execute");
        if (part === "outputs") envelope.allowedOutputs.push("source");
        if (part === "duration") envelope.maxDurationMs = 400_000;
        const done = await f.autonomy.sessions.run(f.approve(envelope)); assert.equal(done.status, "needs_attention", part); assert.equal(f.bodies.length, 0, part); assert.deepEqual(f.driver.calls, [], part); assert.equal(fs.existsSync(f.copyPath), false, part);
      } finally { f.close(); }
    }
  });

  await test("forged, mismatched and copied approval receipts cannot start a different session", async () => {
    const f = await setup();
    try {
      const input = f.approve(); const second = f.approve();
      await assert.rejects(f.autonomy.sessions.run({ ...input, digest: "wrong" }), hasCode("DIGEST_MISMATCH"));
      await assert.rejects(f.autonomy.sessions.run({ ...input, approvalReceiptId: "forged" }), hasCode("APPROVAL_REQUIRED"));
      await assert.rejects(f.autonomy.sessions.run({ ...second, approvalReceiptId: input.approvalReceiptId }), hasCode("APPROVAL_REQUIRED"));
      assert.equal(f.bodies.length, 0); assert.deepEqual(f.driver.calls, []); assert.equal(f.taskHost.tasks.get(f.plan.taskId).status, "awaiting_approval");
      assert.equal((await f.autonomy.sessions.run(input)).status, "succeeded");
    } finally { f.close(); }
  });

  await test("manual editor changes between rounds stop before further proposals and preserve the human buffer", async () => {
    const f = await setup();
    try {
      const input = f.approve(); assert.equal((await f.autonomy.sessions.advance(input)).status, "paused");
      f.driver.state!.text = "Human buffer edit must be preserved\r\n"; f.driver.state!.modified = true;
      const done = await f.autonomy.sessions.run(input); assert.equal(done.status, "needs_attention"); assert.equal(done.error?.code, "BUFFER_CHANGED"); assert.equal(f.bodies.length, 1); assert.equal(f.driver.state!.text, "Human buffer edit must be preserved\r\n");
      assert.deepEqual(f.driver.calls.filter((call) => call !== "observe"), ["open"]); assert.equal(fs.existsSync(f.copyPath), false); assert.equal(fixtureNotepadText(f.sourcePath), f.sourceText);
    } finally { f.close(); }
  });

  await test("pre-abort and cancellation of a late cloud reply create no application effect", async () => {
    const gate = deferred<void>(); let entered = false;
    const f = await setup({ beforeResponse: async () => { entered = true; await gate.promise; } });
    try {
      const cancelled = new AbortController(); cancelled.abort(); assert.equal((await f.autonomy.sessions.run(f.approve(), cancelled.signal)).status, "cancelled"); assert.equal(f.bodies.length, 0);
      const input = f.approve(); const running = f.autonomy.sessions.run(input); while (!entered) await tick();
      setImmediate(() => f.autonomy.sessions.cancel(input.sessionId)); const done = await running;
      assert.equal(done.status, "cancelled"); assert.equal(done.rounds[0].requestStatus, "unknown"); gate.resolve(); await tick(); await tick();
      assert.deepEqual(f.driver.calls, []); assert.equal(fs.existsSync(f.copyPath), false); assert.equal(f.autonomy.sessions.inspect(input.sessionId).status, "cancelled");
    } finally { gate.resolve(); await tick(); f.close(); }
  });

  await test("cancellation during edit preserves previous state, prevents save, and stops the underlying task", async () => {
    const f = await setup(); const gate = deferred<void>(); let entered = false;
    f.driver.beforeEdit = async () => { entered = true; await gate.promise; };
    try {
      const input = f.approve(); const running = f.autonomy.sessions.run(input); while (!entered) await tick();
      setImmediate(() => f.autonomy.sessions.cancel(input.sessionId)); const done = await running;
      assert.equal(done.status, "needs_attention"); assert.equal(done.error?.code, "EFFECT_OUTCOME_UNKNOWN"); gate.resolve(); await tick(); await tick();
      assert.equal(f.taskHost.tasks.get(f.plan.taskId).status, "needs_attention"); assert.equal(f.driver.state?.text, f.sourceText); assert.equal(fs.existsSync(f.copyPath), false); assert.equal(f.driver.calls.includes("save-copy"), false);
      assert.deepEqual(await f.autonomy.sessions.run(input), done);
    } finally { gate.resolve(); await tick(); await tick(); f.close(); }
  });

  await test("a shared persistent request budget stops later rounds and new sessions without an extra HTTP request", async () => {
    const budget = new ModelBudget(path.join(temporary, "shared-budget"), { initialLimits: { maxRequests: 2, maxEstimatedCostUsd: .10 } });
    const f = await setup({ budget }); let other: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      const done = await f.autonomy.sessions.run(f.approve()); assert.equal(done.status, "needs_attention"); assert.equal(done.error?.code, "DAILY_BUDGET_EXCEEDED"); assert.equal(done.hasEffects, true); assert.equal(f.bodies.length, 2); assert.equal(f.driver.calls.includes("save-copy"), false); assert.equal(fs.existsSync(f.copyPath), false); assert.equal(budget.snapshot().usedRequests, 2);
      other = await setup({ budget }); assert.equal((await other.autonomy.sessions.run(other.approve())).status, "needs_attention"); assert.equal(other.bodies.length, 0); assert.deepEqual(other.driver.calls, []); assert.equal(budget.snapshot().usedRequests, 2);
    } finally { other?.close(); f.close(); budget.close(); }
  });

  await test("large approved text stays in the task journal while compact coordinator records complete the workflow", async () => {
    const f = await setup({ large: true });
    try {
      const done = await f.autonomy.sessions.run(f.approve()); assert.equal(done.status, "succeeded", JSON.stringify(done.error)); assert.equal(fixtureNotepadText(f.copyPath), f.expectedText);
      assert.ok(Buffer.byteLength(JSON.stringify(done), "utf8") < 40_000); assert.equal(JSON.stringify(done).includes("PRIVATE_LARGE_BODY_SENTINEL"), false);
      assert.equal(f.bodies.join("\n").includes("PRIVATE_LARGE_BODY_SENTINEL"), false);
    } finally { f.close(); }
  });

  await test("a fresh session checks historical success against current saved bytes rather than trusting old status", async () => {
    const f = await setup();
    try {
      assert.equal((await f.autonomy.sessions.run(f.approve())).status, "succeeded");
      const second = await f.autonomy.sessions.run(f.approve()); assert.equal(second.status, "succeeded"); assert.equal(f.bodies.length, 3);
      fs.writeFileSync(f.copyPath, "Human changed saved copy\r\n"); const changed = await f.autonomy.sessions.run(f.approve());
      assert.equal(changed.status, "needs_attention"); assert.equal(f.bodies.length, 3); assert.equal(fixtureNotepadText(f.copyPath), "Human changed saved copy\r\n");
    } finally { f.close(); }
  });

  console.log(`Notepad agent checks passed: ${passed}`);
} finally {
  const resolved = fs.realpathSync.native(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("deskshell-notepad-agent-")); fs.rmSync(resolved, { recursive: true, force: true });
}
