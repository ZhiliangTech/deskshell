import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * --ask 的行为契约：
 *   全部同意 → 照常执行；任一拒绝 → 整单不执行且退出码 2；没有输入 → 视为拒绝。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const CLI = path.resolve("bin/deskshell.ts");
const base = path.resolve(".demo/ask");
const root = path.join(base, "root");
const journal = path.join(root, ".deskshell", "journal.jsonl");

function fresh(): void {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  fs.writeFileSync(path.join(root, "b.jpg"), "b");
  fs.writeFileSync(path.join(root, "c.jpg"), "c");
}

interface Run {
  code: number;
  out: string;
}

function cli(args: string[], input?: string): Run {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      input: input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// 1) 全部同意：预览应正常输出
fresh();
const allYes = cli(["run", "downloads-cleanup", "--root", root, "--ask"], "y\ny\n");
check("全部同意时正常出计划", allYes.code === 0 && /汇总：/.test(allYes.out), allYes.out.slice(-120));
check("能力逐项展示", /fs\.read/.test(allYes.out) && /fs\.write/.test(allYes.out));

// 2) 拒绝第二项：不执行、不留日志
fresh();
const denied = cli(["run", "downloads-cleanup", "--root", root, "--ask", "--mode", "apply"], "y\nn\n");
check("拒绝时退出码为 2", denied.code === 2, String(denied.code));
check("拒绝时给出明确提示", /任务不会执行/.test(denied.out));
check("拒绝时不产生任何副作用", !fs.existsSync(journal) && fs.readdirSync(root).length === 3);

// 3) 没有输入：等同于拒绝
fresh();
const noInput = cli(["run", "downloads-cleanup", "--root", root, "--ask"], "");
check("无输入时视为拒绝", noInput.code === 2 && /需要输入/.test(noInput.out), noInput.out.slice(-80));
check("无输入时不产生副作用", !fs.existsSync(journal));

// 4) 显式 --grant 与 --ask 不冲突时，以 --ask 结果为准
fresh();
const both = cli(["run", "downloads-cleanup", "--root", root, "--ask", "--grant", "fs.read,fs.write"], "y\ny\n");
check("--ask 与 --grant 同时出现时仍逐项确认", both.code === 0 && /fs\.read/.test(both.out));

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
