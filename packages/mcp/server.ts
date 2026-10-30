import fs from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, undoTask } from "../core/src/kernel.ts";
import { load } from "../core/src/journal.ts";
import type { CapabilityId, Skill } from "../core/src/types.ts";

/**
 * MCP adapter：把内核包成三个 tool，任何 MCP 客户端（Claude Desktop / Cursor /
 * 自研运行时）都能直接调，不需要读我们的文档。
 *
 * 手写 stdio JSON-RPC（每行一条消息），不引第三方依赖——这样"零依赖内核"
 * 这句话在接入层也成立。
 *
 *   node packages/mcp/server.ts
 *
 * 工具：
 *   deskshell_skills   列出可用技能
 *   deskshell_preview  只读预览：返回能力申请单 + 步骤 + 汇总
 *   deskshell_apply    执行，返回 taskId 与步数
 *   deskshell_undo     撤销一个 taskId，或撤销 root 下最近一单
 */

const HERE = path.resolve(import.meta.dirname, "..", "..");
const BUILTIN = path.join(HERE, "packages", "skills");

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface SkillRef {
  name: string;
  dir: string;
  description: string;
  capabilities: Array<{ id: string; reason: string }>;
  internal: boolean;
}

function listSkills(): SkillRef[] {
  if (!fs.existsSync(BUILTIN)) return [];
  return fs
    .readdirSync(BUILTIN, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(BUILTIN, d.name, "skill.json")))
    .map((d) => {
      const m = JSON.parse(fs.readFileSync(path.join(BUILTIN, d.name, "skill.json"), "utf8")) as {
        name: string;
        description: string;
        internal?: boolean;
        capabilities?: Array<{ id: string; reason: string }>;
      };
      return { name: m.name, dir: path.join(BUILTIN, d.name), description: m.description, capabilities: m.capabilities ?? [], internal: m.internal === true } as SkillRef & { internal: boolean };
    })
    .filter((s) => !s.internal);
}

async function loadSkill(ref: SkillRef): Promise<Skill> {
  const mod = (await import(pathToFileURL(path.join(ref.dir, "index.ts")).href)) as {
    skill?: Skill;
    default?: Skill;
  };
  const s = mod.skill ?? mod.default;
  if (!s) throw new Error(`${ref.name} 没有导出 skill`);
  return s;
}

const TOOLS = [
  {
    name: "deskshell_skills",
    description: "列出已安装的 deskshell 技能（文件名、描述、需要的能力）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deskshell_preview",
    description: "只读预览一个技能要在 root 上做什么：能力申请单、每一步、汇总。不产生任何副作用。",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "技能名，例如 downloads-cleanup" },
        root: { type: "string", description: "要处理的目录（绝对路径或相对当前目录）" },
        args: { type: "object", description: "传给技能的参数，可省略" },
      },
      required: ["skill", "root"],
      additionalProperties: false,
    },
  },
  {
    name: "deskshell_apply",
    description: "执行技能。返回 taskId；失败会自动回滚并把失败写进日志。",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        root: { type: "string" },
        args: { type: "object" },
        allowIrreversible: { type: "boolean", description: "显式允许执行不可逆动作（例如按下按钮）" },
      },
      required: ["skill", "root"],
      additionalProperties: false,
    },
  },
  {
    name: "deskshell_undo",
    description: "撤销。给 taskId 撤销那一单；不给就撤销 root 下最近一单。",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["root"],
      additionalProperties: false,
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "deskshell_skills") {
    return { skills: listSkills().map((s) => ({ name: s.name, description: s.description })) };
  }

  const root = path.resolve(String(args.root ?? "."));
  const journalPath = path.join(root, ".deskshell", "journal.jsonl");

  if (name === "deskshell_undo") {
    const explicit = typeof args.taskId === "string" ? args.taskId : undefined;
    let taskId = explicit;
    if (!taskId) {
      const done = load(journalPath).filter((e) => e.status === "ok");
      if (done.length === 0) return { rolledBack: 0, detail: "没有可撤销的任务" };
      taskId = done[done.length - 1].taskId;
    }
    const undone = await undoTask(taskId, { mode: "undo", root, granted: [], journalPath }, {});
    return { taskId, rolledBack: undone.rolledBack, steps: undone.steps };
  }

  const ref = listSkills().find((s) => s.name === String(args.skill));
  if (!ref) {
    throw new Error(`没有这个技能：${String(args.skill)}。可用：${listSkills().map((s) => s.name).join(", ")}`);
  }
  const skill = await loadSkill(ref);
  const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
  const input = { root, ...((args.args as Record<string, unknown>) ?? {}) };

  if (name === "deskshell_preview") {
    const report = await run(skill, input, { mode: "preview", root, granted, journalPath }, {});
    return {
      skill: ref.name,
      capabilities: skill.manifest.capabilities.map((c) => ({ id: c.id, reason: c.reason })),
      steps: report.steps,
      summary: report.summary,
    };
  }

  if (name === "deskshell_apply") {
    const report = await run(
      skill,
      input,
      { mode: "apply", root, granted, journalPath, allowIrreversible: args.allowIrreversible === true },
      {},
    );
    return { skill: ref.name, taskId: report.taskId, steps: report.steps, rolledBack: report.rolledBack };
  }

  throw new Error(`未知工具：${name}`);
}

function reply(id: number | string | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(text) as RpcRequest;
  } catch {
    replyError(undefined, -32700, "解析失败：不是合法 JSON");
    return;
  }

  try {
    switch (req.method) {
      case "initialize":
        reply(req.id, {
          protocolVersion: (req.params?.protocolVersion as string) ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "deskshell", version: "0.13.0" },
        });
        return;
      case "notifications/initialized":
        return; // 通知不需要回应
      case "tools/list":
        reply(req.id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = String((req.params?.name as string) ?? "");
        const args = ((req.params?.arguments as Record<string, unknown>) ?? {}) as Record<string, unknown>;
        const result = await callTool(name, args);
        reply(req.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
        return;
      }
      case "ping":
        reply(req.id, {});
        return;
      default:
        replyError(req.id, -32601, `不支持的方法：${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply(req.id, { content: [{ type: "text", text: message }], isError: true });
  }
});
