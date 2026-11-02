/**
 * 打包一致性检查：npm 包里必须真的含有 package.json 的 npm scripts 指向的文件。
 *
 * 为什么需要这个测试：这里没有构建步骤，CLI 与各入口都是直接被 node 运行的 .ts 文件。
 * 一旦 `files` 白名单漏掉某个脚本路径，`npm i -g deskshell` 之后那条命令就是死的，
 * 而本地源码树里它永远正常 —— 这类问题只有真的 pack 一次才看得见。
 *
 * 判定依据是 `npm pack --dry-run --json` 的真实清单，不是自己对 files 规则再实现一遍。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  files?: string[];
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
};

const problems: string[] = [];
let checks = 0;

function ok(condition: boolean, message: string): void {
  checks++;
  if (!condition) problems.push(message);
}

/** 取 `node <path> [args...]` 里的 path；不是 node 命令就返回 null */
function nodeTarget(command: string): string | null {
  const m = /^node\s+(\S+)/.exec(command.trim());
  return m ? m[1] : null;
}

const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  shell: process.platform === "win32",
  timeout: 120_000,
});

if (pack.status !== 0) {
  console.error("npm pack --dry-run 失败，无法判定打包内容：");
  console.error(`${pack.stdout ?? ""}${pack.stderr ?? ""}`.trim().slice(0, 800));
  process.exit(1);
}

/** @type {{ files: { path: string }[] }[]} */
const report = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
const packaged = new Set(report[0].files.map((f) => f.path.replace(/\\/g, "/")));

// 1) 每个 node脚本 的入口文件都必须在包里
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  const target = nodeTarget(command);
  if (!target) continue;
  ok(packaged.has(target), `npm run ${name} → ${target} 不在发布包里（检查 package.json 的 files）`);
}

// 2) 包里声明的东西都要在
for (const [name, file] of Object.entries(pkg.bin ?? {})) {
  ok(packaged.has(file), `bin.${name} → ${file} 不在发布包里`);
}
for (const file of ["package.json", "README.md", "LICENSE"]) {
  ok(packaged.has(file), `${file} 不在发布包里（npm 会自动带上，缺失说明 pack 结果异常）`);
}

// 3) package.json 里的 files 条目必须指向真实存在的路径，防止改名后白名单悄悄失效
for (const entry of pkg.files ?? []) {
  ok(fs.existsSync(path.join(ROOT, entry)), `files 里的 "${entry}" 在工作区不存在`);
}

// 4) 打包内容不能吃掉开发产物与本地状态
for (const junk of [".demo/", "node_modules/", "site/", ".git/", ".tmp/", ".mail/", ".worklog/", ".dsh-ops/", "outreach/"]) {
  const hit = [...packaged].find((f) => f.startsWith(junk));
  ok(hit === undefined, `发布包里混进了 ${junk}（${hit ?? ""}）`);
}

if (problems.length) {
  console.error(`Packaging checks FAILED: ${problems.length} 项`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

console.log(`Packaging checks passed: ${checks}（${packaged.size} 个文件）`);
