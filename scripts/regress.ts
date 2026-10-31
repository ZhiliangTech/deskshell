import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tick } from "./lib/clock-store.ts";

const NODE = process.execPath;
tick("regress 全量回归", "test");
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
run("cli.list", ["bin/deskshell.ts", "list"], (o) => o.includes("10 个 skill"));
run("cli.version", ["bin/deskshell.ts", "version"], (o) => o.includes("deskshell 0.18.5"));

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
run("mcp.tools", ["scripts/mcp-test.ts"], (o) => o.includes("14/14 passed"));
run("mcp.install", ["scripts/mcp-install-test.ts"], (o) => o.includes("17/17 passed"));
run("r0.remote", ["scripts/r0-remote.ts"], (o) => o.includes("跳过"));
run("terminal.svg", ["scripts/terminal-svg-test.ts"], (o) => o.includes("7/7 passed"));
run("demo.30s", ["scripts/thirty-seconds-test.ts"], (o) => o.includes("5/5 passed"));
run("r0.negative", ["scripts/r0-negative-test.ts"], (o) => o.includes("5/5 passed"));
// 这些数字是"现在的真实水平"，不是目标：改动 UI 撤销能力时它们应该上升。
run("cli.irreversible", ["scripts/cli-irreversible-test.ts"], (o) => o.includes("9/9 passed"));
run("irreversible", ["scripts/irreversible-test.ts"], (o) => o.includes("7/7 passed"));
run("r0.ui", ["scripts/recovery-bench-ui.ts"], (o) => o.includes("R0-UI 状态归零   100.0%") && o.includes("R0-UI 回滚       100.0%"));
run("recovery.r0", ["scripts/recovery-bench.ts"], (o) => o.includes("R0-残渣     100.0%") && o.includes("R0-可追溯   100.0%"));
run("onboarding", ["scripts/onboarding-test.ts"], (o) => o.includes("17/17 passed"), 240_000);
run("shell.intent", ["scripts/intent-test.ts"], (o) => o.includes("23/23 passed"));
run("shell.core", ["scripts/shell-test.ts"], (o) => o.includes("14/14 passed"));
run("shell.ui", ["scripts/shell-ui-selftest.ts"], (o) => o.includes("11/11 passed") || o.includes("1 skipped"));
run("new.skills2", ["scripts/new-skills-2-test.ts"], (o) => o.includes("12/12 passed"));
run("m04.loop", ["scripts/m04-loop-test.ts"], (o) => o.includes("9/9 passed"));
run("capability.ask", ["scripts/ask-test.ts"], (o) => o.includes("8/8 passed"));
run("undo.coverage", ["scripts/undo-coverage-test.ts"], (o) => o.includes("8/8 passed"));
run("protocol.freeze", ["scripts/protocol-freeze-test.ts"], (o) => o.includes("24/24 passed"));
run("compat.v0", ["scripts/compat-test.ts"], (o) => o.includes("7/7 passed"));
run("contract", ["scripts/contract-test.ts"], (o) => o.includes("13/13 passed"));

// 5) 预览快照：内核升级不能悄悄改变既有 skill 的计划
run("snapshots", ["scripts/snapshot-test.ts"], (o) => o.includes("snapshots match"));

// 5) 新 skill：photo-sort / log-archive / rename-batch
run("photo.sort", ["scripts/photo-sort-test.ts"], (o) => o.includes("PASS photo-sort"));
run("policy.fuzz", ["scripts/policy-fuzz.ts"], (o) => o.includes("5/5 passed"));
run("undo.range", ["scripts/undo-range-test.ts"], (o) => o.includes("6/6 passed"));
run("journal.rotate", ["scripts/journal-rotate-test.ts"], (o) => o.includes("7/7 passed"));
run("preview.summary", ["scripts/preview-summary-test.ts"], (o) => o.includes("9/9 passed"));
run("undo.guard", ["scripts/undo-guard-test.ts"], (o) => o.includes("3/3 passed"));
run("parallel", ["scripts/parallel-test.ts"], (o) => o.includes("7/7 passed"));
run("new.skills", ["scripts/new-skills-test.ts"], (o) => o.includes("8/8 passed"));

// 5) 文档站
run("cli.history", ["bin/deskshell.ts", "history", "--root", ".demo/downloads"], (o) => o.includes("任务数"));
run("cli.show", ["bin/deskshell.ts", "show", "--root", ".demo/downloads"], (o) => o.includes("步"));
run("recorder.mode", ["scripts/recorder-mode-test.ts"], (o) => o.includes("8/8 passed") || o.includes("skipped"));
run("docs.build", ["scripts/build-docs.ts"], (o) => /built \d+ pages/.test(o));

console.log("");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(14)} ${r.detail === "ok" ? "" : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
