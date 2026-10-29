import { execFileSync } from "node:child_process";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";
import type { UiNode } from "../../packages/core/src/types.ts";

const driver = new WindowsDriver();
const text = `deskshell ui smoke ${new Date().toISOString()}`;
const ref = { titleRegex: "记事本|Notepad" };

function findEdit(node: UiNode): UiNode | undefined {
  if (node.controlType === "Edit" || node.controlType === "Document") return node;
  for (const c of node.children) {
    const hit = findEdit(c);
    if (hit) return hit;
  }
  return undefined;
}

console.log("[1] 启动记事本");
const { pid } = await driver.launch("notepad.exe");
console.log(`    pid=${pid}`);

console.log("[2] 等待窗口出现");
let tree = await driver.tree(ref, 4);
for (let i = 0; i < 10 && !tree; i++) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    tree = await driver.tree(ref, 4);
  } catch {
    /* retry */
  }
}
console.log(`    窗口：${tree.name}`);

console.log("[3] 通过 UIA 写入文本");
await driver.type(ref, { controlType: "Document" }, text);

console.log("[4] 回读校验");
const after = await driver.tree(ref, 6);
const edit = findEdit(after);
const value = edit?.value ?? "";
console.log(`    value=${JSON.stringify(value.slice(0, 60))}`);
const ok = value.includes(text);

console.log(`[5] 关闭（kill pid=${pid}）`);
try {
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
} catch {
  /* already gone */
}

console.log(ok ? "\nRESULT: PASS — UI 输入链路（focus → type → 回读）可用" : "\nRESULT: FAIL — 文本未写入");
process.exitCode = ok ? 0 : 1;
