import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { callHost, IpcError, readEndpoint } from "./ipc.ts";
import { ensurePrivateState, validateHostDirectories } from "./private-state.ts";

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
const same = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function startAgentHost(root: string, stateDir: string): Promise<Record<string, unknown>> {
  validateHostDirectories(root, stateDir);
  const selected = fs.realpathSync.native(path.resolve(root));
  try {
    const health = await callHost(stateDir, "health", {}, { timeoutMs: 2000 });
    if (!same(selected, health.root)) throw new IpcError("PLAN_SCOPE_MISMATCH");
    return health;
  } catch (error) {
    if (!(error instanceof IpcError) || !["HOST_NOT_RUNNING", "HOST_UNREACHABLE", "IPC_CANCELLED", "IPC_REJECTED"].includes(error.code)) throw error;
  }
  ensurePrivateState(stateDir);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../apps/agent/host.ts", import.meta.url)), "--root", path.resolve(root), "--state", path.resolve(stateDir)], {
    detached: true, windowsHide: true, stdio: "ignore",
  });
  let exited = false; child.once("error", () => { exited = true; }); child.once("exit", () => { exited = true; }); child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const health = await callHost(stateDir, "health", {}, { timeoutMs: 1000 });
      if (!same(selected, health.root)) throw new IpcError("PLAN_SCOPE_MISMATCH");
      return health;
    } catch (error) { if (error instanceof IpcError && error.code === "PLAN_SCOPE_MISMATCH") throw error; }
    // Another client may have won the durable host lock while our child exited.
    // Wait for that owner's discovery publication instead of treating the loser as failure.
    await delay();
  }
  throw new IpcError(exited ? "HOST_START_FAILED" : "HOST_START_TIMEOUT");
}

export async function stopAgentHost(stateDir: string): Promise<{ stopped: boolean }> {
  let instance: string;
  try { instance = readEndpoint(stateDir).instanceId; }
  catch {
    if (fs.existsSync(path.join(path.resolve(stateDir), "host-endpoint.json"))) throw new IpcError("HOST_DISCOVERY_INVALID");
    return { stopped: true };
  }
  await callHost(stateDir, "host.shutdown", {}, { control: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if (readEndpoint(stateDir).instanceId !== instance) return { stopped: true }; }
    catch { return { stopped: true }; }
    try {
      const health = await callHost(stateDir, "health", {}, { timeoutMs: 1000 });
      if (health.instanceId === instance && health.shutdownError === "HOST_STOP_INCOMPLETE") throw new IpcError("HOST_STOP_INCOMPLETE");
    } catch (error) { if (error instanceof IpcError && error.code === "HOST_STOP_INCOMPLETE") throw error; }
    await delay();
  }
  throw new IpcError("HOST_STOP_TIMEOUT");
}
