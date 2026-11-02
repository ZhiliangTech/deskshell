import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runActions } from "../../core/src/kernel.ts";
import type { Action } from "../../core/src/types.ts";

/**
 * Relay —— AI 的输入输出总线（不是又一个聊天框）。
 *
 * 它只做四件事，这四件事就是产品本体，模型是可替换的一端：
 *   1. 拿一段材料（文件 / stdin / 将来的选区）；
 *   2. 生成**外发清单**：发给谁、多少字节、摘要是什么——清单里不出现绝对路径；
 *   3. 把结果**写回真实文件**，走内核，所以可撤销、有账本；
 *   4. 全程默认不问（因为可撤），只有不可逆动作才问一次。
 *
 * 与"划词问答"类产品的结构差别：它们给你一个气泡，我们给你一个可撤销的落盘结果 + 一份账。
 */

export interface RelayUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface RelayBackend {
  /** 稳定标识，写进外发清单与账本 */
  readonly id: string;
  readonly vendor: string;
  readonly model?: string;
  complete(input: { prompt: string; text: string; signal?: AbortSignal }): Promise<{ text: string; usage?: RelayUsage }>;
}

export interface RelayManifest {
  backend: string;
  vendor: string;
  model?: string;
  /** 只描述"选中的是什么"，例如文件名；绝不带绝对路径 */
  label: string;
  inputBytes: number;
  inputDigest: string;
  promptDigest: string;
  outPath?: string;
  sends: Array<{ kind: "selection-text" | "prompt"; bytes: number; digest: string }>;
}

export interface RelayRequest {
  text: string;
  prompt?: string;
  /** 用于清单的可读标签，默认 "(selection)"；必须是名字，不是路径 */
  label?: string;
  backend: RelayBackend;
  /** 不传则只返回结果，不写文件 */
  outPath?: string;
  /** 写文件时的作用域根；缺省取 outPath 所在目录 */
  root?: string;
  journalPath?: string;
  signal?: AbortSignal;
  /** 只生成清单，不调用后端、不写文件 */
  dryRun?: boolean;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface RelayResult {
  manifest: RelayManifest;
  output: string;
  usage?: RelayUsage;
  written?: { path: string; taskId?: string; previous: string | null };
}

const DIGEST = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const BYTES = (text: string): number => Buffer.byteLength(text, "utf8");
const DEFAULT_MAX_INPUT = 1024 * 1024;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export class RelayError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

function readPrevious(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new RelayError("OUTPUT_NOT_A_FILE", `输出位置不是普通文件：${file}`);
  if (stat.size > 16 * 1024 * 1024) throw new RelayError("OUTPUT_TOO_LARGE");
  return fs.readFileSync(file, "utf8");
}

/** 外发清单：任何要离开本机的内容，都要能在这里被一眼看清 */
export function buildManifest(request: {
  backend: RelayBackend;
  text: string;
  prompt: string;
  label: string;
  outPath?: string;
}): RelayManifest {
  const sends: RelayManifest["sends"] = [
    { kind: "selection-text", bytes: BYTES(request.text), digest: DIGEST(request.text) },
  ];
  if (request.prompt.trim().length > 0) {
    sends.push({ kind: "prompt", bytes: BYTES(request.prompt), digest: DIGEST(request.prompt) });
  }
  return {
    backend: request.backend.id,
    vendor: request.backend.vendor,
    ...(request.backend.model ? { model: request.backend.model } : {}),
    label: request.label,
    inputBytes: BYTES(request.text),
    inputDigest: DIGEST(request.text),
    promptDigest: DIGEST(request.prompt),
    ...(request.outPath ? { outPath: request.outPath } : {}),
    sends,
  };
}

/**
 * 执行一次中转。写文件走内核的 runActions：
 * —— 结果因此进账本、可撤销；这不是"额外功能"，这是它敢直接写真实文件的原因。
 */
export async function runRelay(request: RelayRequest): Promise<RelayResult> {
  if (typeof request.text !== "string" || request.text.trim().length === 0) {
    throw new RelayError("EMPTY_INPUT", "没有可发送的材料");
  }
  const maxInput = request.maxInputBytes ?? DEFAULT_MAX_INPUT;
  if (BYTES(request.text) > maxInput) throw new RelayError("INPUT_TOO_LARGE", `输入超过 ${maxInput} 字节`);
  if (request.outPath !== undefined && path.resolve(request.outPath) === path.resolve("/")) {
    throw new RelayError("INVALID_OUTPUT");
  }

  const prompt = request.prompt ?? "";
  const label = request.label ?? "(selection)";
  if (label.includes("/") || label.includes("\\")) throw new RelayError("INVALID_LABEL", "清单标签只能是名字，不能是路径");
  const outPath = request.outPath ? path.resolve(request.outPath) : undefined;
  const manifest = buildManifest({ backend: request.backend, text: request.text, prompt, label, outPath });

  if (request.dryRun) return { manifest, output: "" };
  if (request.signal?.aborted) throw new RelayError("CANCELLED");

  const reply = await request.backend.complete({ prompt, text: request.text, signal: request.signal });
  const output = typeof reply.text === "string" ? reply.text : "";
  if (BYTES(output) > (request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT)) throw new RelayError("OUTPUT_TOO_LARGE");
  if (request.signal?.aborted) throw new RelayError("CANCELLED");

  if (!outPath) return { manifest, output, ...(reply.usage ? { usage: reply.usage } : {}) };

  const previous = readPrevious(outPath);
  const root = path.resolve(request.root ?? path.dirname(outPath));
  const journalPath = request.journalPath ?? path.join(root, ".deskshell", "journal.jsonl");
  const actions: Action[] = [
    {
      id: "relay-write",
      kind: "fs.write",
      path: outPath,
      content: output,
      risk: "low",
      // 覆盖是"可逆"的：原内容被记进撤销动作，撤销即逐字节还原；新文件则撤销为删除
      undo: { kind: "fs.restore", path: outPath, content: previous },
    },
  ];
  const report = await runActions(
    {
      name: "relay",
      version: "0.0.0",
      description: "把 AI 结果写回真实文件（可撤销）",
      entry: "./relay.ts",
      capabilities: [{ id: "fs.write", scope: root, reason: "把结果写回你指定的文件" }],
    },
    actions,
    { mode: "apply", root, granted: ["fs.write"], journalPath },
    {},
    { taskId: undefined },
  );

  return {
    manifest,
    output,
    ...(reply.usage ? { usage: reply.usage } : {}),
    written: { path: outPath, taskId: report.taskId, previous },
  };
}

/** 离线后端：把输入原样回显并加一行标记。确定性，用来验证管线本身。 */
export function stubBackend(options: { id?: string; marker?: string } = {}): RelayBackend {
  const id = options.id ?? "stub";
  const marker = options.marker ?? "[stub]";
  return {
    id,
    vendor: "local",
    model: "echo",
    async complete({ text }) {
      return { text: `${text.replace(/\s+$/, "")}\n\n${marker}\n` };
    },
  };
}
