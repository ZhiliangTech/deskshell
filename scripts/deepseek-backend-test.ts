/** Offline contract tests: injected transports only, no credentials or network access. */
import assert from "node:assert/strict";
import { DeepSeekBackend, ModelError } from "../packages/models/src/deepseek.ts";
import type { ModelLimits, ProposalRequest, SimpleSchema } from "../packages/models/src/deepseek.ts";

const fixtureKey = "sk-fixture_only_not_a_real_credential_123456";
const limits: ModelLimits = { maxRequests: 1, maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 1000, maxEstimatedCostUsd: 0.01 };
const request: ProposalRequest = {
  intent: "Create the synthetic hello fixture",
  skills: [{ id: "write-note", version: "1", description: "Propose a synthetic fixture note", argsSchema: {
    type: "object", properties: { text: { type: "string", enum: ["hello"], maxLength: 20 } }, required: ["text"], additionalProperties: false,
  } }],
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const proposal = () => ({ skillId: "write-note", version: "1", args: { text: "hello" }, goalCriteria: { text: "hello" } });
const valid = () => ({
  id: "chatcmpl-fixture", model: "deepseek-flash",
  choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "propose_skill", arguments: JSON.stringify(proposal()) } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
});
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const backend = (transport: typeof fetch, overrides: Partial<ModelLimits> = {}) => new DeepSeekBackend({ apiKey: fixtureKey, fetch: transport, limits: { ...limits, ...overrides } });
const from = (value: unknown, overrides: Partial<ModelLimits> = {}) => backend(async () => response(value), overrides);
async function rejects(action: () => unknown, code: string): Promise<void> {
  try { await action(); assert.fail(`Expected ${code}`); } catch (error) {
    assert.ok(error instanceof ModelError, "Errors must use the sanitized adapter error type");
    assert.equal(error.code, code);
    assert.ok(!String(error).includes(fixtureKey), "Error text must omit credential material");
    assert.ok(!JSON.stringify(error).includes(fixtureKey), "Error metadata must omit credential material");
  }
}
let passed = 0;
async function test(name: string, run: () => unknown): Promise<void> { await run(); passed++; console.log(`PASS ${name}`); }

await test("locked official endpoint, bearer header, explicit nonthinking and proposal only", async () => {
  let calls = 0;
  const model = backend(async (url, init) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.ok(headers.get("authorization") === `Bearer ${fixtureKey}`, "Bearer credential is attached exactly once");
    assert.equal(headers.get("content-type"), "application/json");
    assert.ok(typeof init?.body === "string" && !init.body.includes(fixtureKey), "Credential must be absent from model context");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, "deepseek-flash"); assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ["propose_skill"]);
    assert.equal(body.tools[0].function.parameters.additionalProperties, false);
    return response(valid());
  });
  const result = await model.propose(request);
  assert.deepEqual(result.proposal, proposal());
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 30, totalTokens: 130 });
  assert.equal(result.requestId, "chatcmpl-fixture"); assert.equal(calls, 1);
  assert.equal(result.budget.requests, 1); assert.ok(result.estimatedCostUsd > 0 && result.estimatedCostUsd <= 0.01);
  assert.ok(!JSON.stringify(model).includes(fixtureKey), "Adapter serialization must omit its credential");
  assert.deepEqual(Object.keys(result).sort(), ["budget", "estimatedCostUsd", "model", "proposal", "requestId", "usage"]);
});

await test("401, 403, 429 and 503 omit untrusted bodies and never retry", async () => {
  for (const [status, code] of [[401, "AUTH_FAILED"], [403, "AUTH_FAILED"], [429, "RATE_LIMITED"], [503, "SERVICE_UNAVAILABLE"]] as const) {
    let calls = 0;
    const model = backend(async () => { calls++; return response({ secret: fixtureKey, message: "untrusted server detail" }, status); });
    await rejects(() => model.propose(request), code); assert.equal(calls, 1); assert.equal(model.getBudget().requests, 1);
  }
});

await test("transport exceptions are sanitized", async () => {
  await rejects(() => backend(async () => { throw new Error(fixtureKey); }).propose(request), "TRANSPORT_ERROR");
  await rejects(() => backend(() => { throw new Error(fixtureKey); }).propose(request), "TRANSPORT_ERROR");
});

