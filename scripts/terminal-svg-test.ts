import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 终端截图不能是"贴上去的一张图"：它必须是脚本从现在这份代码跑出来的。
 * 这个测试负责两件事：
 *   1. 重新渲染能成功；
 *   2. 图里确实包含那三个关键信息（失败、回滚、逐字节一致）。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const out = path.resolve("docs/assets/thirty-seconds.svg");
fs.rmSync(out, { force: true });

let stdout = "";
try {
  stdout = execFileSync(process.execPath, [path.resolve("scripts/make-terminal-svg.ts")], { encoding: "utf8" });
} catch (err) {
  check("渲染脚本能跑", false, String(err).slice(0, 200));
}

check("渲染脚本能跑", stdout.includes("rendered"), stdout.trim().slice(-80));
check("SVG 文件已生成", fs.existsSync(out));

const svg = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
check("图里有失败那一步", svg.includes("FAIL"));
check("图里有回滚", svg.includes("undo"));
check("图里有逐字节一致", svg.includes("逐字节一致"));
check("是合法的 SVG 根节点", svg.trimStart().startsWith("<svg"));

// 时间戳必须被抹掉，否则每次渲染图都不同（不可复现）
check("时间戳已抹掉（可复现）", !/"ts":\d/.test(svg));

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
