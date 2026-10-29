import path from "node:path";
import { pathToFileURL } from "node:url";
import { PolicyError, run } from "../../packages/core/src/kernel.ts";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";
import type { CapabilityId, Skill } from "../../packages/core/src/types.ts";

const args = Object.fromEntries(
  process.argv.slice(2).reduce<Array<[string, string]>>((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, []),
);

const skillPath = args.skill;
if (!skillPath) {
  console.error("用法: node apps/cli-demo/run.ts --skill <path/to/index.ts> --mode preview|apply|undo [--root DIR]");
  process.exit(2);
}

const mod = (await import(pathToFileURL(path.resolve(skillPath)).href)) as { skill?: Skill; default?: Skill };
const skill = mod.skill ?? mod.default;
if (!skill) {
  console.error("skill 模块必须导出 skill 或 default");
  process.exit(2);
}

const mode = (args.mode ?? "preview") as "preview" | "apply" | "undo";
const root = path.resolve(args.root ?? ".demo/generic");
const needsDriver = skill.manifest.capabilities.some((c) => c.id.startsWith("ui."));
const granted = skill.manifest.capabilities.map((c) => c.id) as CapabilityId[];
const driver = needsDriver ? new WindowsDriver() : undefined;

console.log(`\n[运行] ${skill.manifest.name} v${skill.manifest.version}  mode=${mode}  driver=${needsDriver ? "windows" : "none"}`);
console.log(`[能力] ${granted.join(", ")}`);

try {
  const report = await run(
    skill,
    { root },
    { mode, root, granted, journalPath: path.join(root, ".deskshell", "journal.jsonl") },
    { driver },
  );
  for (const s of report.steps) {
    console.log(`  ${s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : "✗"} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
  }
  if (report.rolledBack) console.log(`  ↩ 回滚 ${report.rolledBack} 步`);
} catch (err) {
  if (err instanceof PolicyError) {
    console.log("[拒绝] " + err.reasons.join("; "));
    process.exitCode = 2;
  } else {
    throw err;
  }
}
