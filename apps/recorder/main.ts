import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PS = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const SCRIPT = fileURLToPath(new URL("../../packages/drivers/windows/recorder.ps1", import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).reduce<Array<[string, string]>>((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, []),
);

const seconds = Number(args.seconds ?? 12);
const outFile = path.resolve(args.out ?? `.demo/recordings/rec-${Date.now()}.jsonl`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });

console.log(`[录制] ${seconds}s，输出 ${outFile}`);

const proc = spawn(
  PS,
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Out", outFile, "-Seconds", String(seconds)],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);

let stdout = "";
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d: string) => (stdout += d));
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (d: string) => process.stderr.write(d));

await new Promise<void>((resolve) => proc.on("close", () => resolve()));

const lines = fs.existsSync(outFile)
  ? fs
      .readFileSync(outFile, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter(Boolean)
  : [];
console.log(`[录制] 采样 ${lines.length} 帧`);

// 去重：连续相同（窗口+控件+值+位置）只保留第一帧
interface Sample {
  ts: number;
  type: string;
  window: string;
  controlType: string;
  name: string;
  automationId: string;
  value: string | null;
  x: number;
  y: number;
}
const samples = lines.map((l) => JSON.parse(l) as Sample);
const events: Sample[] = [];
for (const s of samples) {
  const prev = events[events.length - 1];
  const same =
    prev &&
    prev.type === s.type &&
    prev.window === s.window &&
    prev.controlType === s.controlType &&
    prev.name === s.name &&
    prev.value === s.value &&
    prev.x === s.x &&
    prev.y === s.y;
  if (!same) events.push(s);
}

console.log(`[录制] 有效事件 ${events.length} 个`);
for (const e of events) {
  const where = e.type === "click" ? `@${e.x},${e.y}` : "";
  console.log(`  · ${e.type.padEnd(5)} ${e.window.slice(0, 20)} | ${e.controlType} | ${e.name.slice(0, 16)} | ${e.value ? e.value.slice(0, 24) : ""} ${where}`);
}
console.log(`\n下一步：node scripts/draft-skill.ts --recording ${path.relative(process.cwd(), outFile)} --name my-skill`);
