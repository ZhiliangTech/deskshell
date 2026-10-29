import fs from "node:fs";
import path from "node:path";
import { isInside, isInsideReal } from "../packages/core/src/policy.ts";

/**
 * 路径策略的随机化测试（property-based）。
 * 用固定种子生成大量"可疑路径"，断言两件事：
 *   1) 词法上跳出 root 的路径必须被 isInside 拒绝；
 *   2) 经由 root 内 junction 指向外部的路径必须被 isInsideReal 拒绝。
 * 另外用一批安全路径做反向验证，避免策略退化成"一律拒绝"。
 */

const base = path.resolve(".demo/fuzz");
const root = path.join(base, "root");
const outside = path.join(base, "outside");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const junction = path.join(root, "jump");
fs.symlinkSync(outside, junction, "junction");

/** mulberry32：固定种子的伪随机，保证可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "..",
  "../..",
  "sub",
  "..\\..",
  "C:\\Windows",
  "C:/Windows",
  "\\\\?\\C:\\Windows",
  "/etc",
  "con",
  "x.",
  "x...",
  "x ",
  "文档",
  "тmp",
  "a".repeat(40),
  "",
  ".",
];

const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const rand = rng(20261029);

// 1) 随机拼路径：只要词法上真的跳出 root，就必须被拒
let escapeTrials = 0;
let escapeBad = "";
for (let i = 0; i < 2000; i++) {
  const n = 1 + Math.floor(rand() * 3);
  const parts: string[] = [];
  for (let j = 0; j < n; j++) parts.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]);
  const candidate = path.join(root, ...parts);
  const rel = path.relative(root, candidate);
  const escapes = rel.startsWith("..") || path.isAbsolute(rel);
  if (!escapes) continue;
  escapeTrials++;
  if (isInside(root, candidate)) escapeBad = candidate;
}
check(`随机逃逸路径全部被拒（${escapeTrials} 次）`, escapeBad === "", escapeBad);

// 2) 已知攻击向量：drive-absolute 与 UNC 一律拒绝
const HARD = [
  "C:\\Windows\\System32\\drivers\\etc\\hosts",
  "C:/Windows/System32",
  "\\\\?\\C:\\Windows",
  "/etc/passwd",
  "..",
  "../",
  "..\\..\\Windows",
  "sub/../../outside",
  "sub\\..\\..\\outside",
  "C:/Windows/System32/drivers/etc/hosts",
];
// 这些是 skill 直接传给动作的"绝对形式"路径，不是拼在 root 后面的相对段
const leaked = HARD.filter((h) => isInside(root, h));
check(`已知攻击向量全部被拒（${HARD.length} 条）`, leaked.length === 0, leaked.join(" | "));

// 3) junction 逃逸：任意文件名落到 junction 下都要被拒
let junctionBad = "";
for (let i = 0; i < 200; i++) {
  const name = `f${Math.floor(rand() * 1e6)}.txt`;
  const target = path.join(junction, name);
  if (isInsideReal(root, target)) junctionBad = target;
}
check("junction 下的任意目标都被 isInsideReal 拒绝", junctionBad === "", junctionBad);

// 4) 反向验证：root 内的正常路径必须通过（策略不能退化成全拒）
let safeBad = "";
for (let i = 0; i < 500; i++) {
  const name = `safe-${Math.floor(rand() * 1e6)}.txt`;
  const dir = ["", "sub", "sub/deep", "文档"][Math.floor(rand() * 4)];
  const target = path.join(root, dir, name);
  if (!isInside(root, target) || !isInsideReal(root, target)) safeBad = target;
}
check("root 内的正常路径全部通过（500 次）", safeBad === "", safeBad);

// 5) 边界：root 自身
check("root 自身算在内部", isInside(root, root) && isInsideReal(root, root));

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
