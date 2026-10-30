import fs from "node:fs";
import path from "node:path";
import { run } from "../packages/core/src/kernel.ts";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import type { Action, CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 不可逆动作的硬闸：该拦的时候必须拦，而且是在动手之前。
 *
 * 这一层的价值不在"能撤回"，而在"撤不回的，绝不假装能撤"。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const root = path.resolve(".demo/irreversible");
const journal = path.join(root, ".deskshell", "journal.jsonl");

const actions: Action[] = [
  {
    id: "1-safe",
    kind: "fs.write",
    path: path.join(root, "a.txt"),
    content: "a",
    post: [{ kind: "path.exists", path: path.join(root, "a.txt") }],
    undo: { kind: "fs.restore", path: path.join(root, "a.txt"), content: null },
  },
  {
    id: "2-button",
    kind: "ui.click",
    window: "Mock Window",
    selector: { automationId: "ok" },
    irreversible: true,
    undo: { kind: "noop" },
  },
];

const skill: Skill = {
  manifest: {
    name: "irreversible-demo",
    version: "0.0.0",
    description: "含一个不可逆动作",
    entry: "./index.ts",
    capabilities: [
      { id: "fs.write", scope: "{{root}}", reason: "写文件" },
      { id: "ui.input", scope: "Mock Window", reason: "点按钮" },
    ],
  },
  async plan() {
    return actions;
  },
};

const granted: CapabilityId[] = ["fs.write", "ui.input"];
const fresh = (): MockDriver => new MockDriver();

// ① 预览：要把不可逆步数算出来
{
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const report = await run(skill, { root }, { mode: "preview", root, granted, journalPath: journal }, {});
  const summary = report.summary as unknown as { irreversible?: number } | undefined;
  check("preview 统计出不可逆步数", summary?.irreversible === 1, JSON.stringify(summary));
}

// ② 没有确认：整单拒绝，且一个字节都不动
{
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  let message = "";
  try {
    await run(skill, { root }, { mode: "apply", root, granted, journalPath: journal }, { driver: fresh() });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check("没有确认时被拒绝", /不可逆/.test(message), message.slice(0, 80));
  check("拒绝信息点名是哪一步", message.includes("2-button"), message.slice(0, 80));
  check("拒绝发生在动手之前（a.txt 没被写）", !fs.existsSync(path.join(root, "a.txt")));
  check("拒绝时不产生日志", !fs.existsSync(journal));
}

// ③ 显式确认后照常执行
{
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const report = await run(
    skill,
    { root },
    { mode: "apply", root, granted, journalPath: journal, allowIrreversible: true },
    { driver: fresh() },
  );
  check("确认后执行成功", report.steps.every((s) => s.status === "ok"), JSON.stringify(report.steps.map((s) => s.status)));
  check("确认后确实写了文件", fs.existsSync(path.join(root, "a.txt")));
}

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
