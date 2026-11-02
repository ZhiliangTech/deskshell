import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDeepSeekApiKey } from "../../packages/models/src/credentials.ts";
import { DeepSeekBackend, ModelError } from "../../packages/models/src/deepseek.ts";
import { createTaskHost } from "../../packages/runtime/src/host.ts";

// Explicit opt-in: normal regression and --help never read credentials or call a model.
if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--live") {
  console.log("Usage: node apps/runtime/cloud-demo.ts --live\nOne paid, bounded DeepSeek request using synthetic text; prepares a local preview only.");
  process.exit(0);
}

const intent = "Propose creating hello.txt with exactly Hello from DeepSeek. followed by one newline. Use the registered greeting skill.";
const content = "Hello from DeepSeek.\n";
const filename = "hello.txt";
const limits = { maxRequests: 1, maxInputBytes: 8192, maxOutputTokens: 256, timeoutMs: 30_000, maxEstimatedCostUsd: 0.01 };
let phase = "credential";
let host: ReturnType<typeof createTaskHost> | undefined;
try {
  const backend = new DeepSeekBackend({ apiKey: await loadDeepSeekApiKey(), limits });
  phase = "proposal";
  const startedAt = new Date().toISOString();
  const result = await backend.propose({ intent, skills: [{
    id: "cloud-greeting", version: "1", description: "Create the fixed greeting in the host-owned isolated test folder.",
    argsSchema: { type: "object", additionalProperties: false, required: ["filename", "content"], properties: {
      filename: { type: "string", enum: [filename] }, content: { type: "string", enum: [content] },
    } },
  }] });
  phase = "prepare";
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-cloud-demo-"));
  const root = path.join(fixture, "files"); fs.mkdirSync(root);
  const target = path.join(root, filename);
  host = createTaskHost({
    dataDir: path.join(fixture, "state"), allowedRoots: [root], granted: ["fs.read", "fs.write"],
    skills: [{
      skill: {
        manifest: { name: "cloud-greeting", version: "1", description: "Create a known greeting", entry: "cloud-demo.ts", capabilities: [
          { id: "fs.read", scope: "{{root}}", reason: "Check test files" }, { id: "fs.write", scope: "{{root}}", reason: "Create test greeting" },
        ] },
        async plan(input) {
          // Host-owned values independently constrain the proposal; root cannot come from the model.
          if (input.filename !== filename || input.content !== content) throw new Error("INVALID_GREETING_ARGUMENTS");
          return [{ id: "greeting", kind: "fs.write", path: target, content, undo: { kind: "fs.restore", path: target, content: null } }];
        },
      },
      revision: () => createHash("sha256").update(fs.readFileSync(import.meta.filename)).digest("hex"),
      validator: { id: "fixed-greeting", version: "1", verify: () => ({ satisfied: fs.readFileSync(target, "utf8") === content, detail: "Greeting content independently checked" }) },
    }],
  });
  const plan = await host.tasks.prepare({
    skillId: result.proposal.skillId, root, args: result.proposal.args,
    // A model-provided goalCriteria never defines success. This fixture's goal is trusted code.
    goal: { intent, criteria: { filename, content } },
  });
  const task = host.tasks.get(plan.taskId);
  if (task.status !== "awaiting_approval" || fs.readdirSync(root).length !== 0) throw new Error("PREVIEW_INVARIANT_FAILED");
  const evidence = {
    startedAt, completedAt: new Date().toISOString(), phase: "preview", provider: "deepseek", requestedModel: "deepseek-flash",
    returnedModel: result.model, requestId: result.requestId, usage: result.usage, limits,
    conservativeEstimateUsd: result.estimatedCostUsd, budget: result.budget,
    outboundData: "Fixed synthetic intent and greeting schema only; no local file contents or paths",
    taskStatus: task.status, taskId: plan.taskId, planId: plan.planId, digest: plan.digest,
    steps: plan.preview.steps, approvalIssued: false, targetCreated: false, fixture,
  };
  fs.writeFileSync(path.join(fixture, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  // Never log raw exceptions, requests, provider bodies, or credential helper output.
  console.error(JSON.stringify({ ok: false, phase, code: error instanceof ModelError ? error.code : "LOCAL_SETUP_FAILED", ...(error instanceof ModelError && error.status ? { status: error.status } : {}) }));
  process.exitCode = 1;
} finally {
  try { host?.close(); }
  catch { console.error(JSON.stringify({ ok: false, phase: "cleanup", code: "LOCAL_CLEANUP_FAILED" })); process.exitCode = 1; }
}
