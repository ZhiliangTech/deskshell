import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 桌面壳的真机自检：起一次窗口、注册热键、跑匹配/预览/取消，然后立刻退出。
 * 只有 Windows 有这套 UI；其它平台明确 skip，不假装通过。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

if (process.platform !== "win32") {
  console.log("SKIP  桌面壳 UI 自检只支持 Windows");
  console.log("0/0 passed，1 skipped");
  process.exit(0);
}

const root = path.resolve(".demo/shell-ui");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "a");
fs.writeFileSync(path.join(root, "b.jpg"), "b");

const log = path.resolve(".demo/shell-ui-selftest.log");
fs.rmSync(log, { force: true });

try {
  execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "apps/shell/ui.ps1", "-Root", root, "-SelfTest"],
    {
      encoding: "utf8",
      env: { ...process.env, DESKSHELL_SELFTEST_OUT: log, DESKSHELL_NODE: process.execPath },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (err) {
  const e = err as { stdout?: string; stderr?: string };
  console.log(`FAIL  启动 UI 自检失败 ${(e.stderr ?? "").slice(-300)}`);
  process.exitCode = 1;
}

check("自检日志已生成", fs.existsSync(log));
const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8").replace(/^\uFEFF/, "") : "";
const read = (k: string): string | null => text.match(new RegExp(`${k}=([^\r\n]*)`))?.[1] ?? null;

check("全局热键注册成功", read("SELFTEST hotkey") === "True", read("SELFTEST hotkey") ?? "缺失");
check("能列出技能", Number(read("SELFTEST skills")) >= 10, read("SELFTEST skills") ?? "缺失");
check("一句话匹配命中", read("SELFTEST match") === "downloads-cleanup", read("SELFTEST match") ?? "缺失");
check("一句话能解析成带参数的计划", read("SELFTEST plan") === "log-archive", read("SELFTEST plan") ?? "缺失");
check("计划里带着天数参数", read("SELFTEST planDays") === "30", read("SELFTEST planDays") ?? "缺失");
check("预览给出步骤", Number(read("SELFTEST previewSteps")) > 0, read("SELFTEST previewSteps") ?? "缺失");
check("预览给出能力申请单", Number(read("SELFTEST capabilities")) > 0, read("SELFTEST capabilities") ?? "缺失");
check("取消返回明确信号", read("SELFTEST cancel") === "True", read("SELFTEST cancel") ?? "缺失");

check("自检后夹具没有任何变化", fs.readdirSync(root).sort().join(",") === "a.txt,b.jpg", fs.readdirSync(root).join(","));
check("自检后没有生成日志目录", !fs.existsSync(path.join(root, ".deskshell")));

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
