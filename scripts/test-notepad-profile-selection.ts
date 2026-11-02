/** Pure metadata and real IPC with synthetic drivers. Never starts a native UI helper. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { matchNotepadEnvironment, selectNotepadProfile, readNotepadInstalledMetadata, NOTEPAD_PROFILE_RELEASE_READY, NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE } from "../packages/drivers/windows/notepad-profile-selection.ts";
import type { SelectedNotepadDriver } from "../packages/drivers/windows/notepad-profile-selection.ts";
import { createWindowsNotepadDriver } from "../packages/drivers/windows/notepad.ts";
import { createNotepadFixture } from "../packages/runtime/src/notepad-task.ts";
import { startAgentService } from "../packages/agent/src/service.ts";
import { callHost } from "../packages/agent/src/ipc.ts";
import { FixtureNotepadDriver } from "./lib/notepad-fixture.ts";

const metadata = { version: 1 as const, packageVersions: ["11.2607.14.0"], uiLocale: "zh-CN" };
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-notepad-profile-"));
const services = new Set<Awaited<ReturnType<typeof startAgentService>>>();
let passed = 0;
async function test(name: string, action: () => Promise<void>) { await action(); passed++; console.log(`PASS ${name}`); }
async function stop(service: Awaited<ReturnType<typeof startAgentService>>) { await service.stop(); services.delete(service); }
function syntheticFactory(driver: FixtureNotepadDriver, initialized: () => void): () => SelectedNotepadDriver {
  return () => {
    initialized();
    return {
      selection: { releaseReady: true, available: true, supportedEnvironment: true, reasons: [], installedVersion: "11.2607.14.0", installedLocale: "zh-CN" },
      driver: Object.assign(driver, {
        close() { /* There is no application or native process in this synthetic driver. */ },
        async probe() { return { appId: driver.appId, driverSessionId: driver.sessionId, readOnly: true as const, available: true, profileId: "synthetic-release-profile", profileVerified: true, capabilities: { ...driver.capabilities, inputMode: "targeted" as const }, reasons: [], runtimeVerified: false, installedVersion: "11.2607.14.0" }; },
      }),
    };
  };
}
async function setup() {
  const fixture = createNotepadFixture(temporary); const stateDir = path.join(fixture.fixture, "agent-state"); const budgetDir = path.join(fixture.fixture, "budget");
  const driver = new FixtureNotepadDriver(); let initializations = 0; let modelRequests = 0; let backendCreations = 0;
  const factory = syntheticFactory(driver, () => { initializations++; });
  const service = await startAgentService({ root: fixture.root, stateDir, budgetDir, nativeNotepadFactory: factory,
    backendFactory: () => { backendCreations++; return { propose: async (request) => {
      modelRequests++; return { proposal: { skillId: "notepad-next-step", version: "1", args: { step: JSON.parse(request.intent).observation.nextStep }, goalCriteria: {} }, model: "synthetic", requestId: `synthetic-${modelRequests}`, usage: null, estimatedCostUsd: 0, budget: { requests: modelRequests, reservedCostUsd: 0 } };
    } }; },
  }); services.add(service);
  const base = { root: fixture.root };
  const prepare = (copyPath = fixture.copyPath) => callHost(stateDir, "notepad.prepare", { ...base, sourcePath: fixture.sourcePath, copyPath, desired: { expectedText: fixture.expectedText } });
  const session = (plan: any) => callHost(stateDir, "sessions.prepare", { ...base, planId: plan.planId, intent: "Perform the approved synthetic copy", cloud: true, maxRounds: 3 });
  const apply = (plan: any) => callHost(stateDir, "notepad.apply", { ...base, planId: plan.planId, digest: plan.digest }, { control: true });
  const run = (plan: any) => callHost(stateDir, "sessions.run", { ...base, sessionId: plan.sessionId, digest: plan.digest }, { control: true });
  return { ...fixture, stateDir, budgetDir, driver, service, base, prepare, session, apply, run,
    counts: () => ({ initializations, modelRequests, backendCreations }) };
}

