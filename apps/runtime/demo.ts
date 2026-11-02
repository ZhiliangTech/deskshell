import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskHost } from "../../packages/runtime/src/host.ts";

// Isolated demonstration: never adopts an existing user folder or opens windows.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-host-demo-"));
const root = path.join(fixture, "files"); fs.mkdirSync(root);
const target = path.join(root, "hello.txt");
const host = createTaskHost({
  dataDir: path.join(fixture, "state"), allowedRoots: [root], granted: ["fs.read", "fs.write"],
  skills: [{
    skill: {
      manifest: { name: "hello-task", version: "1", description: "Create a known file", entry: "demo.ts", capabilities: [{ id: "fs.read", scope: "{{root}}", reason: "Verify demo files" }, { id: "fs.write", scope: "{{root}}", reason: "Create demo output" }] },
      async plan() { return [{ id: "hello", kind: "fs.write", path: target, content: "Hello from a prepared task.\n", post: [{ kind: "path.exists", path: target }], undo: { kind: "fs.restore", path: target, content: null } }]; },
    },
    revision: () => createHash("sha256").update(fs.readFileSync(import.meta.filename)).digest("hex"),
    validator: { id: "hello-content", version: "1", verify: () => ({ satisfied: fs.readFileSync(target, "utf8") === "Hello from a prepared task.\n", detail: "Output content independently checked" }) },
  }],
});
try {
  const plan = await host.tasks.prepare({ skillId: "hello-task", root, goal: { intent: "Create the demo greeting", criteria: { text: "Hello from a prepared task.\n" } } });
  console.log(JSON.stringify({ phase: "preview", planId: plan.planId, digest: plan.digest, steps: plan.preview.steps, fixture }, null, 2));
  if (process.argv.includes("--apply")) {
    // This explicit flag is the trusted demo caller's approval, not a model tool.
    const approval = host.approvals.approve(plan.planId, plan.digest);
    const result = await host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: approval.approvalId, idempotencyKey: "demo" });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "succeeded") process.exitCode = 1;
  } else console.log("Preview only. Run with --apply to execute in a new isolated fixture.");
} finally { host.close(); }
