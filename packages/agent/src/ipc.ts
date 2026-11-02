import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface HostEndpoint { version: 1; instanceId: string; pid: number; port: number; root: string; taskToken: string; controlToken: string }
export class IpcError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "IpcError"; this.code = code; }
}
export function readEndpoint(stateDir: string): HostEndpoint {
  try {
    const file = path.join(path.resolve(stateDir), "host-endpoint.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.version !== 1 || typeof value.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.instanceId)
        || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
        || typeof value.root !== "string" || !path.isAbsolute(value.root) || !/^[a-f0-9]{64}$/.test(value.taskToken) || !/^[a-f0-9]{64}$/.test(value.controlToken)) throw new Error();
    return value;
  } catch { throw new IpcError("HOST_NOT_RUNNING"); }
}
export async function callHost(stateDir: string, method: string, params: Record<string, unknown> = {}, options: { control?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<any> {
  const endpoint = readEndpoint(stateDir);
  const id = randomUUID();
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  const timer = setTimeout(abort, options.timeoutMs ?? 60_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.control ? endpoint.controlToken : endpoint.taskToken}` },
      body: JSON.stringify({ version: 1, instanceId: endpoint.instanceId, id, method, params }),
    });
    if (!response.ok || !response.body) throw new IpcError("IPC_REJECTED");
    reader = response.body.getReader();
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 16 * 1024 * 1024) throw new IpcError("IPC_RESPONSE_LIMIT");
      chunks.push(part.value);
    }
    const data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (data.id !== id || data.instanceId !== endpoint.instanceId || typeof data.ok !== "boolean") throw new IpcError("INVALID_IPC_RESPONSE");
    if (!data.ok) throw new IpcError(typeof data.code === "string" && /^[A-Z0-9_]{1,80}$/.test(data.code) ? data.code : "HOST_OPERATION_FAILED");
    return data.result;
  } catch (error) {
    if (error instanceof IpcError) throw error;
    throw new IpcError(controller.signal.aborted ? "IPC_CANCELLED" : "HOST_UNREACHABLE");
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    if (reader) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* pending cancellation */ } }
  }
}
