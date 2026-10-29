import { execFileSync } from "node:child_process";
import { MacDriver } from "../../packages/drivers/macos/driver.ts";

const driver = new MacDriver();
execFileSync("open", ["-a", "TextEdit"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2000));

const wins = await driver.windows();
const hit = wins.find((w) => /TextEdit|文本编辑|未命名/i.test(w.name));
if (!hit) {
  console.log("没找到 TextEdit 窗口");
  process.exit(1);
}
const ref = { pid: hit.pid };
const before = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
console.log(`before  ${JSON.stringify(before)}`);

await driver.moveWindow(ref, { x: 120, y: 140, w: 700, h: 500 });
await new Promise((r) => setTimeout(r, 500));
const after = await driver.bounds(ref);
console.log(`after   ${JSON.stringify(after)}`);

await driver.moveWindow(ref, before);
await new Promise((r) => setTimeout(r, 500));
const back = await driver.bounds(ref);
console.log(`restore ${JSON.stringify(back)}`);

const ok = Math.abs(after.x - 120) < 25 && Math.abs(after.w - 700) < 40 && Math.abs(back.x - before.x) < 25;
console.log(ok ? "PASS 窗口移动与还原可用" : "FAIL");

try {
  execFileSync("osascript", ["-e", 'tell application "TextEdit" to quit saving no'], { stdio: "ignore" });
} catch {
  /* ignore */
}
process.exitCode = ok ? 0 : 1;
