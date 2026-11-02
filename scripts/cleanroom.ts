/**
 * 独立副本回归：把源码树复制到系统临时目录，在那里跑一遍无桌面回归。
 *
 * 为什么需要它：STATUS 里一直写“冻结源码后的独立临时副本执行全量无桌面回归”，但那一步
 * 之前是手工做的 —— 手工步骤的问题是别人无法复核，而且容易只复制了自己记得的目录。
 * 这个脚本把“复制什么、在哪跑、怎么判定”固定下来：
 *
 *   1. 只复制源码与测试需要的目录（不含 .git / node_modules / .demo / site / .mail / .tmp）；
 *   2. 在副本里跑 `node scripts/regress.ts --headless`；
 *   3. 打印副本路径与回归摘要，退出码跟随回归结果。
 *
 * 用法: node scripts/cleanroom.ts [--keep]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyTree } from "../packages/core/src/copy.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");

/** 只复制这些：跑回归需要的全部内容，以及 npm 会带上的元数据文件 */
const ENTRIES = [
  "bin",
  "packages",
  "schema",
  "apps",
  "scripts",
  "snapshots",
  "docs",
  "brand",
  "spec",
  "rfcs",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "STATUS.md",
  "LICENSE",
  ".editorconfig",
  ".gitattributes",
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-cleanroom-"));
const copied: string[] = [];
const missing: string[] = [];

for (const entry of ENTRIES) {
  const src = path.join(ROOT, entry);
  if (!fs.existsSync(src)) {
    missing.push(entry);
    continue;
  }
  copyTree(src, path.join(dir, entry));
  copied.push(entry);
}

// 副本里不能有 .demo 之类的前一轮产物，否则“干净”就不成立了
for (const junk of [".demo", "site", ".mail", ".tmp", ".worklog", "node_modules", ".git"]) {
  if (fs.existsSync(path.join(dir, junk))) {
    fs.rmSync(path.join(dir, junk), { recursive: true, force: true });
  }
}

console.log(`cleanroom: ${dir}`);
console.log(`  复制 ${copied.length} 项${missing.length ? `，缺失 ${missing.join(", ")}` : ""}`);

const started = Date.now();
const run = spawnSync(process.execPath, ["scripts/regress.ts", "--headless"], {
  cwd: dir,
  encoding: "utf8",
  timeout: 30 * 60_000,
});

const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const tail = out.trimEnd().split("\n").slice(-4).join("\n");
console.log(tail);
console.log(`  用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

const failed = run.status !== 0;
if (!keep) fs.rmSync(dir, { recursive: true, force: true });
else console.log(`  保留副本：${dir}`);

process.exitCode = failed ? 1 : 0;
