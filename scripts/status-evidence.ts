import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 生成 STATUS.md 的证据表：每条命令都真跑一遍，抓到关键那一行，
 * 直接用真实输出替换表格。任何一条失败都会让脚本以非零退出。
 *
 * 用法：
 *   node scripts/status-evidence.ts            # 打印表格
 *   node scripts/status-evidence.ts --write    # 同时写回 STATUS.md 的标记区
 */

const root = path.resolve(import.meta.dirname, "..");
const write = process.argv.includes("--write");

interface Row {
  capability: string;
  command: string;
  args: string[];
  /** 从输出里挑出要展示的那一行；返回 null 视为该行无输出 */
  pick?: (out: string) => string | null;
  /** 只有这些平台才跑 */
  platforms?: NodeJS.Platform[];
  note?: string;
}

const firstMatch = (re: RegExp) => (out: string): string | null => {
  const m = re.exec(out);
  return m ? m[0].trim() : null;
};

const ROWS: Row[] = [
  {
    capability: "版本与平台",
    command: "deskshell version",
    args: ["bin/deskshell.ts", "version"],
    pick: (o) => o.trim(),
  },
  {
    capability: "环境自检",
    command: "deskshell doctor",
    args: ["scripts/doctor.ts"],
    pick: firstMatch(/\d+ passed, \d+ warning, \d+ failed/),
  },
  {
    capability: "驱动自检",
    command: "scripts/verify-driver.ts",
    args: ["scripts/verify-driver.ts"],
    pick: firstMatch(/\d+ passed, \d+ failed/),
    platforms: ["win32", "darwin"],
  },
  {
    capability: "驱动契约（内存驱动）",
    command: "scripts/contract-test.ts",
    args: ["scripts/contract-test.ts"],
    pick: firstMatch(/\d+\/\d+ passed/),
  },
  {
    capability: "预览快照",
    command: "scripts/snapshot-test.ts",
    args: ["scripts/snapshot-test.ts"],
    pick: firstMatch(/\d+\/\d+ snapshots match/),
  },
  {
    capability: "全量回归",
    command: "scripts/regress.ts",
    args: ["scripts/regress.ts"],
    pick: firstMatch(/\d+\/\d+ passed/),
  },
  {
    capability: "照片按月份归档",
    command: "scripts/photo-sort-test.ts",
    args: ["scripts/photo-sort-test.ts"],
    pick: firstMatch(/files \d+ → \d+ → \d+（原始 \d+）/),
  },
  {
    capability: "日志归档 + 批量改名",
    command: "scripts/new-skills-test.ts",
    args: ["scripts/new-skills-test.ts"],
    pick: firstMatch(/\d+\/\d+ passed/),
  },
  {
    capability: "指定任务撤销（幂等）",
    command: "scripts/undo-test.ts",
    args: ["scripts/undo-test.ts"],
    pick: (o) => (o.includes("PASS") ? "PASS（第二次撤销 0 步）" : null),
  },
  {
    capability: "性能基准（1000 文件）",
    command: "scripts/bench.ts 1000",
    args: ["scripts/bench.ts", "1000"],
    pick: (o) => {
      const apply = /apply\s+(\d+) ms\s+\(耗时\/步 ([\d.]+) ms\)/.exec(o);
      const plan = /plan\s+(\d+) ms/.exec(o);
      return apply && plan ? `plan ${plan[1]} ms · apply ${apply[1]} ms（${apply[2]} ms/步）` : null;
    },
  },
  {
    capability: "文档站构建",
    command: "scripts/build-docs.ts",
    args: ["scripts/build-docs.ts"],
    pick: firstMatch(/built \d+ pages/),
  },
];

const node = process.execPath;
const lines: string[] = [];
let failures = 0;

for (const row of ROWS) {
  if (row.platforms && !row.platforms.includes(process.platform)) {
    lines.push(`| ${row.capability} | \`${row.command}\` | 本平台不适用（仅 ${row.platforms.join("/")}） |`);
    continue;
  }
  const started = Date.now();
  let out = "";
  let ok = true;
  try {
    out = execFileSync(node, row.args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    ok = false;
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
  const picked = row.pick ? row.pick(out) : out.split("\n")[0];
  const ms = Date.now() - started;
  if (!ok || !picked) failures++;
  const cell = picked ? `\`${picked.replace(/\|/g, "\\|")}\`` : "**无输出**";
  lines.push(`| ${row.capability} | \`${row.command}\` | ${cell} |`);
  console.error(`${ok && picked ? "PASS" : "FAIL"}  ${row.capability.padEnd(18)} ${ms} ms`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
};
const tsFiles = fs
  .readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.startsWith(".demo") && !f.startsWith("site"))
  .length;
const skillDirs = fs.readdirSync(path.join(root, "packages", "skills"), { withFileTypes: true }).filter((d) =>
  d.isDirectory(),
);
const internal = skillDirs.filter((d) => {
  const m = path.join(root, "packages", "skills", d.name, "skill.json");
  return fs.existsSync(m) && JSON.parse(fs.readFileSync(m, "utf8")).internal === true;
}).length;
const pages = fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).length;

const now = new Date().toISOString().slice(0, 10);
const block = [
  `<!-- EVIDENCE:START（由 scripts/status-evidence.ts 生成，勿手改） -->`,
  `- 版本：\`deskshell ${pkg.version}\`（协议 v0）`,
  `- 环境：${process.platform} / Node ${process.versions.node} / ${now}`,
  `- 规模：${tsFiles} 个 TS 文件，${skillDirs.length} 个 skill（${skillDirs.length - internal} 公开 / ${internal} 内部），${pages} 页文档 × 2 语言`,
  "",
  "| 能力 | 命令 | 实测输出 |",
  "| --- | --- | --- |",
  ...lines,
  `<!-- EVIDENCE:END -->`,
].join("\n");

if (write) {
  const statusPath = path.join(root, "STATUS.md");
  const current = fs.readFileSync(statusPath, "utf8");
  const re = /<!-- EVIDENCE:START[\s\S]*?<!-- EVIDENCE:END -->/;
  if (!re.test(current)) {
    console.error("STATUS.md 里找不到 EVIDENCE 标记区");
    process.exit(2);
  }
  fs.writeFileSync(statusPath, current.replace(re, block), "utf8");
  console.error("STATUS.md 已更新");
} else {
  console.log(block);
}

console.error(`\n${ROWS.length - failures}/${ROWS.length} 行有真实输出`);
process.exitCode = failures ? 1 : 0;
