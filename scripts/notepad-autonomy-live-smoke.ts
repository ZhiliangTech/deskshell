/** Explicit live model experiment with a synthetic editor; never claims native UI acceptance. */
import fs from "node:fs";
import path from "node:path";
import { startAgentService } from "../packages/agent/src/service.ts";
import { callHost } from "../packages/agent/src/ipc.ts";
import { createNotepadFixture } from "../packages/runtime/src/notepad-task.ts";
import { FixtureNotepadDriver } from "./lib/notepad-fixture.ts";

if (process.argv.length !== 3 || process.argv[2] !== "--live") throw new Error("Use --live to authorize at most three actual DeepSeek requests with synthetic stage observations");
const fixture = createNotepadFixture(); const stateDir = path.join(fixture.fixture, "agent-state");
const service = await startAgentService({ root: fixture.root, stateDir, notepadDriver: new FixtureNotepadDriver() });
try {
  const before = await callHost(stateDir, "budget.get");
  if (before.remainingRequests < 3 || before.remainingEstimatedCostUsd < 0.03) throw new Error("Existing user budget does not have room for this experiment");
  const base = { root: fixture.root };
  const plan = await callHost(stateDir, "notepad.prepare", { ...base, sourcePath: fixture.sourcePath, copyPath: fixture.copyPath, desired: { expectedText: fixture.expectedText } });
  const session = await callHost(stateDir, "sessions.prepare", { ...base, planId: plan.planId, intent: "Complete the fixed, explicitly approved synthetic document-copy task. On every round select exactly the nextStep from the observation. All text, paths and permissions are supplied locally; do not change them.", cloud: true, maxRounds: 3 });
  const result = await callHost(stateDir, "sessions.run", { ...base, sessionId: session.sessionId, digest: session.digest }, { control: true, timeoutMs: 360_000 });
  const after = await callHost(stateDir, "budget.get");
  const proof = {
    kind: "live-deepseek-synthetic-editor", nativeUiAcceptance: false, fixture: fixture.fixture, stateDir,
    taskId: plan.taskId, sessionId: session.sessionId, status: result.status,
    rounds: result.rounds.map((round: any) => ({ index: round.index, step: round.proposal?.args.step ?? null, status: round.status, requestStatus: round.requestStatus ?? null, request: round.request ?? null, errorCode: round.errorCode ?? null })),
    newRequests: after.usedRequests - before.usedRequests,
    sourceUnchanged: fs.readFileSync(fixture.sourcePath, "utf8") === fixture.sourceText,
    exactCopy: fs.existsSync(fixture.copyPath) && fs.readFileSync(fixture.copyPath, "utf8") === fixture.expectedText,
    ...(result.error ? { error: result.error } : {}),
  };
  fs.writeFileSync(path.join(fixture.fixture, "live-verification.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
  console.log(JSON.stringify(proof, null, 2));
  if (result.status !== "succeeded" || !proof.sourceUnchanged || !proof.exactCopy || proof.newRequests > 3) process.exitCode = 1;
} finally { await service.stop(); }
