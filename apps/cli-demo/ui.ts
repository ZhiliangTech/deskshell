import path from "node:path";
import { skill } from "../../packages/skills/browser-tabs/index.ts";
import { PolicyError, run } from "../../packages/core/src/kernel.ts";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";
import type { CapabilityId } from "../../packages/core/src/types.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? ".demo/archive");
const mode = (args.mode ?? "preview") as "preview" | "apply" | "undo";
const titleRegex = args.window ?? "Edge";
const granted = (args.grant ?? "ui.read,fs.write").split(",") as CapabilityId[];
const journalPath = path.join(root, ".deskshell", "journal.jsonl");
const driver = new WindowsDriver();

console.log(`\n[UI 场景] window=/${titleRegex}/  root=${root}  mode=${mode}`);

const wins = await driver.windows();
const matched = wins.filter((w) => new RegExp(titleRegex).test(w.name));
console.log(`\n[窗口] 共 ${wins.length} 个，匹配 ${matched.length} 个`);
for (const w of matched) console.log(`  · ${w.name.slice(0, 60)}  (pid=${w.pid}, ${w.w}x${w.h})`);

try {
  const planned = await skill.plan({ root, titleRegex }, { driver });
  console.log(`\n[观察] 标签页 ${planned.length ? planned[0].content.match(/标签数量：(\d+)/)?.[1] ?? "?" : "0"} 个`);

  const report = await run(skill, { root, titleRegex }, { mode, root, granted, journalPath }, { driver });

  console.log(`\n[结果] ${mode}`);
  for (const s of report.steps) console.log(`  ${s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : "✗"} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);

  if (mode === "apply") {
    const file = report.journal[0]?.summary ?? "";
    console.log(`\n[产物] ${file}`);
  }
  if (mode === "undo") console.log(`  ↩ 已回滚 ${report.rolledBack} 步`);
} catch (err) {
  if (err instanceof PolicyError) {
    console.log("\n[拒绝] 权限/策略不通过：");
    for (const r of err.reasons) console.log(`  ✗ ${r}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
