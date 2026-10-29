import path from "node:path";
import { skill } from "../../packages/skills/downloads-cleanup/index.ts";
import { PolicyError, run, summarizeRisk } from "../../packages/core/src/kernel.ts";
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
const root = path.resolve(args.root ?? ".demo/downloads");
const mode = (args.mode ?? "preview") as "preview" | "apply" | "undo";
const granted = (args.grant ?? "fs.read,fs.write").split(",") as CapabilityId[];
const journalPath = path.join(root, ".deskshell", "journal.jsonl");

const line = "─".repeat(64);

console.log(`\n┌${line}┐`);
console.log(`│ deskshell demo · skill=${skill.manifest.name}@${skill.manifest.version}`);
console.log(`│ root=${root}`);
console.log(`│ mode=${mode}  granted=${granted.join(",")}`);
console.log(`└${line}┘`);

console.log("\n[能力申请单]");
for (const cap of skill.manifest.capabilities) {
  console.log(`  · ${cap.id.padEnd(10)} ${cap.reason}`);
}

try {
  if (mode !== "undo") {
    const planned = await skill.plan({ root });
    console.log(`\n[计划] ${planned.length} 步，最高风险=${summarizeRisk(planned)}`);
    for (const a of planned.slice(0, 6)) {
      console.log(`  · ${a.id}`);
    }
    if (planned.length > 6) console.log(`  · … 其余 ${planned.length - 6} 步`);
  }

  const report = await run(skill, { root }, { mode, root, granted, journalPath });

  console.log(`\n[结果] ${mode}`);
  for (const s of report.steps) {
    const mark = s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : "✗";
    console.log(`  ${mark} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
  }
  if (report.rolledBack > 0) console.log(`  ↩ 已回滚 ${report.rolledBack} 步`);
  console.log(`\n[审计] ${journalPath}`);
  for (const e of report.journal.slice(-3)) {
    console.log(`  ${new Date(e.ts).toISOString()} ${e.status.padEnd(11)} ${e.summary}`);
  }
} catch (err) {
  if (err instanceof PolicyError) {
    console.log("\n[拒绝] 权限/策略不通过：");
    for (const r of err.reasons) console.log(`  ✗ ${r}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
