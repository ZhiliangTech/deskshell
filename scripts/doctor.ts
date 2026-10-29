import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateManifest } from "../packages/core/src/manifest.ts";

type Status = "PASS" | "WARN" | "FAIL";

interface Row {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

const rows: Row[] = [];
const add = (name: string, status: Status, detail: string, hint?: string): void => {
  rows.push({ name, status, detail, hint });
};

// 1) Node 版本
const major = Number(process.versions.node.split(".")[0]);
add(
  "node",
  major >= 22 ? "PASS" : "FAIL",
  `v${process.versions.node}`,
  major >= 22 ? undefined : "需要 Node 22+（TS 类型剥离与内置 test runner）",
);

// 2) 平台与驱动
const platform = process.platform;
const hasDriver = platform === "win32" || platform === "darwin";
add(
  "platform",
  hasDriver ? "PASS" : "WARN",
  platform,
  hasDriver ? undefined : "Linux 驱动（AT-SPI2）尚未实现，文件类 skill 仍可用",
);

// 3) 驱动冒烟（只读：枚举窗口）
let windowCount = 0;
if (hasDriver) {
  try {
    const t0 = Date.now();
    const mod =
      platform === "win32"
        ? await import("../packages/drivers/windows/driver.ts")
        : await import("../packages/drivers/macos/driver.ts");
    const driver = platform === "win32" ? new mod.WindowsDriver() : new mod.MacDriver();
    const wins = await driver.windows();
    windowCount = wins.length;
    add("driver", windowCount > 0 ? "PASS" : "WARN", `${windowCount} 个窗口，${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      platform === "darwin"
        ? "macOS 需要「系统设置 → 隐私与安全性 → 辅助功能」给终端授权（错误码 -1719 即未授权）"
        : "确认终端有桌面会话（远程会话/服务账户可能读不到窗口）";
    add("driver", "FAIL", msg.slice(0, 120), hint);
  }
} else {
  add("driver", "WARN", "跳过（无实现）");
}

// 4) 辅助功能权限（macOS 单独探测）
if (platform === "darwin") {
  try {
    const out = execFileSync("osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ], { encoding: "utf8", timeout: 8000 }).trim();
    add("accessibility", "PASS", `前台应用：${out}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    add("accessibility", "FAIL", msg.split("\n")[0].slice(0, 120), "给终端/iTerm 勾选辅助功能权限后重试");
  }
}

// 5) skill 清单合法性
const skillsDir = path.resolve("packages/skills");
const bad: string[] = [];
let count = 0;
if (fs.existsSync(skillsDir)) {
  for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(skillsDir, d.name, "skill.json");
    if (!fs.existsSync(f)) continue;
    count++;
    const check = validateManifest(JSON.parse(fs.readFileSync(f, "utf8")));
    if (!check.ok) bad.push(`${d.name}: ${check.problems.map((p) => p.field).join(",")}`);
  }
}
add(
  "skills",
  bad.length === 0 ? "PASS" : "FAIL",
  `${count} 个 skill，${bad.length} 个不合规`,
  bad.length ? bad.join("; ") : undefined,
);

// 6) 工作目录可写
const probe = path.resolve(".demo/doctor");
try {
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "probe.txt"), "ok");
  fs.rmSync(probe, { recursive: true, force: true });
  add("workspace", "PASS", "可写");
} catch (err) {
  add("workspace", "FAIL", err instanceof Error ? err.message.slice(0, 80) : "不可写", "检查目录权限或换一个工作目录");
}

// 7) 文档站与快照是否就位（提示性）
add("docs", fs.existsSync("scripts/build-docs.ts") ? "PASS" : "WARN", "构建脚本就位");
add("snapshots", fs.existsSync("snapshots") ? "PASS" : "WARN", "快照目录就位");

const wantJson = process.argv.includes("--json");

if (wantJson) {
  const failed = rows.filter((r) => r.status === "FAIL").length;
  const warned = rows.filter((r) => r.status === "WARN").length;
  console.log(
    JSON.stringify({
      ok: failed === 0,
      platform,
      node: process.versions.node,
      passed: rows.length - failed - warned,
      warning: warned,
      failed,
      checks: rows,
    }),
  );
} else {
  for (const r of rows) {
    console.log(`${r.status.padEnd(4)} ${r.name.padEnd(14)} ${r.detail}`);
    if (r.hint) console.log(`     ↳ ${r.hint}`);
  }

  const failed = rows.filter((r) => r.status === "FAIL").length;
  const warned = rows.filter((r) => r.status === "WARN").length;
  console.log(`\n${rows.length - failed - warned} passed, ${warned} warning, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

if (wantJson) {
  const failed = rows.filter((r) => r.status === "FAIL").length;
  process.exitCode = failed ? 1 : 0;
}
