import { execFileSync } from "node:child_process";
import { WindowsDriver } from "../../packages/drivers/windows/driver.ts";

const driver = new WindowsDriver();
const ref = { titleRegex: "Notepad" };
const text = `录制演示 ${new Date().toLocaleTimeString("zh-CN")}`;

const { pid } = await driver.launch("notepad.exe");
await new Promise((r) => setTimeout(r, 900));
await driver.tree(ref, 3);
await driver.type(ref, { controlType: "Document" }, text);
await new Promise((r) => setTimeout(r, 500));
await driver.click(ref, { controlType: "Document" });
await new Promise((r) => setTimeout(r, 700));
console.log(`typed: ${text}`);
try {
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
} catch {
  /* ignore */
}
