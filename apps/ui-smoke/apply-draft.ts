import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";
import { run } from "../../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../../packages/core/src/types.ts";

const skillPath = process.argv[2];
if (!skillPath) {
  console.error("用法: node apps/ui-smoke/apply-draft.ts <skill/index.ts>");
  process.exit(2);
}

const mod = (await import(pathToFileURL(path.resolve(skillPath)).href)) as { skill?: Skill; default?: Skill };
const skill = mod.skill ?? mod.default;
if (!skill) throw new Error("skill 模块缺少导出");

const driver = new WindowsDriver();
const { pid } = await driver.launch("notepad.exe");
await new Promise((r) => setTimeout(r, 900));

const root = path.resolve(".demo/draft-run");
const report = await run(
  skill,
  { root },
  {
    mode: "apply",
    root,
    granted: skill.manifest.capabilities.map((c) => c.id) as CapabilityId[],
    journalPath: path.join(root, ".deskshell", "journal.jsonl"),
  },
  { driver },
);

for (const s of report.steps) {
  console.log(`  ${s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : "✗"} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
}
console.log(report.rolledBack ? `回滚 ${report.rolledBack} 步` : "无回滚");

try {
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
} catch {
  /* ignore */
}

process.exitCode = report.steps.every((s) => s.status === "ok") ? 0 : 1;
