/** Real child CLI/daemon integration. Plans are prepared in-process with synthetic model transport. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEndpoint } from "../packages/agent/src/ipc.ts";
import { stopAgentHost } from "../packages/agent/src/host-client.ts";
import { PHOTO_MODEL_LIMITS, openPhotoHost, preparePhotoTask } from "../packages/agent/src/photo-agent.ts";
import { DeepSeekBackend } from "../packages/models/src/deepseek.ts";
import { captureTree } from "../packages/runtime/src/file-plan.ts";
import { PHOTO_DEFAULT_TIMEZONE, PHOTO_SKILL_ID, PHOTO_SKILL_VERSION } from "../packages/runtime/src/photo-task.ts";

const cliPath = path.resolve(import.meta.dirname, "../apps/agent/cli.ts");
const repository = path.resolve(import.meta.dirname, "..");
const fixtureKey = "sk-cli_test_synthetic_not_a_real_credential";
const ownedFixtures = new Set<string>();
const hostStates = new Set<string>();
let passed = 0;
function cli(command: string, args: string[] = [], exitCode = 0): any {
  // This suite must never invoke a CLI route that reads real API credentials or makes model calls.
  assert.ok(command !== "plan" || !args.includes("--cloud"));
  const stateIndex = args.indexOf("--state"); if (stateIndex >= 0) hostStates.add(args[stateIndex + 1]);
  const result = spawnSync(process.execPath, [cliPath, command, ...args], {
    cwd: repository, windowsHide: true, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, "CLI must start and finish");
  assert.equal(result.status, exitCode, `Unexpected exit status for ${command}`);
  assert.ok(!result.stdout.includes(fixtureKey) && !result.stderr.includes(fixtureKey), "CLI must not reveal credential material");
  return JSON.parse(result.stdout);
}
async function concurrentHostStart(args: string[]): Promise<{ exitCode: number | null; result: any }> {
  const stateIndex = args.indexOf("--state"); hostStates.add(args[stateIndex + 1]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "host-start", ...args], {
      cwd: repository, windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let errorOutput = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { output += value; });
    child.stderr.on("data", (value: string) => { errorOutput += value; });
    child.on("error", () => reject(new Error("CONCURRENT_CLI_START_FAILED")));
    child.on("close", (exitCode) => {
      if (output.includes(fixtureKey) || errorOutput.includes(fixtureKey)) { reject(new Error("Unexpected credential in CLI output")); return; }
      try { resolve({ exitCode, result: JSON.parse(output) }); }
      catch { reject(new Error("CONCURRENT_CLI_INVALID_OUTPUT")); }
    });
  });
}
function accessState(directory: string): string {
  if (process.platform !== "win32") { const stat = fs.statSync(directory); return `${stat.uid}:${stat.gid}:${stat.mode}`; }
  const escaped = directory.replaceAll("'", "''");
  return execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command", `$sections = [Security.AccessControl.AccessControlSections]'Access,Owner,Group'; $acl = [IO.Directory]::GetAccessControl('${escaped}', $sections); [Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))`,
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}
async function test(name: string, work: () => void | Promise<void>) { await work(); passed++; console.log(`PASS ${name}`); }
const transport: typeof fetch = async () => new Response(JSON.stringify({
  id: "chatcmpl-cli-fixture", model: "deepseek-flash", usage: { prompt_tokens: 100, completion_tokens: 70, total_tokens: 170 },
  choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
    id: "cli-fixture-proposal", type: "function", function: { name: "propose_skill", arguments: JSON.stringify({
      skillId: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION,
      args: { dateSource: "mtime", timeZone: PHOTO_DEFAULT_TIMEZONE, deduplicate: true }, goalCriteria: {},
    }) },
  }] } }],
}), { headers: { "Content-Type": "application/json" } });

let fixture: { fixture: string; root: string; stateDir: string; synthetic: boolean };
let plan: Awaited<ReturnType<typeof preparePhotoTask>>["plan"];
let initial: ReturnType<typeof captureTree>;
let firstHost: { pid: number; instanceId: string };
let budgetBefore: any;
const scoped = () => ["--root", fixture.root, "--state", fixture.stateDir];
async function prepareOffline() {
  const host = openPhotoHost(fixture.root, fixture.stateDir);
  try {
    const backend = new DeepSeekBackend({ apiKey: fixtureKey, limits: { ...PHOTO_MODEL_LIMITS }, fetch: transport });
    return (await preparePhotoTask({ host, root: fixture.root, stateDir: fixture.stateDir, intent: "按修改月份整理根层照片，完整相同副本移入待确认目录", backend, deduplicate: true })).plan;
  } finally { host.close(); }
}

try {
  await test("fixture CLI creates an isolated optional-duplicate dataset without reading user photos", () => {
    fixture = cli("fixture", ["--deduplicate"]);
    assert.equal(fixture.synthetic, true);
    const resolved = path.resolve(fixture.fixture);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("deskshell-photo-task-"));
    ownedFixtures.add(resolved);
    assert.equal(path.dirname(fixture.root), resolved); assert.equal(path.dirname(fixture.stateDir), resolved);
    initial = captureTree(fixture.root);
    assert.equal(initial.nodes.filter((node) => node.kind === "file").length, 7);
    assert.equal(fs.readFileSync(path.join(fixture.root, "z-duplicate.png"), "utf8"), "Synthetic photo fixture A\n");
  });

  await test("three concurrent host-start clients converge on one instance and a stopped host can restart", async () => {
    const results = await Promise.all([0, 1, 2].map(() => concurrentHostStart(scoped())));
    const errors = results.filter((entry) => entry.exitCode !== 0).map((entry) => typeof entry.result?.code === "string" ? entry.result.code : "UNKNOWN_START_FAILURE");
    assert.equal(errors.length, 0, `Concurrent host starts failed: ${errors.join(", ")}`);
    assert.equal(new Set(results.map((entry) => entry.result.pid)).size, 1);
    assert.equal(new Set(results.map((entry) => entry.result.instanceId)).size, 1);
    const originalInstance = results[0].result.instanceId;
    assert.equal(cli("host-status", ["--state", fixture.stateDir]).instanceId, originalInstance);
    assert.equal(cli("host-stop", ["--state", fixture.stateDir]).stopped, true);
    const restarted = cli("host-start", scoped());
    assert.notEqual(restarted.instanceId, originalInstance);
    assert.equal(cli("host-status", ["--state", fixture.stateDir]).instanceId, restarted.instanceId);
  });

  await test("repeated host-start reuses one hidden daemon and host-status reports its identity", () => {
    firstHost = cli("host-start", scoped());
    const again = cli("host-start", scoped()); const status = cli("host-status", ["--state", fixture.stateDir]);
    assert.equal(again.pid, firstHost.pid); assert.equal(again.instanceId, firstHost.instanceId);
    assert.equal(status.pid, firstHost.pid); assert.equal(status.instanceId, firstHost.instanceId);
    assert.ok(firstHost.pid !== process.pid);
    const endpoint = readEndpoint(fixture.stateDir);
    for (const output of [firstHost, again, status]) {
      const text = JSON.stringify(output);
      assert.ok(!text.includes(endpoint.taskToken) && !text.includes(endpoint.controlToken), "Host CLI output must omit IPC credentials");
    }
  });

  await test("list and budget CLI read host state without changing the user model allowance", () => {
    assert.deepEqual(cli("list", scoped()), []);
    budgetBefore = cli("budget", ["--state", fixture.stateDir]);
    assert.equal(budgetBefore.timezone, "UTC"); assert.ok(Number.isSafeInteger(budgetBefore.usedRequests));
    const again = cli("budget", ["--state", fixture.stateDir]);
    assert.equal(again.usedRequests, budgetBefore.usedRequests); assert.equal(again.reservedCostUsd, budgetBefore.reservedCostUsd);
    assert.deepEqual(again.limits, budgetBefore.limits);
  });

  await test("host-stop releases discovery and permits an embedded host to prepare an offline fixed plan", async () => {
    assert.equal(cli("host-stop", ["--state", fixture.stateDir]).stopped, true);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, "host-endpoint.json")), false);
    assert.equal(cli("host-stop", ["--state", fixture.stateDir]).stopped, true);
    plan = await prepareOffline();
    assert.equal(plan.actions.length, 7); assert.equal(captureTree(fixture.root).digest, initial.digest);
  });

  await test("inspect auto-starts a host and only exact CLI approval executes the persisted plan", () => {
    const preview = cli("inspect", [...scoped(), "--plan", plan.planId]);
    assert.equal(preview.task.status, "awaiting_approval"); assert.equal(preview.digest, plan.digest);
    assert.notEqual(cli("host-status", ["--state", fixture.stateDir]).instanceId, firstHost.instanceId);
    assert.equal(cli("apply", [...scoped(), "--plan", plan.planId, "--digest", "wrong"], 1).code, "DIGEST_MISMATCH");
    assert.equal(captureTree(fixture.root).digest, initial.digest);
    const result = cli("apply", [...scoped(), "--plan", plan.planId, "--digest", plan.digest]);
    assert.equal(result.status, "succeeded"); assert.equal(result.goal.satisfied, true);
    assert.equal(fs.existsSync(path.join(fixture.root, "_duplicates/z-duplicate.png")), true);
    assert.deepEqual(cli("status", [...scoped(), "--task", plan.taskId]), result);
    assert.deepEqual(cli("apply", [...scoped(), "--plan", plan.planId, "--digest", plan.digest]), result);
    const budget = cli("budget", ["--state", fixture.stateDir]);
    assert.equal(budget.usedRequests, budgetBefore.usedRequests); assert.equal(budget.reservedCostUsd, budgetBefore.reservedCostUsd);
  });

  await test("undo CLI previews recovery and a separate recovery-apply restores original files", () => {
    const beforeUndo = captureTree(fixture.root);
    const recovery = cli("undo", [...scoped(), "--task", plan.taskId]);
    assert.equal(recovery.mode, "undo"); assert.equal(recovery.steps.length, 7);
    assert.equal(captureTree(fixture.root).digest, beforeUndo.digest);
    const inspected = cli("recovery-inspect", [...scoped(), "--recovery", recovery.recoveryId]);
    assert.equal(inspected.digest, recovery.digest);
    assert.equal(cli("recovery-apply", [...scoped(), "--recovery", recovery.recoveryId, "--digest", "wrong"], 1).code, "DIGEST_MISMATCH");
    assert.equal(captureTree(fixture.root).digest, beforeUndo.digest);
    const restored = cli("recovery-apply", [...scoped(), "--recovery", recovery.recoveryId, "--digest", recovery.digest]);
    assert.equal(restored.status, "undone"); assert.equal(captureTree(fixture.root).digest, initial.digest);
    assert.deepEqual(cli("status", [...scoped(), "--task", plan.taskId]), restored);
  });

  await test("overlapping root and state are rejected before changing root access permissions", () => {
    const beforeAccess = accessState(fixture.root);
    const beforeParentAccess = accessState(fixture.fixture);
    for (const stateDir of [fixture.root, path.join(fixture.root, "invalid-state"), fixture.fixture]) {
      const result = cli("host-start", ["--root", fixture.root, "--state", stateDir], 1);
      assert.equal(result.code, "INVALID_STATE_SCOPE");
      assert.ok(accessState(fixture.root) === beforeAccess, "Rejected host startup must preserve root ACL/mode");
      assert.ok(accessState(fixture.fixture) === beforeParentAccess, "Rejected host startup must preserve ancestor ACL/mode");
    }
    assert.equal(fs.existsSync(path.join(fixture.root, "invalid-state")), false);
    assert.equal(captureTree(fixture.root).digest, initial.digest);
  });

  await test("CLI cancellation remains durable across daemon restart and prevents later apply", async () => {
    await stopAgentHost(fixture.stateDir);
    const pending = await prepareOffline();
    const cancelled = cli("cancel", [...scoped(), "--task", pending.taskId]);
    assert.equal(cancelled.status, "cancelled");
    cli("host-stop", ["--state", fixture.stateDir]);
    assert.equal(cli("status", [...scoped(), "--task", pending.taskId]).status, "cancelled");
    assert.equal(cli("apply", [...scoped(), "--plan", pending.planId, "--digest", pending.digest], 130).status, "cancelled");
    assert.equal(captureTree(fixture.root).digest, initial.digest);
    const history = cli("list", scoped());
    assert.equal(history.length, 2); assert.ok(history.some((task: any) => task.status === "undone"));
  });

  console.log(`Agent CLI checks passed: ${passed}`);
} finally {
  const shutdown = await Promise.allSettled([...hostStates].map((state) => stopAgentHost(state)));
  if (shutdown.some((result) => result.status === "rejected")) throw new Error("CLI_DAEMON_CLEANUP_FAILED");
  for (const folder of ownedFixtures) {
    const absolute = path.resolve(folder);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith("deskshell-photo-task-")) throw new Error("Unsafe CLI fixture cleanup path");
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
