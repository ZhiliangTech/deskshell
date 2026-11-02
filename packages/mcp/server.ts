import fs from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run, undoTask } from "../core/src/kernel.ts";
import { load } from "../core/src/journal.ts";
import type { CapabilityId, Skill, SkillContext, UiDriver } from "../core/src/types.ts";
import { createPlatformDriver, needsUiDriver } from "../drivers/platform.ts";

/** 版本只有一个来源：package.json。找不到就明说不知道，别编。 */
function serverVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../package.json", "../package.json", "./package.json"]) {
      const candidate = path.resolve(here, rel);
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    /* 落到 unknown */
  }
  return "unknown";
}

/**
 * MCP adapter：把内核包成四个 tool，任何 MCP 客户端（Claude Desktop / Cursor /
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

function listSkills(userSkillsDir: string): SkillRef[] {
  const scan = (root: string): SkillRef[] => {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "skill.json")))
      .map((d) => {
        const m = JSON.parse(fs.readFileSync(path.join(root, d.name, "skill.json"), "utf8")) as {
          name: string;
          description: string;
          internal?: boolean;
          capabilities?: Array<{ id: string; reason: string }>;
        };
        return {
          name: m.name,
          dir: path.join(root, d.name),
          description: m.description,
          capabilities: m.capabilities ?? [],
          internal: m.internal === true,
        };
      });
  };
  // 和 CLI 一致：通过 add/new 安装的技能可见，用户版本覆盖同名内置版本。
  const user = scan(userSkillsDir);
  const builtin = scan(BUILTIN).filter((s) => !user.some((u) => u.name === s.name));
  return [...user, ...builtin].filter((s) => !s.internal).sort((a, b) => a.name.localeCompare(b.name));
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

interface ToolContext {
  userSkillsDir: string;
  getDriver(): Promise<UiDriver>;
}

async function callTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  if (name === "deskshell_skills") {
    return { skills: listSkills(context.userSkillsDir).map((s) => ({ name: s.name, description: s.description })) };
  }

  const root = path.resolve(String(args.root ?? "."));
  const journalPath = path.join(root, ".deskshell", "journal.jsonl");

  if (name === "deskshell_undo") {
    const entries = load(journalPath);
    const explicit = typeof args.taskId === "string" ? args.taskId : undefined;
    let taskId = explicit;
    if (!taskId) {
      const done = entries.filter((e) => e.status === "ok");
      if (done.length === 0) return { rolledBack: 0, detail: "没有可撤销的任务" };
      taskId = done[done.length - 1].taskId;
    }
    const needsDriver = entries.some((e) =>
      e.taskId === taskId && e.status === "ok" && (e.undo?.kind === "window.move" || e.undo?.kind === "ui.value"),
    );
    const ctx: SkillContext = needsDriver ? { driver: await context.getDriver() } : {};
    const undone = await undoTask(taskId, { mode: "undo", root, granted: [], journalPath }, ctx);
    return { taskId, rolledBack: undone.rolledBack, steps: undone.steps };
  }

  const skills = listSkills(context.userSkillsDir);
  const ref = skills.find((s) => s.name === String(args.skill));
  if (!ref) {
    throw new Error(`没有这个技能：${String(args.skill)}。可用：${skills.map((s) => s.name).join(", ")}`);
  }
  const skill = await loadSkill(ref);
  const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
  const input = { root, ...((args.args as Record<string, unknown>) ?? {}) };
  const ctx: SkillContext = needsUiDriver(granted) ? { driver: await context.getDriver() } : {};

  if (name === "deskshell_preview") {
    const report = await run(skill, input, { mode: "preview", root, granted, journalPath }, ctx);
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
      ctx,
    );
    return { skill: ref.name, taskId: report.taskId, steps: report.steps, rolledBack: report.rolledBack };
  }

  throw new Error(`未知工具：${name}`);
}

export interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  /** 供嵌入及测试注入；stdio 入口始终使用真实平台工厂。 */
  createDriver?: () => Promise<UiDriver>;
  userSkillsDir?: string;
}

export function startServer(options: McpServerOptions = {}) {
  const output = options.output ?? process.stdout;
  let driver: Promise<UiDriver> | undefined;
  const context: ToolContext = {
    userSkillsDir: options.userSkillsDir ?? process.env.DESKSHELL_SKILLS_DIR ?? path.join(os.homedir(), ".deskshell", "skills"),
    getDriver: () => driver ??= (options.createDriver ?? createPlatformDriver)(),
  };
  function reply(id: number | string | undefined, result: unknown): void {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
  function replyError(id: number | string | undefined, code: number, message: string): void {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }

  const rl = createInterface({ input: options.input ?? process.stdin });

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
    // `null`、`123`、`"x"` 都是合法 JSON 但不是请求：以前直接解引用 req.method，
    // 一个 null 就让服务进程带着 TypeError 退出（客户端看到的是崩溃而不是错误码）。
    if (req === null || typeof req !== "object" || Array.isArray(req)) {
      replyError(undefined, -32600, "无效请求：需要 JSON 对象");
      return;
    }

    try {
      switch (req.method) {
        case "initialize":
          reply(req.id, {
            protocolVersion: (req.params?.protocolVersion as string) ?? "2024-11-05",
            capabilities: { tools: {} },
            // 版本从 package.json 读：写死过一次（0.13.0 挂了五个版本没人发现）
            serverInfo: { name: "deskshell", version: serverVersion() },
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
          const result = await callTool(name, args, context);
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
  return rl;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
