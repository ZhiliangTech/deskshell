import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";
import { run } from "../../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../../packages/core/src/types.ts";

const mod = (await import(pathToFileURL(path.resolve("packages/skills/tile-windows/index.ts")).href)) as {
  skill: Skill;
};
const skill = mod.skill ?? (mod as unknown as { default: Skill }).default;

const driver = new WindowsDriver();
const { pid } = await driver.launch("notepad.exe");
await new Promise((r) => setTimeout(r, 1000));

const title = "无标题 - Notepad";
const before = await driver.bounds({ titleRegex: title });
console.log(`[before] ${before.x},${before.y} ${before.w}x${before.h}`);

const root = path.resolve(".demo/tile");
const opts = {
  mode: "apply" as const,
  root,
  granted: skill.manifest.capabilities.map((c) => c.id) as CapabilityId[],
  journalPath: path.join(root, "journal.jsonl"),
};

const report = await run(skill, { root, limit: 1, area: { x: 60, y: 60, w: 900, h: 620 } }, opts, { driver });
for (const s of report.steps) console.log(`  ${s.status === "ok" ? "✓" : "✗"} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);

const after = await driver.bounds({ titleRegex: title });
console.log(`[after ] ${after.x},${after.y} ${after.w}x${after.h}`);

const moved = Math.abs(after.x - 60) <= 12 && Math.abs(after.w - 900) <= 12;

const undoReport = await run(skill, { root }, { ...opts, mode: "undo" }, { driver });
for (const s of undoReport.steps) console.log(`  ↩ ${s.actionId} ${s.detail ?? ""}`);

const restored = await driver.bounds({ titleRegex: title });
console.log(`[undo  ] ${restored.x},${restored.y} ${restored.w}x${restored.h}`);

const back = Math.abs(restored.x - before.x) <= 12 && Math.abs(restored.w - before.w) <= 12;

try {
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
} catch {
  /* ignore */
}

console.log(`\nRESULT: ${moved && back ? "PASS" : "FAIL"}  moved=${moved} restored=${back}`);
process.exitCode = moved && back ? 0 : 1;
