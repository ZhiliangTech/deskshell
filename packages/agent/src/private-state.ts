import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isInside } from "../../core/src/policy.ts";
import { IpcError } from "./ipc.ts";

/** Validate all scope relationships before any ACL or directory mutation. */
export function validateHostDirectories(root: string, stateDir: string): void {
  const selected = path.resolve(root); const state = path.resolve(stateDir);
  if (path.dirname(state) === state || isInside(selected, state) || isInside(state, selected)) throw new IpcError("INVALID_STATE_SCOPE");
  for (const target of [selected, state]) for (let current = target; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IpcError("INVALID_STATE_SCOPE");
    }
    if (path.dirname(current) === current) break;
  }
}

export function ensurePrivateState(directory: string): string {
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) === absolute) throw new IpcError("INVALID_STATE_SCOPE");
  for (let current = absolute; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("INVALID_STATE_DIRECTORY");
    }
    if (path.dirname(current) === current) break;
  }
  if (fs.existsSync(absolute) && fs.readdirSync(absolute).some((name) => !/^(tasks\.sqlite(?:-wal|-shm|-journal)?|model-budget\.sqlite(?:-wal|-shm|-journal)?|autonomy\.sqlite(?:-wal|-shm|-journal)?|notepad|autonomy|journals|host-endpoint\.json|endpoint-[a-f0-9-]+\.tmp|model-request-[a-f0-9-]+\.json(?:\.tmp)?)$/.test(name))) {
    throw new IpcError("STATE_DIRECTORY_NOT_APP_OWNED");
  }
  if (process.platform === "win32") {
    try {
      execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../../runtime/windows/private-dir.ps1", import.meta.url)), "-Target", absolute,
      ], { windowsHide: true, timeout: 15_000, stdio: ["ignore", "ignore", "ignore"] });
    } catch { throw new Error("PRIVATE_STATE_FAILED"); }
  } else {
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (fs.statSync(absolute).uid !== process.getuid?.()) throw new Error("PRIVATE_STATE_OWNER_REQUIRED");
    fs.chmodSync(absolute, 0o700);
  }
  return fs.realpathSync.native(absolute);
}
