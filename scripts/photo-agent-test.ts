/** Offline agent integration: synthetic files, injected HTTP, and CLI calls that never read credentials. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeepSeekBackend, ModelError } from "../packages/models/src/deepseek.ts";
import { PHOTO_MODEL_LIMITS, openPhotoHost, preparePhotoTask, applyPhotoPlan, photoPreview } from "../packages/agent/src/photo-agent.ts";
import { stopAgentHost } from "../packages/agent/src/host-client.ts";
import type { PhotoHost } from "../packages/agent/src/photo-agent.ts";
import { createPhotoFixture, createPhotoGoal, PHOTO_SKILL_ID, PHOTO_SKILL_VERSION, PHOTO_DEFAULT_TIMEZONE } from "../packages/runtime/src/photo-task.ts";
import { captureTree } from "../packages/runtime/src/file-plan.ts";

const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-photo-agent-"));
const repo = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repo, "apps", "agent", "cli.ts");
const fixtureKey = "sk-fixture_only_not_a_real_credential_123456";
const cliStates = new Set<string>();
const intent = "请按文件修改时间把这个目录第一层照片分到月份子目录，上海时区，其他文件保持原样。";
const proposal = () => ({ skillId: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION, args: { dateSource: "mtime", timeZone: PHOTO_DEFAULT_TIMEZONE }, goalCriteria: { alwaysSatisfied: true, expectedNodes: [] } });
const response = (candidate: unknown = proposal(), tool = "propose_skill") => new Response(JSON.stringify({
  id: "chatcmpl-photo-fixture", model: "deepseek-flash",
  choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-photo", type: "function", function: { name: tool, arguments: JSON.stringify(candidate) } }] } }],
  usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
}), { headers: { "Content-Type": "application/json" } });
const backend = (fetch: typeof globalThis.fetch = async () => response()) => new DeepSeekBackend({ apiKey: fixtureKey, fetch, limits: { ...PHOTO_MODEL_LIMITS, timeoutMs: 1000 } });
const fixture = () => createPhotoFixture(parent);
type Fixture = ReturnType<typeof fixture>;
const prepare = (f: Fixture, host: PhotoHost, model = backend(), signal?: AbortSignal) => preparePhotoTask({ host, root: f.root, stateDir: f.stateDir, intent, backend: model, ...(signal ? { signal } : {}) });
const hasCode = (code: string) => (error: unknown): boolean => !!error && typeof error === "object" && "code" in error && error.code === code;
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function counts(f: Fixture): { plans: number; approvals: number; claims: number } {
  const db = new DatabaseSync(path.join(f.stateDir, "tasks.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(["plans", "approvals", "claims"].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count)])) as ReturnType<typeof counts>;
  } finally { db.close(); }
}
function audits(f: Fixture): Record<string, unknown>[] {
  return fs.readdirSync(f.stateDir).filter((name) => /^model-request-.*\.json$/.test(name)).map((name) => JSON.parse(fs.readFileSync(path.join(f.stateDir, name), "utf8")));
}
function cli(command: string, f: Fixture, extra: string[] = [], expectedExit = 0) {
  cliStates.add(f.stateDir);
  const result = spawnSync(process.execPath, [cliPath, command, "--root", f.root, "--state", f.stateDir, ...extra], {
    cwd: repo, encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, "CLI subprocess must start and finish");
  assert.equal(result.status, expectedExit, `Unexpected ${command} exit code`);
  assert.ok(!result.stdout.includes(fixtureKey) && !result.stderr.includes(fixtureKey), "CLI output must omit credential material");
  return JSON.parse(result.stdout);
}
let passed = 0;
async function closeCliHosts(): Promise<void> {
  const states = [...cliStates];
  const results = await Promise.allSettled(states.map((state) => stopAgentHost(state)));
  results.forEach((result, index) => { if (result.status === "fulfilled") cliStates.delete(states[index]); });
  if (results.some((result) => result.status === "rejected")) throw new Error("CLI_HOST_CLEANUP_FAILED");
}
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  finally { await closeCliHosts(); }
}

try {
  await test("natural-language proposal sends only entered intent/schema and ignores model goal weakening", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir);
    try {
      const before = captureTree(f.root); const trustedGoal = createPhotoGoal(f.root); let calls = 0;
      const model = backend(async (_url, init) => {
        calls++;
        const body = JSON.parse(init!.body as string);
        const supplied = JSON.parse(body.messages[1].content);
        assert.deepEqual(Object.keys(supplied).sort(), ["intent", "skills"]);
        assert.equal(supplied.intent, intent); assert.equal(supplied.skills.length, 1);
        const encoded = JSON.stringify(body);
        for (const privateText of [f.root, f.stateDir, "august.JPG", "notes.txt", ...before.nodes.filter((node) => node.hash).map((node) => node.hash!)]) {
          assert.ok(!encoded.includes(privateText) && !encoded.includes(JSON.stringify(privateText).slice(1, -1)), "Locally observed file details must not enter model context");
        }
        return response();
      });
      const { plan, model: record } = await prepare(f, host, model);
      assert.equal(calls, 1); assert.equal(record.usage?.totalTokens, 180);
      assert.deepEqual(plan.goal.criteria, trustedGoal); assert.notDeepEqual(plan.goal.criteria, proposal().goalCriteria);
      assert.equal(host.tasks.get(plan.taskId).status, "awaiting_approval");
      assert.deepEqual(counts(f), { plans: 1, approvals: 0, claims: 0 });
      assert.equal(captureTree(f.root).digest, before.digest);
      assert.equal(photoPreview(plan).approvalPolicy, "Explicit apply command with this exact digest");
      const audit = audits(f); assert.equal(audit.length, 1); assert.equal(audit[0].status, "prepared");
      assert.equal(audit[0].planId, plan.planId); assert.ok(!JSON.stringify(audit).includes(fixtureKey));
    } finally { host.close(); }
  });

  await test("CLI inspect, exact approval, independent verification and repeat apply survive process boundaries", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir);
    let plan;
    try { plan = (await prepare(f, host)).plan; } finally { host.close(); }
    const before = captureTree(f.root);
    const view = cli("inspect", f, ["--plan", plan.planId]);
    assert.equal(view.digest, plan.digest); assert.equal(view.task.status, "awaiting_approval");
    const denied = cli("apply", f, ["--plan", plan.planId, "--digest", "wrong"], 1);
    assert.equal(denied.code, "DIGEST_MISMATCH"); assert.equal(captureTree(f.root).digest, before.digest);
    assert.deepEqual(counts(f), { plans: 1, approvals: 0, claims: 0 });
    const result = cli("apply", f, ["--plan", plan.planId, "--digest", plan.digest]);
    assert.equal(result.status, "succeeded"); assert.equal(result.goal.satisfied, true);
    assert.equal(fs.existsSync(path.join(f.root, "august.JPG")), false);
    assert.equal(fs.readFileSync(path.join(f.root, "2026-08", "august.JPG"), "utf8"), "Synthetic photo fixture A\n");
    assert.equal(fs.readFileSync(path.join(f.root, "2026-09", "boundary.png"), "utf8"), "Synthetic photo fixture B\n");
    assert.equal(fs.readFileSync(path.join(f.root, "notes.txt"), "utf8"), "Keep this non-photo file untouched.\n");
    assert.equal(fs.readFileSync(path.join(f.root, "keep", "nested.jpg"), "utf8"), "Do not recursively sort subdirectories.\n");
    const final = captureTree(f.root);
    assert.deepEqual(cli("status", f, ["--task", plan.taskId]), result);
    assert.deepEqual(cli("apply", f, ["--plan", plan.planId, "--digest", plan.digest]), result);
    assert.equal(captureTree(f.root).digest, final.digest);
    assert.deepEqual(counts(f), { plans: 1, approvals: 1, claims: 1 });
  });

  await test("CLI cancellation is durable and prevents later approval and effects", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir); let plan;
    try { plan = (await prepare(f, host)).plan; } finally { host.close(); }
    const before = captureTree(f.root);
    assert.equal(cli("cancel", f, ["--task", plan.taskId]).status, "cancelled");
    assert.equal(cli("status", f, ["--task", plan.taskId]).status, "cancelled");
    assert.equal(cli("apply", f, ["--plan", plan.planId, "--digest", plan.digest], 130).status, "cancelled");
    assert.equal(captureTree(f.root).digest, before.digest);
    assert.deepEqual(counts(f), { plans: 1, approvals: 0, claims: 0 });
  });

  await test("CLI refuses missing cloud opt-in before opening storage or reading credentials", async () => {
    const f = { fixture: parent, root: path.join(parent, "does-not-exist"), stateDir: path.join(parent, "must-not-be-created") };
    const denied = cli("plan", f, ["--intent", intent], 1);
    assert.equal(denied.phase, "arguments"); assert.equal(denied.code, "CLOUD_OPT_IN_REQUIRED");
    assert.equal(fs.existsSync(f.stateDir), false);
  });

  await test("unknown skills/tools and root overrides cannot become executable plans", async () => {
    for (const invalid of [
      { candidate: { ...proposal(), skillId: "raw-shell" }, tool: "propose_skill" },
      { candidate: { ...proposal(), args: { ...proposal().args, root: "outside" } }, tool: "propose_skill" },
      { candidate: proposal(), tool: "execute_shell" },
    ]) {
      const f = fixture(); const host = openPhotoHost(f.root, f.stateDir);
      try {
        const before = captureTree(f.root);
        await assert.rejects(prepare(f, host, backend(async () => response(invalid.candidate, invalid.tool))), hasCode("INVALID_PROPOSAL"));
        assert.equal(captureTree(f.root).digest, before.digest); assert.equal(counts(f).plans, 0);
        assert.equal(audits(f)[0].status, "started");
      } finally { host.close(); }
    }
  });

  await test("file changes during inference invalidate the proposal before prepare", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir); const entered = gate<void>(); const resume = gate<Response>();
    try {
      const pending = prepare(f, host, backend(async () => { entered.resolve(); return resume.promise; }));
      await entered.promise;
      fs.writeFileSync(path.join(f.root, "notes.txt"), "Human edit during request");
      const changed = captureTree(f.root);
      resume.resolve(response());
      await assert.rejects(pending, hasCode("STALE_PLAN"));
      assert.equal(counts(f).plans, 0); assert.equal(captureTree(f.root).digest, changed.digest);
    } finally { resume.resolve(response()); host.close(); }
  });

  await test("pre-cancelled planning performs no request and creates no audit or plan", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir); const controller = new AbortController(); controller.abort();
    try {
      let calls = 0;
      await assert.rejects(prepare(f, host, backend(async () => { calls++; return response(); }), controller.signal), hasCode("CANCELLED"));
      assert.equal(calls, 0); assert.equal(counts(f).plans, 0); assert.deepEqual(audits(f), []);
    } finally { host.close(); }
  });

  await test("in-flight cancellation rejects a late transport response and cannot prepare a plan", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir); const entered = gate<void>(); const resume = gate<Response>(); const controller = new AbortController();
    try {
      const before = captureTree(f.root);
      const pending = prepare(f, host, backend(async () => { entered.resolve(); return resume.promise; }), controller.signal);
      await entered.promise; controller.abort();
      await assert.rejects(pending, hasCode("CANCELLED"));
      resume.resolve(response()); await pause();
      assert.equal(counts(f).plans, 0); assert.equal(captureTree(f.root).digest, before.digest);
      assert.equal(audits(f)[0].status, "started");
    } finally { resume.resolve(response()); host.close(); }
  });

  await test("coordinator rejects even a backend that returns a valid proposal after cancellation", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir); const controller = new AbortController();
    const entered = gate<void>(); const resume = gate<void>();
    try {
      const ready = await backend().propose({ intent, skills: [{
        id: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION, description: "Synthetic schema for a late-response test",
        argsSchema: { type: "object", properties: { dateSource: { type: "string", enum: ["mtime"] }, timeZone: { type: "string", enum: [PHOTO_DEFAULT_TIMEZONE] } }, required: ["dateSource", "timeZone"], additionalProperties: false },
      }] });
      const pending = preparePhotoTask({ host, root: f.root, stateDir: f.stateDir, intent, signal: controller.signal,
        backend: { async propose() { entered.resolve(); await resume.promise; return ready; } },
      });
      await entered.promise; controller.abort(); resume.resolve();
      await assert.rejects(pending, hasCode("CANCELLED")); assert.equal(counts(f).plans, 0);
    } finally { resume.resolve(); host.close(); }
  });

  await test("invalid goals, empty photo sets and destination conflicts fail before any request", async () => {
    for (const failure of ["intent", "empty", "collision"] as const) {
      const f = fixture();
      if (failure === "empty") for (const name of ["august.JPG", "boundary.png", "october.heic"]) fs.unlinkSync(path.join(f.root, name));
      if (failure === "collision") fs.writeFileSync(path.join(f.root, "2026-09", "boundary.png"), "existing destination", { flag: "wx" });
      const host = openPhotoHost(f.root, f.stateDir);
      try {
        const before = captureTree(f.root); let calls = 0;
        const model = backend(async () => { calls++; return response(); });
        await assert.rejects(preparePhotoTask({ host, root: f.root, stateDir: f.stateDir, intent: failure === "intent" ? " " : intent, backend: model }), hasCode(failure === "intent" ? "INVALID_INTENT" : failure === "empty" ? "NO_PHOTOS" : "PHOTO_DESTINATION_EXISTS"));
        assert.equal(calls, 0); assert.equal(counts(f).plans, 0); assert.deepEqual(audits(f), []);
        assert.equal(captureTree(f.root).digest, before.digest);
      } finally { host.close(); }
    }
  });

  await test("pre-cancelled apply creates no approval or claim and preserves every original file", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir);
    try {
      const { plan } = await prepare(f, host); const before = captureTree(f.root); const controller = new AbortController(); controller.abort();
      const result = await applyPhotoPlan(host, f.root, plan.planId, plan.digest, controller.signal);
      assert.equal(result.status, "cancelled"); assert.equal(captureTree(f.root).digest, before.digest);
      assert.deepEqual(counts(f), { plans: 1, approvals: 0, claims: 0 });
    } finally { host.close(); }
  });

  await test("provider errors remain sanitized and leave unknown-outcome audit without a plan", async () => {
    const f = fixture(); const host = openPhotoHost(f.root, f.stateDir);
    try {
      const before = captureTree(f.root);
      await assert.rejects(prepare(f, host, backend(async () => new Response(JSON.stringify({ message: fixtureKey }), { status: 401 }))), (error) => {
        assert.ok(error instanceof ModelError); assert.equal(error.code, "AUTH_FAILED");
        assert.ok(!String(error).includes(fixtureKey)); return true;
      });
      assert.equal(counts(f).plans, 0); assert.equal(captureTree(f.root).digest, before.digest);
      const audit = audits(f); assert.equal(audit[0].status, "started"); assert.equal(audit[0].usage, undefined);
      assert.ok(!JSON.stringify(audit).includes(fixtureKey));
    } finally { host.close(); }
  });

  console.log(`Photo agent checks passed: ${passed}`);
} finally {
  await closeCliHosts();
  const resolved = path.resolve(parent); const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("deskshell-photo-agent-")) throw new Error("Unsafe test cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
}
