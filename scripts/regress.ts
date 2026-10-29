import { execFileSync } from "node:child_process";
import fs from "node:fs";

const NODE = process.execPath;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function run(
  name: string,
  args: string[],
  check?: (out: string) => boolean,
  allowFail = false,
): string {
  let out = "";
  let ok = true;
  try {
    out = execFileSync(NODE, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message || "";
    ok = allowFail;
  }
  const pass = ok && (check ? check(out) : true);
  results.push({ name, ok: pass, detail: pass ? "ok" : out.slice(0, 200) });
  return out;
}

// 1) 文件场景
run("fixture", ["scripts/make-fixture.ts"], (o) => o.includes("files"));
run("fs.apply", ["apps/cli-demo/main.ts", "--mode", "apply"], (o) => (o.match(/✓/g) ?? []).length === 20);
run("fs.undo", ["apps/cli-demo/main.ts", "--mode", "undo"], (o) => o.includes("已回滚 20 步"));

const leftover = fs.readdirSync(".demo/downloads").filter((f) => fs.statSync(`.demo/downloads/${f}`).isFile()).length;
results.push({ name: "fs.restored", ok: leftover === 13, detail: `${leftover} files` });

// 2) 权限拒绝
run(
  "policy.deny",
  ["apps/cli-demo/main.ts", "--mode", "apply", "--grant", "fs.read"],
  (o) => o.includes("未授予能力 fs.write"),
  true,
);

// 3) CLI：能列出公开 skill
run("cli.list", ["bin/deskshell.ts", "list"], (o) => o.includes("4 个 skill"));
run("cli.version", ["bin/deskshell.ts", "version"], (o) => o.includes("deskshell 0.1.0"));

// 4) CLI：--json 输出可被程序消费
run(
  "cli.json",
  ["bin/deskshell.ts", "run", "downloads-cleanup", "--json", "--mode", "preview", "--root", ".demo/downloads"],
  (o) => {
    try {
      const d = JSON.parse(o) as { ok?: boolean; steps?: unknown[] };
      return d.ok === true && Array.isArray(d.steps) && d.steps.length === 20;
    } catch {
      return false;
    }
  },
);

// 5) 草稿预览（不需要 GUI）
run("draft.preview", ["apps/cli-demo/run.ts", "--skill", "packages/skills/notepad-demo/index.ts", "--mode", "preview"], (o) => o.includes("step-1"));

// 6) 审计日志：跑一次再渲染
run("journal.fixture", ["scripts/make-fixture.ts", ".demo/journal-test"], (o) => o.includes("files"));run("journal.apply", ["bin/deskshell.ts", "run", "downloads-cleanup", "--mode", "apply", "--root", ".demo/journal-test"], (o) => o.includes("✓"));
run("cli.journal", ["bin/deskshell.ts", "journal", "--root", ".demo/journal-test"], (o) => o.includes("20 步"));

// 7) 安装外部 skill
run(
  "cli.add",
  ["bin/deskshell.ts", "add", "packages/skills/first-skill", "--dir", ".demo/skills-lib", "--force"],
  (o) => o.includes("已安装 first-skill"),
);

// 8) 示例参数 + 按任务撤销
run(
  "cli.example",
  ["bin/deskshell.ts", "run", "downloads-cleanup", "--example", "basic", "--json", "--root", ".demo/downloads"],
  (o) => o.includes('"ok":true'),
);
run("undo.task", ["scripts/undo-test.ts"], (o) => o.includes("PASS"));

// 9) 环境自检 + 失败回滚演示
run("doctor", ["scripts/doctor.ts"], (o) => o.includes("0 failed"));
run("doctor.json", ["scripts/doctor.ts", "--json"], (o) => o.includes('"ok":true'));
run("fail.story", ["apps/cli-demo/fail-story.ts"], (o) => o.includes("PASS"));
run("journal.failed", ["bin/deskshell.ts", "journal", "--root", ".demo/fail-story"], (o) => o.includes("失败 1 步"));

// 4) 驱动契约（内存驱动，验证内核对平台无感）
run("contract", ["scripts/contract-test.ts"], (o) => o.includes("11/11 passed"));

// 5) 预览快照：内核升级不能悄悄改变既有 skill 的计划
run("snapshots", ["scripts/snapshot-test.ts"], (o) => o.includes("2/2 snapshots match"));

// 5) 文档站
run("docs.build", ["scripts/build-docs.ts"], (o) => /built \d+ pages/.test(o));

console.log("");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(14)} ${r.detail === "ok" ? "" : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
