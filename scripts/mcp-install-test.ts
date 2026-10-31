import fs from "node:fs";
import path from "node:path";
import { install, plan } from "../apps/mcp/install.ts";

/**
 * `deskshell mcp install` 的契约：
 *   1. 写进指定 home（--home 必须生效，绝不能碰真实用户目录）
 *   2. 合并已有的 mcpServers，不动别人的 server
 *   3. 原文件有内容就备份
 *   4. 重复安装是幂等的（changed=false）
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const base = path.resolve(".demo/mcp-install");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });

// ① 空 home：新建配置，且指向真实存在的 server.ts
{
  const home = path.join(base, "fresh");
  fs.mkdirSync(home, { recursive: true });
  const r = install("claude", home);
  check("新建了 claude 配置", fs.existsSync(r.file), r.file);
  const json = JSON.parse(fs.readFileSync(r.file, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  check("mcpServers 里有 deskshell", Boolean(json.mcpServers.deskshell));
  const target = json.mcpServers.deskshell.args[0];
  check("指向真实存在的 server.ts", fs.existsSync(target), target);
  check("command 用的是当前 node", json.mcpServers.deskshell.command === process.execPath);
  check("首次安装没有备份（原来没有文件）", r.backup === undefined);
  check("路径在传入的 home 下面（没碰真实目录）", r.file.startsWith(home), r.file);
}

// ② 已有别的 server：合并、不动别人、留备份
{
  const home = path.join(base, "merge");
  const file = plan("claude", home).file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = {
    mcpServers: { other: { command: "other-bin", args: ["x"] } },
    theme: "dark",
  };
  fs.writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`, "utf8");

  const r = install("claude", home);
  const json = JSON.parse(fs.readFileSync(r.file, "utf8")) as {
    mcpServers: Record<string, unknown>;
    theme?: string;
  };
  check("保留了别人的 server", Boolean(json.mcpServers.other));
  check("保留了无关字段", json.theme === "dark");
  check("加上了 deskshell", Boolean(json.mcpServers.deskshell));
  check("原文件已备份", Boolean(r.backup) && fs.existsSync(r.backup!));
}

// ③ 幂等：再装一次，什么都不变
{
  const home = path.join(base, "merge");
  const before = fs.readFileSync(plan("claude", home).file, "utf8");
  const r = install("claude", home);
  const after = fs.readFileSync(plan("claude", home).file, "utf8");
  check("重复安装不改变文件", before === after && r.changed === false);
}

// ④ cursor 用不同路径
{
  const home = path.join(base, "cursor");
  fs.mkdirSync(home, { recursive: true });
  const r = install("cursor", home);
  check("cursor 写到 .cursor/mcp.json", r.file.endsWith(path.join(".cursor", "mcp.json")), r.file);
  check("cursor 配置也能读回 deskshell", fs.readFileSync(r.file, "utf8").includes("deskshell"));
}

// ⑤ 坏 JSON：明确报错，不覆盖用户配置
{
  const home = path.join(base, "broken");
  const file = plan("claude", home).file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json", "utf8");
  let message = "";
  try {
    install("claude", home);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check("坏 JSON 会报错", /不是合法 JSON/.test(message), message.slice(0, 60));
  check("坏 JSON 不被覆盖", fs.readFileSync(file, "utf8") === "{ this is not json");
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
