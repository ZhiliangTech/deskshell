import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 deskshell 挂进 MCP 客户端的配置里。
 *
 * 做的事很小但很容易做错：读现有 json → 只加/更新 `mcpServers.deskshell`
 * → 备份原文件 → 写回。**不碰**别人的其它 server。
 *
 *   deskshell mcp install --client claude|cursor [--print] [--home DIR]
 */

export type ClientKind = "claude" | "cursor";

export interface InstallResult {
  file: string;
  backup?: string;
  servers: string[];
  changed: boolean;
}

const SERVER_KEY = "deskshell";

function configPath(client: ClientKind, home: string): string {
  if (client === "claude") {
    // Windows: %APPDATA%\Claude\claude_desktop_config.json
    // macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
    if (process.platform === "win32") {
      // 只用传入的 home 推导：APPDATA 会让 --home 失效，从而写进真实用户目录
      return path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    }
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  // cursor：项目级 .cursor/mcp.json 更常用，但这里写全局，避免依赖 cwd
  return path.join(home, ".cursor", "mcp.json");
}

function serverEntry(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, "..", "..");
  return { command: process.execPath, args: [path.join(repo, "packages", "mcp", "server.ts")] };
}

export function plan(client: ClientKind, home = os.homedir()): { file: string; json: string; servers: string[] } {
  const file = configPath(client, home);
  let current: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`现有配置不是合法 JSON，先手工修一下：${file}`);
    }
  }
  const servers = { ...((current.mcpServers as Record<string, unknown>) ?? {}) };
  servers[SERVER_KEY] = serverEntry();
  const next = { ...current, mcpServers: servers };
  return { file, json: `${JSON.stringify(next, null, 2)}\n`, servers: Object.keys(servers) };
}

export function install(client: ClientKind, home = os.homedir()): InstallResult {
  const { file, json, servers } = plan(client, home);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === json) return { file, servers, changed: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (before !== null) {
    backup = `${file}.bak-${Date.now()}`;
    fs.writeFileSync(backup, before, "utf8");
  }
  fs.writeFileSync(file, json, "utf8");
  return { file, backup, servers, changed: true };
}


/**
 * 客户端是不是真的装了？
 *
 * 往一个不存在的客户端目录里写配置不会报错，只会让人以为"配好了"然后什么也没发生。
 * 所以先看一眼：目录或可执行文件在不在。判断不了就返回 unknown，不拦。
 */
export function clientPresent(client: ClientKind, home = os.homedir()): "yes" | "no" {
  const dir =
    client === "claude"
      ? process.platform === "win32"
        ? path.join(home, "AppData", "Roaming", "Claude")
        : path.join(home, "Library", "Application Support", "Claude")
      : path.join(home, ".cursor");
  return fs.existsSync(dir) ? "yes" : "no";
}

/** 给测试用：只在临时 home 里跑，不碰真实客户端配置 */
export function homeForTest(base: string): string {
  fs.mkdirSync(base, { recursive: true });
  return base;
}
