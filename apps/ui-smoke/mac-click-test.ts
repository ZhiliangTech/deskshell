import { execFileSync } from "node:child_process";
import { MacDriver } from "../../packages/drivers/macos/driver.ts";
import type { UiNode } from "../../packages/core/src/types.ts";

const driver = new MacDriver();

execFileSync("open", ["-a", "Calculator"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));

const wins = await driver.windows();
const hit = wins.find((w) => /Calculator|计算器/i.test(w.name) || /Calculator/i.test(w.className));
if (!hit) {
  console.log("没找到计算器窗口：", wins.map((w) => `${w.name}(${w.className})`).slice(0, 10).join(" | "));
  process.exit(1);
}
const ref = { pid: hit.pid };
console.log(`窗口：${hit.name} (${hit.className}, pid=${hit.pid})`);

// macOS 计算器的按钮没有标题，靠 AXIdentifier 定位：Seven / Multiply / Eight / Equals
for (const id of ["Seven", "Multiply", "Eight", "Equals"]) {
  await driver.invoke(ref, { controlType: "Button", automationId: id });
  await new Promise((r) => setTimeout(r, 120));
}

const tree = await driver.tree(ref, 12);
const texts: string[] = [];
const walk = (n: UiNode): void => {
  if (n.controlType === "StaticText") texts.push(n.value ?? "");
  n.children.forEach(walk);
};
walk(tree);

console.log(`屏幕文本：${texts.filter(Boolean).slice(0, 5).join(" | ") || "(空)"}`);
const norm = (t: string): string => t.replace(/[‎‏\s]/g, "");
const ok = texts.some((t) => norm(t) === "56");
console.log(ok ? "PASS 点击链路可用：7 × 8 = 56" : "FAIL 计算结果不符");

execFileSync("osascript", ["-e", 'tell application "Calculator" to quit'], { stdio: "ignore" });
process.exitCode = ok ? 0 : 1;
