import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * 反向验证：这套基准必须能判别人失败。
 *
 * 如果 R0 对"没有撤销能力"的工具也报 100%，那它就是自欺。
 * 这里跑同一个夹具、换一个 naive 适配器（只写不回滚、没有日志），
 * 断言：残渣 < 100%、可追溯 = 0%、退出码非零。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const r = spawnSync(
  process.execPath,
  [path.resolve("scripts/recovery-bench.ts"), "--adapter", path.resolve("scripts/r0-adapter-naive.ts")],
  { encoding: "utf8" },
);
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

check("naive 适配器的结果是失败的（退出码非零）", r.status !== 0, String(r.status));
check("报告里写明 adapter 名字", out.includes("adapter: naive"), out.split("\n")[0] ?? "");

const residue = out.match(/R0-残渣\s+([\d.]+)%/)?.[1];
const trace = out.match(/R0-可追溯\s+([\d.]+)%/)?.[1];
check("残渣率明显低于 100%", residue !== undefined && Number(residue) < 100, residue ?? "未解析");
check("可追溯率为 0%（它没有日志）", trace === "0.0", trace ?? "未解析");
check("正常路径也无法逐字节还原", /0\/4|1\/4|2\/4|3\/4/.test(out), out.match(/逐字节还原：\d+\/\d+/)?.toString() ?? "未解析");

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
