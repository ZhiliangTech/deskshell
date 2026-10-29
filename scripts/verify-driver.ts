import { WindowsDriver } from "../packages/drivers/windows/driver.ts";
import { MacDriver } from "../packages/drivers/macos/driver.ts";
import type { UiDriver } from "../packages/core/src/types.ts";

const args = process.argv.slice(2);
const withInput = args.includes("--input");

interface Row {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

const rows: Row[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    rows.push({ name, status: "PASS", detail });
  } catch (err) {
    rows.push({ name, status: "FAIL", detail: err instanceof Error ? err.message : String(err) });
  }
}

const platform = process.platform;
console.log(`platform=${platform}  node=${process.version}`);

let driver: UiDriver;
if (platform === "win32") driver = new WindowsDriver();
else if (platform === "darwin") driver = new MacDriver();
else {
  console.log("当前平台暂无驱动实现（Linux 计划中）。");
  process.exit(0);
}

await check("windows()", async () => {
  const wins = await driver.windows();
  return `${wins.length} 个窗口，例如：${wins[0]?.name?.slice(0, 40) ?? "-"}`;
});

let firstTitle = "";
await check("tree()", async () => {
  const wins = await driver.windows();
  const target = wins.find((w) => w.name && w.w > 0) ?? wins[0];
  if (!target) throw new Error("没有可用窗口");
  firstTitle = target.name;
  const tree = await driver.tree({ titleRegex: target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }, 4);
  const count = (function walk(n): number {
    return 1 + n.children.reduce((acc, c) => acc + walk(c), 0);
  })(tree);
  return `${tree.name.slice(0, 30)} → ${count} 个节点`;
});

await check("focus()", async () => {
  await driver.focus({ titleRegex: firstTitle });
  return "已聚焦";
});

await check("keys()", async () => {
  if (!withInput) return "跳过（加 --input 测试，会发送一次按键）";
  await driver.keys({ titleRegex: firstTitle }, platform === "darwin" ? "cmd+shift+h" : "^{HOME}");
  return "已发送按键";
});

if (withInput) {
  await check("type()", async () => {
    await driver.type({ titleRegex: firstTitle }, { controlType: "Document" }, "deskshell-driver-check");
    return "已发送文本（请在目标窗口确认）";
  });
} else {
  rows.push({ name: "type()", status: "SKIP", detail: "加 --input 测试" });
}

for (const key of ["click()", "invoke()"] as const) {
  rows.push({ name: key, status: "SKIP", detail: "需指定窗口与控件，verifier 不自动点击" });
}


console.log("");
for (const r of rows) {
  console.log(`${r.status.padEnd(4)} ${r.name.padEnd(10)} ${r.detail}`);
}

const failed = rows.filter((r) => r.status === "FAIL").length;
console.log(`\n${rows.filter((r) => r.status === "PASS").length} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