await test("unknown tool and multiple tool calls are rejected", async () => {
  const wrong = valid(); wrong.choices[0].message.tool_calls[0].function.name = "raw_shell";
  await rejects(() => from(wrong).propose(request), "INVALID_PROPOSAL");
  const multiple = valid(); multiple.choices[0].message.tool_calls.push(clone(multiple.choices[0].message.tool_calls[0]));
  await rejects(() => from(multiple).propose(request), "INVALID_PROPOSAL");
});

await test("skill identity, version, types, enums, required and extra fields are enforced", async () => {
  const invalid: unknown[] = [
    { ...proposal(), skillId: "shell" }, { ...proposal(), version: "2" },
    { ...proposal(), args: { text: 1 } }, { ...proposal(), args: { text: "other" } },
    { ...proposal(), args: {} }, { ...proposal(), args: { text: "hello", command: "dangerous" } },
    { ...proposal(), execute: true }, { ...proposal(), goalCriteria: [] },
  ];
  for (const candidate of invalid) {
    const body = valid(); body.choices[0].message.tool_calls[0].function.arguments = JSON.stringify(candidate);
    await rejects(() => from(body).propose(request), "INVALID_PROPOSAL");
  }
});

await test("truncated, no-tool, malformed and extra-choice responses fail closed", async () => {
  const truncated = valid(); truncated.choices[0].finish_reason = "length";
  await rejects(() => from(truncated).propose(request), "OUTPUT_TRUNCATED");
  const empty = valid(); empty.choices[0].message.tool_calls = [];
  await rejects(() => from(empty).propose(request), "NO_PROPOSAL");
  const multiple = valid(); multiple.choices.push(clone(multiple.choices[0]));
  await rejects(() => from(multiple).propose(request), "INVALID_RESPONSE");
  const badArgs = valid(); badArgs.choices[0].message.tool_calls[0].function.arguments = "{unfinished";
  await rejects(() => from(badArgs).propose(request), "INVALID_PROPOSAL");
  for (const content of ["", "<html>failure</html>", "{unfinished", fixtureKey]) {
    await rejects(() => backend(async () => new Response(content)).propose(request), "INVALID_RESPONSE");
  }
  await rejects(() => from({}).propose(request), "INVALID_RESPONSE");
});

await test("invalid, non-Flash and secret-bearing configuration is rejected before transport", async () => {
  await rejects(() => new DeepSeekBackend({ apiKey: "", limits }), "INVALID_CONFIG");
  await rejects(() => new DeepSeekBackend({ apiKey: fixtureKey, model: "unknown" as "deepseek-flash", limits }), "INVALID_CONFIG");
  let calls = 0;
  const model = backend(async () => { calls++; return response(valid()); });
  await rejects(() => model.propose({ ...request, intent: fixtureKey }), "CREDENTIAL_IN_PAYLOAD");
  assert.equal(calls, 0); assert.equal(model.getBudget().requests, 0);
});

await test("unsupported schema keywords fail before sending", async () => {
  const invalid = clone(request);
  (invalid.skills[0].argsSchema as SimpleSchema & { pattern: string }).pattern = ".*";
  let calls = 0;
  await rejects(() => backend(async () => { calls++; return response(valid()); }).propose(invalid), "INVALID_SCHEMA");
  assert.equal(calls, 0);
});

await test("input and estimated cost limits reject before reserving or sending", async () => {
  for (const [overrides, code] of [[{ maxInputBytes: 10 }, "INPUT_LIMIT"], [{ maxEstimatedCostUsd: 0.00000001 }, "BUDGET_EXCEEDED"]] as const) {
    let calls = 0;
    const model = backend(async () => { calls++; return response(valid()); }, overrides);
    await rejects(() => model.propose(request), code); assert.equal(calls, 0); assert.deepEqual(model.getBudget(), { requests: 0, reservedCostUsd: 0 });
  }
});

await test("concurrent calls reserve synchronously and cannot exceed one request", async () => {
  let calls = 0; let finish!: (value: Response) => void;
  const model = backend(async () => { calls++; return new Promise<Response>((resolve) => { finish = resolve; }); });
  const first = model.propose(request);
  await rejects(() => model.propose(request), "BUDGET_EXCEEDED");
  assert.equal(calls, 1); assert.equal(model.getBudget().requests, 1);
  finish(response(valid())); await first;
});

