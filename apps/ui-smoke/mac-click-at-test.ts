// 坐标点击验证：AX 只用来读矩形，所有动作都走 MacDriver.clickAt()（CGEvent 坐标点击）。
// 目标：计算器上按坐标依次点 7 × 8 =，断言显示 56；再验证 AXPress 不可用时的回退路径。
import { execFileSync } from "node:child_process";
import { MacDriver } from "../../packages/drivers/macos/driver.ts";
import type { UiNode } from "../../packages/core/src/types.ts";

const driver = new MacDriver();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 先彻底清掉可能残留的计算器，保证从干净状态开始
// （Calculator 会保留上次算式，osascript quit 有时被旧实例拖延，直接 pkill 更可靠）
try {
  execFileSync("pkill", ["-x", "Calculator"], { stdio: "ignore" });
} catch {
  /* 之前没在运行 */
}
await sleep(700);

execFileSync("open", ["-a", "Calculator"], { stdio: "ignore" });
await sleep(2500);

const wins = await driver.windows();
const hit = wins.find((w) => /Calculator|计算器/i.test(w.name) || /Calculator/i.test(w.className));
if (!hit) {
  console.log("没找到计算器窗口：", wins.map((w) => `${w.name}(${w.className})`).slice(0, 10).join(" | "));
  process.exit(1);
}
const ref = { pid: hit.pid };
console.log(`窗口：${hit.name} (${hit.className}, pid=${hit.pid})`);

try {
  await driver.focus(ref);
  await sleep(300);
} catch (e) {
  console.log(`聚焦失败（仍继续坐标点击）：${(e as Error).message}`);
}

const readTexts = async (): Promise<string[]> => {
  const tree = await driver.tree(ref, 12);
  const texts: string[] = [];
  const walk = (n: UiNode): void => {
    if (n.controlType === "StaticText" && n.value) texts.push(n.value);
    n.children.forEach(walk);
  };
  walk(tree);
  return texts;
};
const norm = (t: string): string => t.replace(/[\u200e\u200f\s]/g, "");

// 显示清零，确保从 0 开始；顺带验证 click() 的 AXPress 正常路径（AllClear 支持 AXPress）
await driver.click(ref, { controlType: "Button", automationId: "AllClear" });
await sleep(200);
const startTexts = await readTexts();
console.log(`初始显示（click() 走 AXPress 清空）：${startTexts.slice(0, 5).join(" | ") || "(空)"}`);

// 1) 纯坐标点击：取按钮 AX 矩形中心 → CGEvent 点击
for (const id of ["Seven", "Multiply", "Eight", "Equals"]) {
  const r = await driver.rectOf(ref, { controlType: "Button", automationId: id });
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  console.log(`clickAt(${Math.round(cx)}, ${Math.round(cy)}) ← ${id} rect=${JSON.stringify(r)}`);
  await driver.clickAt(cx, cy);
  await sleep(180);
}

const texts = await readTexts();
console.log(`屏幕文本：${texts.slice(0, 5).join(" | ") || "(空)"}`);
const coordinateOk = texts.some((t) => norm(t) === "56");

// 2) 回退路径：AXScrollArea 不支持 AXPress（实测 raw -25206），
//    click() 应改点元素矩形中心；用鼠标位置验证落点，且结果仍是 56。
let fallbackOk = false;
let fallbackReason = "";
const fallbackSel = { controlType: "ScrollArea", automationId: "StandardInputView" };
try {
  await driver.invoke(ref, fallbackSel);
  fallbackReason = "该元素竟然支持 AXPress，回退场景未成立";
} catch (e) {
  const r = await driver.rectOf(ref, fallbackSel);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  console.log(`AXPress 被拒（${(e as Error).message}）→ 回退目标 rect=${JSON.stringify(r)}`);
  await driver.click(ref, fallbackSel);
  await sleep(300);
  const cur = await driver.cursor();
  const landed = Math.abs(cur.x - cx) <= 3 && Math.abs(cur.y - cy) <= 3;
  const after = await readTexts();
  console.log(`鼠标落点：(${cur.x}, ${cur.y})，目标中心 (${cx}, ${cy}) → ${landed ? "命中" : "偏离"}`);
  console.log(`回退后屏幕文本：${after.slice(0, 5).join(" | ") || "(空)"}`);
  const kept = after.some((t) => norm(t) === "56");
  fallbackOk = landed && kept;
  fallbackReason = landed && kept ? "落点=元素中心，显示仍为 56" : `落点${landed ? "命中" : "偏离"}、显示${kept ? "未变" : "已变"}`;
}

console.log(coordinateOk ? "PASS 坐标点击：7 × 8 = 56" : "FAIL 坐标点击计算结果不符");
console.log(fallbackOk ? `PASS AXPress 不可用时回退到元素中心坐标点击（${fallbackReason}）` : `FAIL 回退路径：${fallbackReason}`);

try {
  execFileSync("pkill", ["-x", "Calculator"], { stdio: "ignore" });
} catch {
  /* 已退出 */
}
process.exitCode = coordinateOk && fallbackOk ? 0 : 1;
