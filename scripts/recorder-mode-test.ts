import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 录制器两种模式的冒烟测试：
 *   - 默认事件模式（UIA FocusChanged / StructureChanged）
 *   - --Poll 轮询回退
 * 只验证"能启动、能落盘、退出码 0、报告 mode 正确"；真实交互录制在 docs/recording 里手工验证。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

if (process.platform !== "win32") {
  console.log("skipped: 录制器只在 Windows 上有（UIA + WH_MOUSE_LL）");
  process.exit(0);
}

const base = path.resolve(".demo/recorder-mode");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const script = path.resolve("packages/drivers/windows/recorder.ps1");

function run(args: string[], out: string): { mode?: string; events?: number; code: number } {
  try {
    const stdout = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", out, "-Seconds", "2", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const line = stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line) as { ok: boolean; data: { mode: string; events: number } };
    return { mode: parsed.data.mode, events: parsed.data.events, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1 };
  }
}

const eventsOut = path.join(base, "events.jsonl");
const ev = run([], eventsOut);
check("事件模式启动成功", ev.code === 0, `exit ${ev.code}`);
check("事件模式自报 mode=events", ev.mode === "events", String(ev.mode));
check("事件模式写出了文件", fs.existsSync(eventsOut));

const pollOut = path.join(base, "poll.jsonl");
const pl = run(["-Poll"], pollOut);
check("轮询模式启动成功", pl.code === 0, `exit ${pl.code}`);
check("轮询模式自报 mode=poll", pl.mode === "poll", String(pl.mode));
check("轮询模式写出了文件", fs.existsSync(pollOut));

// 两种模式的输出都必须是逐行 JSON
for (const file of [eventsOut, pollOut]) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const okJson = lines.every((l) => {
    try {
      const row = JSON.parse(l) as { type?: string; window?: string };
      return typeof row.type === "string" && typeof row.window === "string";
    } catch {
      return false;
    }
  });
  check(`${path.basename(file)} 每行都是合法事件`, okJson, `${lines.length} 行`);
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
