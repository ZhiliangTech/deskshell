import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const root = path.resolve(".demo/undo-range");
const CLI = path.resolve("bin/deskshell.ts");
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const make = (n: number): Skill => ({
  manifest: {
    name: `range-probe-${n}`,
    version: "0.0.0",
    description: "probe",
    entry: "./index.ts",
    capabilities: [{ id: "fs.write", scope: "{{root}}", reason: "probe" }],
  },
  async plan({ root: r }) {
    const file = path.join(r, `task-${n}.txt`);
    return [
      {
        id: `write-${n}`,
        kind: "fs.write",
        path: file,
        content: `${n}`,
        post: [{ kind: "path.exists", path: file }],
        undo: { kind: "fs.restore", path: file, content: null },
      },
    ];
  },
});

const journal = path.join(root, ".deskshell", "journal.jsonl");
const granted: CapabilityId[] = ["fs.write"];
for (const n of [1, 2, 3]) {
  const mod = (await import(pathToFileURL(path.resolve("packages/core/src/kernel.ts")).href)) as unknown;
  void mod;
  await run(make(n), { root }, { mode: "apply", root, granted, journalPath: journal }, {});
  await new Promise((r) => setTimeout(r, 15)); // 让 ts 分开，便于按时间筛选
}

const files = (): number => fs.readdirSync(root).filter((f) => f.endsWith(".txt")).length;
check("三个任务各写一个文件", files() === 3);

const cli = (args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

// --last 2
const last = cli(["undo", "--last", "2", "--root", root]);
check("undo --last 2 撤销两个任务", last.code === 0 && /共撤销 2 个任务/.test(last.out) && files() === 1);

// --since 1h 收尾
const since = cli(["undo", "--since", "1h", "--root", root]);
check("undo --since 1h 撤销剩下的", since.code === 0 && /共撤销 1 个任务/.test(since.out) && files() === 0);

// 没有可撤的了
const none = cli(["undo", "--since", "1h", "--root", root]);
check("没有可撤销任务时给出提示", /没有匹配的任务/.test(none.out));

// 参数校验
const bad = cli(["undo", "--since", "nonsense", "--root", root]);
check("--since 格式错误时拒绝", bad.code === 2 && /30m \/ 2h \/ 1d/.test(bad.out));

const badLast = cli(["undo", "--last", "0", "--root", root]);
check("--last 0 被拒绝", badLast.code === 2);

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
