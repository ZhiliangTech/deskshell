import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * CLI 层的不可逆语义：非交互下必须显式 --allow-irreversible，否则整单拒绝。
 *
 * 内核那层已经有 irreversible-test.ts；这里测的是"从命令行跑起来"这条路径，
 * 包括一个自己造的一次性 skill（放在临时技能目录里，不污染 packages/skills）。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const CLI = path.resolve("bin/deskshell.ts");
const base = path.resolve(".demo/cli-irreversible");
const root = path.join(base, "root");
const skillsDir = path.join(base, "skills");

function writeSkill(): void {
  const dir = path.join(skillsDir, "irreversible-demo");
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify(
      {
        name: "irreversible-demo",
        version: "0.1.0",
        description: "写一个文件，再删一个文件（删除不可逆）",
        entry: "./index.ts",
        capabilities: [
          { id: "fs.write", scope: "{{root}}", reason: "写文件" },
          { id: "fs.delete", scope: "{{root}}", reason: "删文件（不可逆）" },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    `import fs from "node:fs";
import path from "node:path";

export const skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),
  async plan({ root }) {
    return [
      {
        id: "write:a",
        kind: "fs.write",
        path: path.join(root, "a.txt"),
        content: "a",
        post: [{ kind: "path.exists", path: path.join(root, "a.txt") }],
        undo: { kind: "fs.restore", path: path.join(root, "a.txt"), content: null },
      },
      {
        id: "delete:b",
        kind: "fs.delete",
        path: path.join(root, "b.txt"),
        irreversible: true,
        post: [{ kind: "path.absent", path: path.join(root, "b.txt") }],
        undo: { kind: "noop" },
      },
    ];
  },
};

export default skill;
`,
  );
}

function fresh(): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "b.txt"), "b");
}

function cli(args: string[], input = ""): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      input,
      env: { ...process.env, DESKSHELL_SKILLS_DIR: skillsDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

writeSkill();

// ① 非交互 + 没有 --allow-irreversible：整单拒绝，一个字节不动
fresh();
const refused = cli(["run", "irreversible-demo", "--root", root, "--ask", "--mode", "apply"], "y\ny\n");
check("非交互 + 不可逆：退出码 2", refused.code === 2, String(refused.code));
check("非交互 + 不可逆：提示要确认", /不可逆/.test(refused.out), refused.out.slice(-160));
check("被拒时 b.txt 还在", fs.existsSync(path.join(root, "b.txt")));
check("被拒时 a.txt 没被写", !fs.existsSync(path.join(root, "a.txt")));

// ② 显式确认后照常执行
fresh();
const allowed = cli(
  ["run", "irreversible-demo", "--root", root, "--ask", "--mode", "apply", "--allow-irreversible"],
  "y\ny\n",
);
check("显式确认后执行成功", allowed.code === 0, allowed.out.slice(-200));
check("显式确认后 b.txt 被删", !fs.existsSync(path.join(root, "b.txt")));
check("显式确认后 a.txt 被写", fs.existsSync(path.join(root, "a.txt")));

// ③ preview 永远不需要确认（只读）
fresh();
const preview = cli(["run", "irreversible-demo", "--root", root, "--mode", "preview"]);
check("preview 不需要确认", preview.code === 0, preview.out.slice(-120));
check("preview 不动文件", fs.existsSync(path.join(root, "b.txt")) && !fs.existsSync(path.join(root, "a.txt")));

fs.rmSync(base, { recursive: true, force: true });

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
