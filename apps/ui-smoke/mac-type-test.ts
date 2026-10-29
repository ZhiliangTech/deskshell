import { execFileSync } from "node:child_process";
import { MacDriver } from "../../packages/drivers/macos/driver.ts";
import type { UiNode } from "../../packages/core/src/types.ts";

const driver = new MacDriver();
const text = `deskshell mac check ${Date.now()}`;

execFileSync("open", ["-a", "TextEdit"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));

const wins = await driver.windows();
const hit = wins.find((w) => /TextEdit|文本编辑|未命名/i.test(w.name) || /TextEdit/i.test(w.className));
if (!hit) {
  console.log("没有找到 TextEdit 窗口：", wins.map((w) => w.name).slice(0, 8).join(" | "));
  process.exit(1);
}
const ref = { pid: hit.pid };
console.log(`窗口：${hit.name} (${hit.className}, pid=${hit.pid})`);

await driver.focus(ref);
await driver.keys(ref, "cmd+a");
await driver.type(ref, { controlType: "TextArea" }, text);
await new Promise((r) => setTimeout(r, 600));

const tree = await driver.tree(ref, 8);
const values: string[] = [];
const walk = (n: UiNode): void => {
  if (n.value) values.push(n.value);
  n.children.forEach(walk);
};
walk(tree);

const ok = values.some((v) => v.toLowerCase().includes(text.toLowerCase()));
console.log(`节点值样本：${values.slice(0, 3).map((v) => JSON.stringify(v.slice(0, 40))).join(", ")}`);
console.log(ok ? "PASS 文本已写入 TextEdit（读回一致）" : "FAIL 没读到写入的文本");

execFileSync("osascript", ["-e", 'tell application "TextEdit" to quit saving no'], { stdio: "ignore" });
process.exitCode = ok ? 0 : 1;
