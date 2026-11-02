import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CredentialStatus {
  configured: boolean;
  protection: string;
  path: string;
  clipboardCleared?: boolean;
}

/**
 * 凭据层的错误：带上固定 code，让上层能区分"没配 key"和"宿主内部崩了"。
 * 之前这些错误只有 message、没有 code，service 的 safeCode 一律落到
 * HOST_OPERATION_FAILED，用户看不出到底是哪种失败。
 */
export class CredentialError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

/** 只保留脚本自报的 "<code>:<stage>:<exceptionType>:<hresult>" 里前三段，其余字节一律清零 */
function stageFromStderr(data: Buffer): string | undefined {
  const text = data.toString("latin1");
  const match = /^([A-Z_]{4,64}):([A-Za-z0-9_]{1,40}):([A-Za-z0-9_.]{1,60})/.exec(text);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : undefined;
}

/** No secret is passed through command arguments, environment variables, or log messages. */
function credentialOperation(operation: "ImportClipboard" | "Status" | "Read"): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new CredentialError("WINDOWS_CREDENTIAL_STORE_REQUIRED"));
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = fileURLToPath(new URL("../windows/credential.ps1", import.meta.url));
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "-Operation", operation], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0; let finished = false; let stage: string | undefined;
    const fail = (): void => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.kill();
      for (const chunk of chunks) chunk.fill(0);
      reject(new CredentialError("CREDENTIAL_OPERATION_FAILED", stage ?? "CREDENTIAL_OPERATION_FAILED"));
    };
    const timer = setTimeout(fail, 15_000);
    child.stdout.on("data", (data: Buffer) => {
      if (finished) { data.fill(0); return; }
      bytes += data.length;
      if (bytes > 8192) { data.fill(0); fail(); return; }
      chunks.push(data);
    });
    // Drain errors without retaining or propagating them: they may contain sensitive context.
    // 只留下脚本自报的固定前缀（阶段 + 异常类型），其余内容清掉。
    child.stderr.on("data", (data: Buffer) => {
      if (stage === undefined) stage = stageFromStderr(data);
      data.fill(0);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (finished) return;
      if (code !== 0) { fail(); return; }
      finished = true; clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      const value = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
      buffer.fill(0); for (const chunk of chunks) chunk.fill(0);
      resolve(value);
    });
  });
}

function status(value: string): CredentialStatus {
  try {
    const parsed = JSON.parse(value) as CredentialStatus;
    if (typeof parsed.configured !== "boolean" || typeof parsed.protection !== "string" || typeof parsed.path !== "string") throw new Error();
    return parsed;
  } catch { throw new CredentialError("INVALID_CREDENTIAL_STATUS"); }
}

export async function importDeepSeekCredentialFromClipboard(): Promise<CredentialStatus> {
  return status(await credentialOperation("ImportClipboard"));
}

export async function deepSeekCredentialStatus(): Promise<CredentialStatus> {
  return status(await credentialOperation("Status"));
}

/** Secret return value is solely for the trusted outbound adapter, never a model/tool result. */
export async function loadDeepSeekApiKey(): Promise<string> {
  const value = await credentialOperation("Read");
  if (!/^sk-[A-Za-z0-9_-]{16,256}$/.test(value)) throw new CredentialError("INVALID_CREDENTIAL_FORMAT");
  return value;
}