await test("missing usage retains conservative reservation and oversized usage fails", async () => {
  const missing = valid() as ReturnType<typeof valid> & { usage?: ReturnType<typeof valid>["usage"] };
  Reflect.deleteProperty(missing, "usage");
  const result = await from(missing).propose(request);
  assert.equal(result.usage, null); assert.ok(result.estimatedCostUsd > 0); assert.equal(result.estimatedCostUsd, result.budget.reservedCostUsd);
  const bad = valid(); bad.usage.prompt_tokens = -1;
  await rejects(() => from(bad).propose(request), "INVALID_RESPONSE");
  const large = valid(); large.usage.completion_tokens = 257; large.usage.total_tokens = 357;
  await rejects(() => from(large).propose(request), "OUTPUT_LIMIT");
  const costly = valid(); costly.usage.prompt_tokens = 1_000_000; costly.usage.total_tokens = 1_000_030;
  const model = from(costly); await rejects(() => model.propose(request), "BUDGET_EXCEEDED");
  assert.ok(model.getBudget().reservedCostUsd > limits.maxEstimatedCostUsd);
});

await test("pre-cancellation consumes no request and in-flight cancellation is bounded", async () => {
  const pre = new AbortController(); pre.abort();
  const model = from(valid()); await rejects(() => model.propose({ ...request, signal: pre.signal }), "CANCELLED");
  assert.equal(model.getBudget().requests, 0);
  const current = new AbortController(); let captured: AbortSignal | null | undefined;
  const pending = backend(async (_url, init) => { captured = init?.signal; return new Promise<Response>(() => undefined); });
  const result = pending.propose({ ...request, signal: current.signal });
  current.abort(); await rejects(() => result, "CANCELLED"); assert.ok(captured?.aborted); assert.equal(pending.getBudget().requests, 1);
});

await test("timeout covers a transport ignoring abort and late responses are cancelled", async () => {
  let finish!: (value: Response) => void;
  const model = backend(async () => new Promise<Response>((resolve) => { finish = resolve; }), { timeoutMs: 15 });
  await rejects(() => model.propose(request), "TIMEOUT");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  finish(new Response(stream));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true); assert.equal(model.getBudget().requests, 1);
});

await test("timeout and user cancellation cover the response body, not only headers", async () => {
  for (const mode of ["timeout", "cancel"] as const) {
    let cancelled = false; const external = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); }, cancel() { cancelled = true; } });
    const model = backend(async () => new Response(stream), { timeoutMs: mode === "timeout" ? 15 : 1000 });
    const result = model.propose({ ...request, signal: external.signal });
    if (mode === "cancel") setTimeout(() => external.abort(), 5);
    await rejects(() => result, mode === "timeout" ? "TIMEOUT" : "CANCELLED");
    assert.equal(cancelled, true);
  }
});

await test("actual streamed bytes are bounded despite a false Content-Length", async () => {
  const oversized = new Uint8Array(80_000);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(oversized); controller.close(); } });
  await rejects(() => backend(async () => new Response(stream, { headers: { "Content-Length": "1" } })).propose(request), "RESPONSE_LIMIT");
  await rejects(() => backend(async () => new Response("{}", { headers: { "Content-Length": "99999999" } })).propose(request), "RESPONSE_LIMIT");
});

await test("wrong response origin and response credential echoes are rejected", async () => {
  const foreign = response(valid()); Object.defineProperty(foreign, "url", { value: "https://untrusted.example/chat/completions" });
  await rejects(() => backend(async () => foreign).propose(request), "INVALID_RESPONSE");
  await rejects(() => from({ ...valid(), secret: fixtureKey }).propose(request), "INVALID_RESPONSE");
});

await test("supported nested schema bounds are validated locally", async () => {
  const nested = clone(request);
  nested.skills[0].argsSchema = { type: "object", properties: {
    values: { type: "array", items: { type: "integer", minimum: 1, maximum: 3 }, minItems: 1, maxItems: 2 },
    enabled: { type: "boolean" }, optional: { type: "null" },
  }, required: ["values", "enabled"], additionalProperties: false };
  const body = valid();
  body.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ ...proposal(), args: { values: [1, 3], enabled: true, optional: null } });
  await from(body).propose(nested);
  for (const args of [{ values: [1, 4], enabled: true }, { values: [], enabled: true }, { values: [1.5], enabled: true }, { values: [1], enabled: "true" }]) {
    body.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ ...proposal(), args });
    await rejects(() => from(body).propose(nested), "INVALID_PROPOSAL");
  }
});

console.log(`DeepSeek offline checks passed: ${passed}`);
