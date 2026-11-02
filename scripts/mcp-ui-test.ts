import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { startServer } from "../packages/mcp/server.ts";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import { createPlatformDriver } from "../packages/drivers/platform.ts";
import type { UiDriver } from "../packages/core/src/types.ts";

/** 使用真实 JSON-RPC 处理链和内存桌面；所有文件夹具都在独立临时目录。 */
const checks: string[] = [];
function check(name: string, ok: boolean): void {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
}

const tempRoot = path.resolve(os.tmpdir());
const base = fs.mkdtempSync(path.join(tempRoot, "deskshell-mcp-ui-"));
const root = path.join(base, "files");
const userSkillsDir = path.join(base, "skills");
fs.mkdirSync(root);
fs.mkdirSync(userSkillsDir);
fs.writeFileSync(path.join(root, "a.txt"), "original");

function fixture(name: string, description: string, capabilities: unknown[], plan: string, internal = false): void {
  const dir = path.join(userSkillsDir, name);
  fs.mkdirSync(dir);
  const manifest = { name, version: "0.0.0", description, entry: "./index.ts", capabilities, internal };
  fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "index.ts"),
    `import path from "node:path";\nexport const skill = { manifest: ${JSON.stringify(manifest)}, async plan(input, ctx) { ${plan} } };\n`);
}

fixture("user-ui", "用户 UI 技能", [
  { id: "ui.read", scope: ".*", reason: "读原值用于撤销" },
  { id: "ui.input", scope: ".*", reason: "验证控件输入" },
], `
  const selector = { automationId: "editor" };
  const before = (await ctx.driver.tree({ titleRegex: "Mock Window" })).children[0].value;
  return [{ id: "type", kind: "ui.type", window: "Mock Window", selector, text: "changed",
    post: [{ kind: "ui.value", window: "Mock Window", selector, equals: "changed" }],
    undo: { kind: "ui.value", window: "Mock Window", selector, value: before } }];
`);
fixture("photo-sort", "用户覆盖版本", [{ id: "fs.write", scope: "{{root}}", reason: "验证用户版本优先" }], `
  const target = path.join(input.root, "user.txt");
  return [{ id: "user-override", kind: "fs.write", path: target, content: "user",
    post: [{ kind: "path.exists", path: target }], undo: { kind: "fs.restore", path: target, content: null } }];
`);
fixture("hidden-user", "内部技能", [], "return [];", true);

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Payload = {
  skills?: Array<{ name: string; description: string }>;
  summary?: { total: number; window: number; write: number };
  taskId?: string;
  rolledBack?: number;
  steps?: Array<{ actionId: string; status: string }>;
};

