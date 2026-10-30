import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * MCP adapter 的协议级测试：真的起一个子进程，按 MCP 的报文样式一问一答。
 * 目的不是测我们自己，而是证明"任何 MCP 客户端照这个格式说话就能用"。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const root = path.resolve(".demo/mcp");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
for (const f of ["a.txt", "b.jpg", "c.jpg"]) fs.writeFileSync(path.join(root, f), f);

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (rel.startsWith(".deskshell")) continue;
      if (e.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(abs);
      } else out[rel] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 12);
    }
  };
  walk(dir);
  return out;
}

const before = snapshot(root);

const server = spawn(process.execPath, [path.resolve("packages/mcp/server.ts")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map<number, (v: Record<string, unknown>) => void>();
server.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolve(msg.result ?? { error: msg.error });
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
});

let nextId = 1;
function call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20_000);
    pending.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method: string): void {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

type ToolResult = { content?: Array<{ type: string; text: string }>; isError?: boolean };
const payload = (r: ToolResult): Record<string, unknown> =>
  JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>;

try {
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  check("initialize 返回 serverInfo.name = deskshell", (init.serverInfo as { name?: string } | undefined)?.name === "deskshell", JSON.stringify(init.serverInfo));

  notify("notifications/initialized");

  const list = (await call("tools/list")) as { tools?: Array<{ name: string; inputSchema?: unknown }> };
  const names = (list.tools ?? []).map((t) => t.name);
  check("tools/list 给出四个 tool", names.length === 4, names.join(","));
  check(
    "每个 tool 都带 inputSchema",
    (list.tools ?? []).every((t) => Boolean(t.inputSchema)),
  );

  const skills = payload((await call("tools/call", { name: "deskshell_skills", arguments: {} })) as ToolResult);
  check("deskshell_skills 能列出技能", Array.isArray(skills.skills) && (skills.skills as unknown[]).length >= 10, String((skills.skills as unknown[])?.length));

  const preview = (await call("tools/call", {
    name: "deskshell_preview",
    arguments: { skill: "downloads-cleanup", root },
  })) as ToolResult;
  const previewData = payload(preview);
  check("preview 返回步骤", Array.isArray(previewData.steps) && (previewData.steps as unknown[]).length > 0, String((previewData.steps as unknown[])?.length));
  check("preview 返回能力申请单", Array.isArray(previewData.capabilities));
  check("preview 之后目录没变", JSON.stringify(snapshot(root)) === JSON.stringify(before));

  const apply = (await call("tools/call", {
    name: "deskshell_apply",
    arguments: { skill: "downloads-cleanup", root },
  })) as ToolResult;
  const applyData = payload(apply);
  check("apply 返回 taskId", typeof applyData.taskId === "string" && (applyData.taskId as string).startsWith("task-"), String(applyData.taskId));
  check("apply 真的动了目录", JSON.stringify(snapshot(root)) !== JSON.stringify(before));

  const undo = (await call("tools/call", {
    name: "deskshell_undo",
    arguments: { root, taskId: applyData.taskId },
  })) as ToolResult;
  const undoData = payload(undo);
  check("undo 回滚了步数", Number(undoData.rolledBack) > 0, String(undoData.rolledBack));
  check("undo 之后目录逐字节回到原状", JSON.stringify(snapshot(root)) === JSON.stringify(before));

  const noTask = (await call("tools/call", { name: "deskshell_undo", arguments: { root } })) as ToolResult;
  check("没有可撤销任务时给明确说明而不是报错", String(payload(noTask).detail ?? "").includes("没有可撤销") || Number(payload(noTask).rolledBack) === 0);

  const bad = (await call("tools/call", { name: "deskshell_apply", arguments: { skill: "no-such", root } })) as ToolResult;
  check("未知技能返回 isError=true", bad.isError === true);
  check("未知技能的错误里列出可用技能", (bad.content?.[0]?.text ?? "").includes("downloads-cleanup"));
} finally {
  server.stdin.end();
  server.kill();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