try {
  await test("exact installed version and UI locale are required independently of the release gate", async () => {
    assert.equal(matchNotepadEnvironment("win32", metadata).supportedEnvironment, true);
    for (const [platform, value, code] of [
      ["linux", metadata, "WINDOWS_REQUIRED"], ["win32", null, "NOTEPAD_METADATA_UNAVAILABLE"],
      ["win32", { ...metadata, packageVersions: [] }, "NOTEPAD_NOT_INSTALLED"],
      ["win32", { ...metadata, packageVersions: [metadata.packageVersions[0], metadata.packageVersions[0]] }, "NOTEPAD_PACKAGE_AMBIGUOUS"],
      ["win32", { ...metadata, packageVersions: ["11.2607.14.1"] }, "NOTEPAD_VERSION_UNSUPPORTED"],
      ["win32", { ...metadata, uiLocale: "en-US" }, "NOTEPAD_LOCALE_UNSUPPORTED"],
      ["win32", { ...metadata, profile: { verified: true } }, "NOTEPAD_METADATA_UNAVAILABLE"],
    ] as Array<[string, unknown, string]>) {
      const selection = matchNotepadEnvironment(platform, value); assert.equal(selection.supportedEnvironment, false); assert.ok(selection.reasons.includes(code));
    }
    assert.equal(NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE.verified, true);
    const selected = selectNotepadProfile("win32", metadata);
    assert.equal(selected.available, NOTEPAD_PROFILE_RELEASE_READY); assert.equal(!!selected.profile, NOTEPAD_PROFILE_RELEASE_READY);
    if (!NOTEPAD_PROFILE_RELEASE_READY) assert.ok(selected.reasons.includes("NOTEPAD_PROFILE_RELEASE_PENDING"));
    assert.equal(selectNotepadProfile("win32", { ...metadata, releaseReady: true }).available, false);
  });

  await test("metadata executor is hidden, bounded, read-only and fails closed without exposing diagnostics", async () => {
    let executions = 0;
    const value = readNotepadInstalledMetadata("win32", (executable, args, options) => {
      executions++; assert.ok(executable.endsWith("powershell.exe")); assert.ok(args.includes("-File")); assert.ok(args.at(-1)?.endsWith("notepad-profile-metadata.ps1"));
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192);
      return JSON.stringify(metadata);
    });
    assert.deepEqual(value, metadata); assert.equal(executions, 1);
    assert.equal(readNotepadInstalledMetadata("linux", () => { throw new Error("Must not execute"); }), null);
    assert.equal(readNotepadInstalledMetadata("win32", () => { throw new Error("PRIVATE_METADATA_ERROR"); }), null);
    assert.equal(readNotepadInstalledMetadata("win32", () => "x".repeat(8193)), null);
    assert.equal(readNotepadInstalledMetadata("win32", () => "invalid json"), null);
    const source = fs.readFileSync(new URL("../packages/drivers/windows/notepad-profile-metadata.ps1", import.meta.url), "utf8");
    assert.equal(/Start-Process|\[Diagnostics\.Process\]::Start|Add-Type|ReadAllText|ReadAllBytes/.test(source), false);
  });

  await test("generic driver remains disabled and never invokes native transport", async () => {
    let calls = 0; const driver = createWindowsNotepadDriver({ transport: async () => { calls++; throw new Error("No UI allowed"); } });
    try { assert.equal((await driver.probe()).available, false); assert.equal(driver.capabilities.saveCopy, false); assert.equal(calls, 0); }
    finally { driver.close(); }
  });

  await test("file host startup does not initialize native metadata and one explicit probe initializes it once", async () => {
    const f = await setup();
    try {
      await callHost(f.stateDir, "health"); await callHost(f.stateDir, "tasks.list", f.base);
      assert.equal(f.counts().initializations, 0); assert.deepEqual(f.driver.calls, []);
      const probe = await callHost(f.stateDir, "notepad.probe", f.base); assert.equal(probe.profileSelection.available, true); assert.equal(probe.runtimeVerified, false); assert.equal(probe.restartRequired, false);
      await f.prepare(); assert.equal(f.counts().initializations, 1); assert.deepEqual(f.driver.calls, []);
    } finally { await stop(f.service); }
  });

  await test("after one direct native task another prepared task or session is rejected before UI or models", async () => {
    const f = await setup();
    try {
      const first = await f.prepare(); const other = await f.prepare(path.join(f.root, "second-copy.txt")); const otherSession = await f.session(other);
      const done = await f.apply(first); assert.equal(done.status, "succeeded"); const calls = f.driver.calls.length;
      await assert.rejects(f.apply(other), hasCode("NOTEPAD_HOST_RESTART_REQUIRED"));
      await assert.rejects(f.run(otherSession), hasCode("NOTEPAD_HOST_RESTART_REQUIRED"));
      await assert.rejects(f.session(other), hasCode("NOTEPAD_HOST_RESTART_REQUIRED"));
      await assert.rejects(f.prepare(path.join(f.root, "third-copy.txt")), hasCode("NOTEPAD_HOST_RESTART_REQUIRED"));
      assert.equal(f.driver.calls.length, calls); assert.equal(f.counts().modelRequests, 0); assert.equal(f.counts().backendCreations, 0);
      assert.deepEqual(await f.apply(first), done); assert.equal((await callHost(f.stateDir, "notepad.get", { ...f.base, taskId: first.taskId })).status, "succeeded");
      assert.equal((await callHost(f.stateDir, "notepad.probe", f.base)).restartRequired, true);
    } finally { await stop(f.service); }
  });

  await test("model-driven native execution occupies the same gate and runtime restart requires fresh plans", async () => {
    const f = await setup(); let restarted: Awaited<ReturnType<typeof startAgentService>> | undefined;
    try {
      const first = await f.prepare(); const other = await f.prepare(path.join(f.root, "second-copy.txt")); const firstSession = await f.session(first); const otherSession = await f.session(other);
      assert.equal((await f.run(firstSession)).status, "succeeded"); assert.equal(f.counts().modelRequests, 3);
      await assert.rejects(f.run(otherSession), hasCode("NOTEPAD_HOST_RESTART_REQUIRED")); assert.equal(f.counts().backendCreations, 1); assert.equal(f.counts().modelRequests, 3);
      await stop(f.service);
      const driver = new FixtureNotepadDriver(); restarted = await startAgentService({ root: f.root, stateDir: f.stateDir, budgetDir: f.budgetDir, nativeNotepadFactory: syntheticFactory(driver, () => {}) }); services.add(restarted);
      await assert.rejects(f.apply(other), hasCode("DRIVER_CHANGED")); assert.deepEqual(driver.calls, []);
      const fresh = await f.prepare(path.join(f.root, "fresh-copy.txt")); assert.equal((await f.apply(fresh)).status, "succeeded");
      assert.equal((await callHost(f.stateDir, "notepad.get", { ...f.base, taskId: first.taskId })).status, "succeeded");
    } finally { if (restarted) await stop(restarted); if (services.has(f.service)) await stop(f.service); }
  });

  await test("RPC cannot inject a profile or release switch and CLI explains the restart error", async () => {
    const f = await setup();
    try {
      await assert.rejects(callHost(f.stateDir, "notepad.probe", { ...f.base, profile: {}, releaseReady: true }, { control: true }), hasCode("INVALID_REQUEST")); assert.equal(f.counts().initializations, 0);
      const first = await f.prepare(); const second = await f.prepare(path.join(f.root, "second-copy.txt")); await f.apply(first);
      const run = promisify(execFile); let output: any;
      try { await run(process.execPath, ["apps/agent/cli.ts", "notepad-apply", "--root", f.root, "--state", f.stateDir, "--plan", second.planId, "--digest", second.digest], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true }); assert.fail("Expected restart error"); }
      catch (error) { output = JSON.parse((error as { stdout: string }).stdout); }
      assert.equal(output.code, "NOTEPAD_HOST_RESTART_REQUIRED"); assert.ok(output.nextAction.includes("prepare a new Notepad plan")); assert.equal(f.counts().modelRequests, 0);
    } finally { await stop(f.service); }
  });

  await test("explicit synthetic driver injection keeps its existing multiple-task behavior", async () => {
    const fixture = createNotepadFixture(temporary); const driver = new FixtureNotepadDriver(); const stateDir = path.join(fixture.fixture, "agent-state");
    const service = await startAgentService({ root: fixture.root, stateDir, budgetDir: path.join(fixture.fixture, "budget"), notepadDriver: driver,
      nativeNotepadFactory: () => { throw new Error("A synthetic injection must never initialize production metadata or lifecycle"); } }); services.add(service);
    try {
      for (const copyPath of [fixture.copyPath, path.join(fixture.root, "second-copy.txt")]) {
        const plan = await callHost(stateDir, "notepad.prepare", { root: fixture.root, sourcePath: fixture.sourcePath, copyPath, desired: { expectedText: fixture.expectedText } });
        const result = await callHost(stateDir, "notepad.apply", { root: fixture.root, planId: plan.planId, digest: plan.digest }, { control: true });
        assert.equal(result.status, "succeeded"); assert.equal(fs.readFileSync(copyPath, "utf8"), fixture.expectedText);
      }
      assert.equal(driver.calls.filter((call) => call === "open").length, 2);
    } finally { await stop(service); }
  });

  console.log(`Notepad profile selection checks passed: ${passed}`);
} finally {
  for (const service of services) await service.stop();
  const resolved = fs.realpathSync.native(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith("deskshell-notepad-profile-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
