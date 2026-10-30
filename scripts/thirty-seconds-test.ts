import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 30 秒 demo 的三条不变量，钉死它不许退化成"看起来能跑"：
 *   1) 退出码 0（目录零残渣，脚本自己会校验）
 *   2) 5 条日志（每一步都留痕，包括失败那步）
 *   3) 输出里必须有"逐字节一致"
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

let out = "";
let code = 0;
try {
  out = execFileSync(process.execPath, [path.resolve("apps/cli-demo/thirty-seconds.ts"), "--json"], {
    encoding: "utf8",
  });
} catch (err) {
  const e = err as { status?: number; stdout?: string; stderr?: string };
  code = e.status ?? 1;
  out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}

check("demo 退出码为 0（零残渣才允许 0）", code === 0, String(code));

const jsonStart = out.indexOf('{\n  "steps"');
const parsed = jsonStart >= 0 ? (JSON.parse(out.slice(jsonStart)) as {
  steps: number;
  rolledBack: number;
  journalLines: number;
  byteIdentical: boolean;
}) : null;

check("demo 输出可解析", parsed !== null, out.slice(-200));
if (parsed) {
  check("五步执行、回滚 5 处（4 步 + 失败那步的自撤）", parsed.steps === 5 && parsed.rolledBack === 5, `${parsed.steps} 步 / 回滚 ${parsed.rolledBack}`);
  check("日志 5 行（失败那步也留痕）", parsed.journalLines === 5, String(parsed.journalLines));
  check("目录逐字节一致", parsed.byteIdentical === true);
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
