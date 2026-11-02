/** Explicit native acceptance. Creates its own synthetic files/window; never reuses a user document. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { startAgentService } from "../packages/agent/src/service.ts";
import { callHost } from "../packages/agent/src/ipc.ts";
import { createNotepadFixture } from "../packages/runtime/src/notepad-task.ts";
import { createWindowsNotepadDriver, NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE } from "../packages/drivers/windows/notepad.ts";
import { NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE } from "../packages/drivers/windows/notepad-profile-selection.ts";
import type { ProposalBackend } from "../packages/agent/src/photo-agent.ts";

const mode = process.argv[2];
const newline = process.argv[3] === "--lf" ? "\n" : "\r\n";
if (!(process.argv.length === 3 || process.argv.length === 4 && mode === "--native" && process.argv[3] === "--lf") || !["--native", "--native-production", "--native-offline", "--native-live"].includes(mode)) {
  throw new Error("Choose --native [--lf], --native-production (default service profile), --native-offline (three local proposals), or --native-live (at most three actual DeepSeek requests). Each mode operates a new dedicated Notepad window.");
}
if (process.platform !== "win32") throw new Error("Windows is required");
const fixture = createNotepadFixture();
const stateDir = path.join(fixture.fixture, "agent-state");
const sourcePath = path.join(fixture.root, "任务说明.txt");
const copyPath = path.join(fixture.root, "任务说明-已整理.txt");
const sourceText = `任务说明${newline}${fixture.marker}${newline}保留原始正文。${newline}${newline}`;
const expectedText = sourceText.replace(`任务说明${newline}`, `任务说明（已整理）${newline}`) + `追加段落：由本地任务系统验证并保存副本。${newline}`;
fs.writeFileSync(sourcePath, sourceText, { flag: "wx" });
const beforeFiles = fs.readdirSync(fixture.root).sort();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const originalBytes = fs.readFileSync(sourcePath);
let localRequests = 0;
const backend: ProposalBackend = {
  async propose(input) {
    if (input.signal?.aborted) throw new Error("CANCELLED");
    const context = JSON.parse(input.intent);
    const step = context.observation.nextStep;
    if (!["open", "edit", "save-copy"].includes(step) || ++localRequests > 3) throw new Error("SYNTHETIC_PROPOSAL_LIMIT");
    return { proposal: { skillId: "notepad-next-step", version: "1", args: { step }, goalCriteria: {} },
      usage: null, model: "synthetic-local-planner", requestId: `native-fixture-${localRequests}`, estimatedCostUsd: 0,
      budget: { requests: localRequests, reservedCostUsd: 0 } };
  },
};
const driver = createWindowsNotepadDriver({ profile: NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE, allowUnverifiedProfile: true });
let nativeFailure: { operation: string; code: string; reason?: string } | undefined;
for (const operation of ["open", "observe", "edit", "saveCopy"] as const) {
  const original = driver[operation].bind(driver);
  (driver as any)[operation] = async (...args: any[]) => {
    try { return await (original as any)(...args); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)) {
        nativeFailure = { operation, code: error.code,
          ...("reason" in error && typeof error.reason === "string" && /^[A-Z0-9_]{1,80}$/.test(error.reason) ? { reason: error.reason } : {}) };
      }
      throw error;
    }
  };
}
const service = await startAgentService({ root: fixture.root, stateDir, ...(mode !== "--native-production" ? { notepadDriver: driver } : {}),
  ...(mode === "--native-offline" ? { backendFactory: () => backend, budgetDir: path.join(fixture.fixture, "synthetic-budget") } : {}),
});
const proof: Record<string, any> = {
  kind: mode === "--native-live" ? "live-deepseek-native-notepad" : mode === "--native-offline" ? "local-planner-native-notepad" : "approved-native-notepad",
  nativeUiAcceptance: false, fixture: fixture.fixture, stateDir, sourcePath, copyPath,
  startedAt: new Date().toISOString(), nativeProfile: (mode === "--native-production" ? NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE : NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE).id,
  defaultServiceProfile: mode === "--native-production",
  newline: newline === "\n" ? "lf" : "crlf",
};
console.log(JSON.stringify({ fixture: fixture.fixture, mode, phase: "starting-dedicated-native-window" }));
let beforeBudget: any;
try {
  if (mode === "--native-live") {
    beforeBudget = await callHost(stateDir, "budget.get");
    if (beforeBudget.remainingRequests < 3 || beforeBudget.remainingEstimatedCostUsd < .03) throw new Error("USER_BUDGET_INSUFFICIENT");
  }
  const base = { root: fixture.root };
  if (mode === "--native-production") {
    const probe = await callHost(stateDir, "notepad.probe", base);
    proof.profileProbe = { available: probe.available, profileVerified: probe.profileVerified, runtimeVerified: probe.runtimeVerified, installedVersion: probe.installedVersion };
    if (!probe.available || !probe.profileVerified || probe.runtimeVerified !== false) throw new Error("PRODUCTION_PROFILE_UNAVAILABLE");
  }
  const plan = await callHost(stateDir, "notepad.prepare", { ...base, sourcePath, copyPath, desired: { expectedText } });
  proof.taskId = plan.taskId;
  let result: any;
  if (mode === "--native" || mode === "--native-production") {
    result = await callHost(stateDir, "notepad.apply", { ...base, planId: plan.planId, digest: plan.digest }, { control: true, timeoutMs: 120_000 });
  } else {
    const session = await callHost(stateDir, "sessions.prepare", { ...base, planId: plan.planId,
      intent: "Complete the fixed, explicitly approved synthetic document-copy task. Each round must select exactly the nextStep in the observation. Text, paths and permissions are supplied locally and cannot be changed.", cloud: true, maxRounds: 3 });
    proof.sessionId = session.sessionId;
    result = await callHost(stateDir, "sessions.run", { ...base, sessionId: session.sessionId, digest: session.digest }, { control: true, timeoutMs: 360_000 });
    proof.rounds = result.rounds.map((r: any) => ({ index: r.index, step: r.proposal?.args.step ?? null, status: r.status, requestStatus: r.requestStatus ?? null, request: r.request ?? null, errorCode: r.errorCode ?? null }));
  }
  proof.status = result.status;
  if (result.error) proof.error = result.error;
  const task = await callHost(stateDir, "notepad.get", { ...base, taskId: plan.taskId });
  proof.goal = task.goal ?? null;
  proof.journal = task.journal.map((entry: any) => ({ step: entry.step, phase: entry.phase,
    windowId: entry.after?.windowId ?? null, documentId: entry.after?.documentId ?? null, evidence: entry.after?.evidence ?? null }));
  proof.nativeJournalVerified = proof.journal.length === 3 && proof.journal.every((entry: any, i: number) => entry.step === ["open", "edit", "save-copy"][i] && entry.phase === "verified" && entry.evidence?.window === "native-window" && entry.evidence?.inputMode === "targeted");
  proof.planningVerified = mode === "--native" || mode === "--native-production" || proof.rounds.length === 3 && proof.rounds.every((round: any, i: number) => round.step === ["open", "edit", "save-copy"][i] && round.status === "verified");
  if (mode === "--native-production" && result.status === "succeeded") {
    try {
      await callHost(stateDir, "notepad.prepare", { ...base, sourcePath, copyPath: path.join(fixture.root, "second-copy.txt"), desired: { expectedText } });
      proof.secondTaskRejectedBeforeInput = false;
    } catch (error) { proof.secondTaskRejectedBeforeInput = !!error && typeof error === "object" && "code" in error && error.code === "NOTEPAD_HOST_RESTART_REQUIRED"; }
  }
  proof.localRequests = localRequests;
} catch (error) {
  proof.status = "failed";
  proof.error = { code: error && typeof error === "object" && "code" in error ? String(error.code) : "NATIVE_ACCEPTANCE_FAILED" };
  process.exitCode = 1;
} finally {
  if (beforeBudget) {
    try {
      const afterBudget = await callHost(stateDir, "budget.get");
      proof.newRequests = afterBudget.usedRequests - beforeBudget.usedRequests;
      if (proof.newRequests !== 3) process.exitCode = 1;
    } catch { proof.budgetVerificationUnknown = true; process.exitCode = 1; }
  }
  try {
    proof.sourceUnchanged = fs.readFileSync(sourcePath).equals(originalBytes);
    proof.sourceHash = hash(originalBytes);
    proof.exactCopy = fs.existsSync(copyPath) && fs.readFileSync(copyPath).equals(Buffer.from(expectedText));
    proof.copyHash = fs.existsSync(copyPath) ? hash(fs.readFileSync(copyPath)) : null;
    proof.newFiles = fs.readdirSync(fixture.root).filter((f) => !beforeFiles.includes(f)).sort();
    proof.onlyExpectedNewFile = proof.newFiles.length === 1 && proof.newFiles[0] === path.basename(copyPath);
  } catch { proof.fileVerificationUnknown = true; process.exitCode = 1; }
  driver.close();
  try { await service.stop(); } catch { proof.shutdownIncomplete = true; process.exitCode = 1; }
  proof.nativeUiAcceptance = proof.status === "succeeded" && proof.goal?.satisfied === true && proof.nativeJournalVerified === true && proof.planningVerified === true
    && proof.sourceUnchanged === true && proof.exactCopy === true && proof.onlyExpectedNewFile === true && !proof.shutdownIncomplete && !proof.fileVerificationUnknown
    && (mode !== "--native-live" || proof.newRequests === 3 && !proof.budgetVerificationUnknown)
    && (mode !== "--native-production" || proof.secondTaskRejectedBeforeInput === true);
  if (!proof.nativeUiAcceptance) process.exitCode = 1;
  proof.finishedAt = new Date().toISOString();
  if (nativeFailure) proof.nativeFailure = nativeFailure;
  fs.writeFileSync(path.join(fixture.fixture, "native-verification.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
  console.log(JSON.stringify(proof, null, 2));
}