function connect(createDriver: () => Promise<UiDriver>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = startServer({ input, output, createDriver, userSkillsDir });
  const pending = new Map<number, (result: ToolResult) => void>();
  let nextId = 0;
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const response = JSON.parse(buffer.slice(0, end)) as { id: number; result: ToolResult };
      buffer = buffer.slice(end + 1);
      pending.get(response.id)?.(response.result);
      pending.delete(response.id);
    }
  });
  return {
    async call(name: string, args: Record<string, unknown> = {}): Promise<Payload> {
      const id = ++nextId;
      const response = await new Promise<ToolResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name} 超时`));
        }, 5000);
        pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
      if (response.isError) throw new Error(response.content[0].text);
      return JSON.parse(response.content[0].text) as Payload;
    },
    close() { server.close(); input.destroy(); output.destroy(); },
  };
}

const driver = new MockDriver();
const original = JSON.stringify(driver.windowsData);
let creations = 0;
const createDriver = async () => { creations++; return driver; };
let client = connect(createDriver);

try {
  const listed = (await client.call("deskshell_skills")).skills ?? [];
  check("MCP 列出用户安装的技能", listed.some((s) => s.name === "user-ui"));
  check("用户同名技能覆盖内置技能且不重复", listed.filter((s) => s.name === "photo-sort").length === 1 &&
    listed.find((s) => s.name === "photo-sort")?.description === "用户覆盖版本");
  check("用户内部技能不出现在公开列表", !listed.some((s) => s.name === "hidden-user"));
  const override = await client.call("deskshell_preview", { skill: "photo-sort", root });
  check("MCP 调用用户覆盖版本", override.steps?.[0]?.actionId === "user-override");

  const filePreview = await client.call("deskshell_preview", { skill: "downloads-cleanup", root });
  check("纯文件预览正常且不加载桌面驱动", Number(filePreview.summary?.total) > 0 && creations === 0);
  const fileApply = await client.call("deskshell_apply", { skill: "downloads-cleanup", root });
  const fileUndo = await client.call("deskshell_undo", { root, taskId: fileApply.taskId });
  check("纯文件执行和撤销无需桌面驱动", Number(fileUndo.rolledBack) > 0 && creations === 0 &&
    fs.readFileSync(path.join(root, "a.txt"), "utf8") === "original");

  const preview = await client.call("deskshell_preview", { skill: "tile-windows", root });
  check("MCP 桌面预览得到窗口步骤", preview.summary?.window === 1 && creations === 1);
  check("窗口预览没有移动窗口", JSON.stringify(driver.windowsData) === original &&
    !driver.calls.some((call) => call.startsWith("moveWindow:")));
  const applied = await client.call("deskshell_apply", { skill: "tile-windows", root });
  check("MCP 桌面执行改变 Mock 窗口", applied.steps?.every((s) => s.status === "ok") === true &&
    JSON.stringify(driver.windowsData) !== original);
  check("同一 MCP 服务复用驱动", creations === 1);

  // 新连接没有运行过任何 skill，必须仅凭日志为 undo 注入 driver。
  client.close();
  client = connect(createDriver);
  const undone = await client.call("deskshell_undo", { root, taskId: applied.taskId });
  check("新 MCP 服务可按 taskId 撤销窗口动作", undone.rolledBack === 1 && creations === 2 &&
    JSON.stringify(driver.windowsData) === original);

  const tabs = await client.call("deskshell_preview", { skill: "browser-tabs", root });
  check("browser-tabs 预览获得 UI 驱动", tabs.summary?.write === 1 && driver.calls.some((call) => call === "tree:Edge"));
  check("browser-tabs 预览不写归档文件", !fs.readdirSync(root).some((name) => name.startsWith("tabs-")));

  const typed = await client.call("deskshell_apply", { skill: "user-ui", root });
  check("用户 UI 技能执行并通过后置断言", typed.steps?.[0]?.status === "ok" && driver.treeData.children[0].value === "changed");
  client.close();
  client = connect(createDriver);
  const untyped = await client.call("deskshell_undo", { root });
  check("省略 taskId 时撤销最近的控件输入", untyped.taskId === typed.taskId && untyped.rolledBack === 1 &&
    driver.treeData.children[0].value === "" && creations === 3);

  client.close();
  client = connect(async () => { throw new Error("已撤销任务不应初始化驱动"); });
  const repeated = await client.call("deskshell_undo", { root, taskId: typed.taskId });
  check("重复撤销保持幂等且不加载驱动", repeated.rolledBack === 0);

  // 只实例化无构造副作用的 Windows/macOS 驱动，不调用任何系统操作。
  check("共享工厂支持 Windows", (await createPlatformDriver("win32")).constructor.name === "WindowsDriver");
  check("共享工厂支持 macOS", (await createPlatformDriver("darwin")).constructor.name === "MacDriver");
  let unsupported = false;
  try { await createPlatformDriver("aix"); } catch { unsupported = true; }
  check("不支持的平台明确报错", unsupported);
} finally {
  client.close();
  // 仅清理由本脚本创建的独立临时目录。
  const resolved = path.resolve(base);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("deskshell-mcp-ui-")) {
    throw new Error(`拒绝清理意外路径：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  console.log(checks.join("\n"));
  console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
}
