import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../../packages/core/src/kernel.ts";
import type { Action, Skill } from "../../packages/core/src/types.ts";

/**
 * 30 秒 demo：四步成功、第五步失败、全部退回、目录一个字节都没留下。
 *
 * 这条命令是给人看的，不读文档也能在 30 秒内明白这个项目在卖什么：
 * 不是"AI 会点鼠标"，而是"AI 搞砸了能收场，而且收得干净"。
 *
 *   node apps/cli-demo/thirty-seconds.ts           # 带停顿，给人看
 *   node apps/cli-demo/thirty-seconds.ts --fast    # 不停顿，给 CI 看
 *   node apps/cli-demo/thirty-seconds.ts --json    # 机器可读（给 README 生成用）
 */

const fast = process.argv.includes("--fast") || process.argv.includes("--json");
const asJson = process.argv.includes("--json");

const root = path.resolve(".demo/thirty-seconds");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const journal = path.join(root, ".deskshell", "journal.jsonl");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, fast ? 0 : ms));

const U = path.join(root, "uploads");
const D = path.join(root, "done");

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (rel.startsWith(".deskshell")) continue;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else {
        const hash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 8);
        out.push(`${rel}@${hash}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const actions: Action[] = [
  {
    id: "1-mkdir",
    kind: "fs.mkdir",
    path: U,
    post: [{ kind: "path.exists", path: U }],
    undo: { kind: "fs.rmdir", path: U },
  },
  {
    id: "2-write-a",
    kind: "fs.write",
    path: path.join(U, "a.txt"),
    content: "a",
    post: [{ kind: "path.exists", path: path.join(U, "a.txt") }],
    undo: { kind: "fs.restore", path: path.join(U, "a.txt"), content: null },
  },
  {
    id: "3-write-b",
    kind: "fs.write",
    path: path.join(U, "b.txt"),
    content: "b",
    post: [{ kind: "path.exists", path: path.join(U, "b.txt") }],
    undo: { kind: "fs.restore", path: path.join(U, "b.txt"), content: null },
  },
  {
    id: "4-move",
    kind: "fs.move",
    from: path.join(U, "b.txt"),
    to: path.join(D, "b.txt"),
    pre: [{ kind: "path.exists", path: path.join(U, "b.txt") }],
    post: [{ kind: "path.exists", path: path.join(D, "b.txt") }],
    undo: { kind: "fs.move", from: path.join(D, "b.txt"), to: path.join(U, "b.txt") },
  },
  {
    id: "5-write-c",
    kind: "fs.write",
    path: path.join(U, "c.txt"),
    content: "c",
    // 这一步故意断言一个永远不会出现的东西：用来演示"失败即回滚"
    post: [{ kind: "path.exists", path: path.join(root, "this-will-never-exist") }],
    undo: { kind: "fs.restore", path: path.join(U, "c.txt"), content: null },
  },
];

const skill: Skill = {
  manifest: {
    name: "thirty-seconds",
    version: "0.0.0",
    description: "四步成功、第五步失败、全部退回",
    entry: "./index.ts",
    capabilities: [
      { id: "fs.write", scope: "{{root}}", reason: "演示写入与移动" },
      { id: "fs.read", scope: "{{root}}", reason: "演示读取" },
    ],
  },
  async plan() {
    return actions;
  },
};

const before = snapshot(root);
const lines: string[] = [];
const say = (s = ""): void => {
  lines.push(s);
  if (!asJson) console.log(s);
};

say("");
say("deskshell — 30 秒看一件事：AI 搞砸了，能不能一点痕迹都不留");
say(`沙盒：${path.relative(process.cwd(), root)}`);
say("");

const report = await run(
  skill,
  { root },
  { mode: "apply", root, granted: ["fs.write", "fs.read"], journalPath: journal },
  {},
);

for (const step of report.steps) {
  const mark = step.status === "ok" ? "ok  " : "FAIL";
  say(`  [${step.actionId}] ${mark} ${step.detail ?? ""}`);
  await sleep(180);
}

const undone = report.rolledBack;
say("");
say(`↩ 自动回滚（逆序）：${undone} 步`);
for (const e of report.journal.slice().reverse()) {
  say(`   undo ${e.actionId}  ${e.summary}`);
  await sleep(120);
}

const after = snapshot(root);
const identical = JSON.stringify(before) === JSON.stringify(after);
say("");
say(`目录状态   before: ${before.length ? before.join(", ") : "空"}`);
say(`           after : ${after.length ? after.join(", ") : "空"}   ${identical ? "✅ 逐字节一致" : "❌ 有残留"}`);

const entries = fs.existsSync(journal)
  ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean)
  : [];
say("");
say(`日志（${path.relative(process.cwd(), journal)}，${entries.length} 行，可 diff、可审计）`);
for (const line of entries.slice(0, 6)) {
  const e = JSON.parse(line) as { actionId: string; status: string; ts: number };
  const rel = path.relative(path.dirname(path.dirname(journal)), journal).replace(/\\/g, "/");
  say(`  ${JSON.stringify({ ts: e.ts, action: e.actionId, status: e.status })}`);
  void rel;
}
say("");

if (asJson) {
  console.log(
    JSON.stringify(
      {
        steps: report.steps.length,
        rolledBack: report.rolledBack,
        journalLines: entries.length,
        byteIdentical: identical,
        transcript: lines,
      },
      null,
      2,
    ),
  );
}

if (!identical) {
  console.error("演示失败：目录没有回到执行前的状态");
  process.exitCode = 1;
}
