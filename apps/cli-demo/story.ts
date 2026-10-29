import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";
import { run, undoAll } from "../../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../../packages/core/src/types.ts";

const base = path.resolve(".demo/story");
const downloads = path.join(base, "downloads");
const journal = path.join(base, "journal.jsonl");
const keep = process.argv.includes("--keep");

if (process.argv.includes("--fail")) {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "fail-story.ts")], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
execFileSync(process.execPath, ["scripts/make-fixture.ts", downloads], { stdio: "ignore" });

const load = async (p: string): Promise<Skill> => {
  const mod = (await import(pathToFileURL(path.resolve(p)).href)) as { skill?: Skill; default?: Skill };
  const s = mod.skill ?? mod.default;
  if (!s) throw new Error(`skill 没有导出：${p}`);
  return s;
};

const driver = new WindowsDriver();
const granted = (s: Skill): CapabilityId[] => s.manifest.capabilities.map((c) => c.id);

const filesBefore = fs.readdirSync(downloads).filter((f) => fs.statSync(path.join(downloads, f)).isFile()).length;
console.log(`场景：${base}`);
console.log(`起点：${filesBefore} 个文件在下载目录\n`);

// 0) 开一个自己的记事本，供窗口平铺演示
const { pid } = await driver.launch("notepad.exe");
await new Promise((r) => setTimeout(r, 1200));
const winBefore = await driver.bounds({ titleRegex: "Notepad" });
console.log(`[准备] 记事本 ${winBefore.x},${winBefore.y} ${winBefore.w}x${winBefore.h}\n`);

// 1) 整理下载目录
const cleanup = await load("packages/skills/downloads-cleanup/index.ts");
const r1 = await run(cleanup, { root: downloads }, { mode: "apply", root: downloads, granted: granted(cleanup), journalPath: journal }, {});
console.log(`[1/3] 整理下载目录：${r1.steps.filter((s) => s.status === "ok").length} 步完成`);

// 2) 归档浏览器标签（没有浏览器窗口就跳过）
let r2note = "跳过（未找到浏览器窗口）";
try {
  const tabs = await load("packages/skills/browser-tabs/index.ts");
  const r2 = await run(tabs, { root: base, titleRegex: "Edge" }, { mode: "apply", root: base, granted: granted(tabs), journalPath: journal }, { driver });
  r2note = `${r2.steps.filter((s) => s.status === "ok").length} 个标签页写入清单`;
} catch (err) {
  r2note = `跳过（${err instanceof Error ? err.message.slice(0, 40) : "未找到窗口"}）`;
}
console.log(`[2/3] 归档浏览器标签：${r2note}`);

// 3) 平铺窗口（只动我们自己开的记事本）
const tile = await load("packages/skills/tile-windows/index.ts");
const r3 = await run(
  tile,
  { root: base, include: "Notepad", limit: 1, area: { x: 120, y: 100, w: 1000, h: 700 } },
  { mode: "apply", root: base, granted: granted(tile), journalPath: journal },
  { driver },
);
const winAfter = await driver.bounds({ titleRegex: "Notepad" });
console.log(`[3/3] 平铺窗口：${r3.steps.filter((s) => s.status === "ok").length} 个窗口 → ${winAfter.x},${winAfter.y} ${winAfter.w}x${winAfter.h}`);

const midFiles = fs.readdirSync(downloads).filter((f) => fs.statSync(path.join(downloads, f)).isFile()).length;
console.log(`\n中间态：下载目录顶层剩 ${midFiles} 个文件，标签清单 ${fs.existsSync(base) ? fs.readdirSync(base).filter((f) => f.startsWith("tabs-")).length : 0} 份\n`);

// 4) 一键撤销全部
const undo = await undoAll({ mode: "undo", root: base, granted: [], journalPath: journal }, { driver });
const restoredFiles = fs.readdirSync(downloads).filter((f) => fs.statSync(path.join(downloads, f)).isFile()).length;
const tabsLeft = fs.readdirSync(base).filter((f) => f.startsWith("tabs-")).length;
const winRestored = await driver.bounds({ titleRegex: "Notepad" });

console.log(`[撤销] ${undo.rolledBack} 步回滚，失败 ${undo.steps.filter((s) => s.status === "failed").length} 步`);
console.log(`       文件 ${midFiles} → ${restoredFiles}（起点 ${filesBefore}）`);
console.log(`       标签清单 ${tabsLeft} 份`);
console.log(`       窗口 ${winRestored.x},${winRestored.y} ${winRestored.w}x${winRestored.h}`);

try {
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
} catch {
  /* ignore */
}

const ok =
  restoredFiles === filesBefore &&
  tabsLeft === 0 &&
  Math.abs(winRestored.x - winBefore.x) <= 12 &&
  Math.abs(winRestored.w - winBefore.w) <= 12;

if (keep) console.log(`\n产物保留在 ${base}`);
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} — 三个场景全部可撤销`);
process.exitCode = ok ? 0 : 1;
