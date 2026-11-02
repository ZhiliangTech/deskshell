/**
 * Effect Ledger v0 一致性测试。
 *
 * 同一套 vectors.json 分别跑在：
 *   - 内核适配实现（scripts/effect-ledger-adapter.ts）
 *   - 独立最小实现（spec/effect-ledger/v0/impl-mini.ts，不引用内核）
 * `--compare` 要求两者逐条一致——这就是"协议"和"一个项目的实现"的分界线。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKernelImpl } from "./effect-ledger-adapter.ts";
import { createMini } from "../spec/effect-ledger/v0/impl-mini.ts";

const argv = process.argv.slice(2);
const only = argv.includes("--impl") ? argv[argv.indexOf("--impl") + 1] : undefined;
const compare = argv.includes("--compare");

interface VectorStep {
  op: string;
  [key: string]: any;
}
interface VectorCase {
  id: string;
  title: string;
  steps: VectorStep[];
}

const spec = JSON.parse(
  fs.readFileSync(path.resolve("spec/effect-ledger/v0/vectors.json"), "utf8"),
) as { cases: VectorCase[] };

const kinds = only ? [only] : compare ? ["kernel", "mini"] : ["kernel", "mini"];

function make(kind: string, dir: string) {
  if (kind === "mini") return createMini(dir);
  if (kind === "kernel") return createKernelImpl(dir);
  throw new Error(`未知实现：${kind}`);
}

async function runCase(kind: string, c: VectorCase, dir: string): Promise<Array<Record<string, any>>> {
  const impl = make(kind, dir);
  const out: Array<Record<string, any>> = [];
  for (const step of c.steps) {
    if (step.op === "seed" || step.op === "mutate") {
      const file = path.join(dir, step.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, step.content, "utf8");
      continue;
    }
    if (step.op === "appendRaw") {
      fs.mkdirSync(path.dirname(impl.ledgerPath), { recursive: true });
      fs.appendFileSync(impl.ledgerPath, `${step.line}\n`, "utf8");
      continue;
    }
    if (step.op === "apply") {
      const r = await impl.apply(step.action);
      out.push(step.expect.reason ? { status: r.status, reason: r.reason } : { status: r.status });
      continue;
    }
    if (step.op === "revert") {
      const r = await impl.revert(step.target);
      out.push(step.expect.reason ? { status: r.status, reason: r.reason } : { status: r.status });
      continue;
    }
    if (step.op === "read") {
      const r = impl.read(step.path);
      out.push(r.exists ? { exists: true, content: r.content } : { exists: false });
      continue;
    }
    if (step.op === "ledger") {
      const entries = await impl.ledger();
      out.push({
        count: entries.length,
        ...(step.expect.statuses ? { statuses: entries.map((e) => String(e.status)) } : {}),
      });
      continue;
    }
    throw new Error(`未知 step: ${step.op}`);
  }
  return out;
}

function mismatch(expectObj: Record<string, any>, actual: Record<string, any>): string | null {
  for (const key of Object.keys(expectObj)) {
    if (JSON.stringify(expectObj[key]) !== JSON.stringify(actual[key])) {
      return `${key}: 期望 ${JSON.stringify(expectObj[key])}，实际 ${JSON.stringify(actual[key])}`;
    }
  }
  return null;
}

const results: Array<{ id: string; kind: string; ok: boolean; detail?: string }> = [];
const base = fs.mkdtempSync(path.join(os.tmpdir(), "effect-ledger-"));

for (const c of spec.cases) {
  for (const kind of kinds) {
    const dir = path.join(base, `${c.id}-${kind}`);
    fs.mkdirSync(dir, { recursive: true });
    let ok = true;
    let detail: string | undefined;
    try {
      const actual = await runCase(kind, c, dir);
      const expects = c.steps.filter((s) => s.expect).map((s) => s.expect as Record<string, any>);
      if (actual.length !== expects.length) {
        ok = false;
        detail = `结果条数 ${actual.length} ≠ 期望 ${expects.length}`;
      } else {
        for (let i = 0; i < expects.length; i++) {
          const bad = mismatch(expects[i], actual[i]);
          if (bad) {
            ok = false;
            detail = `第 ${i + 1} 步 ${bad}`;
            break;
          }
        }
      }
    } catch (error) {
      ok = false;
      detail = error instanceof Error ? error.message : String(error);
    }
    results.push({ id: c.id, kind, ok, detail });
  }
}

// --compare：两个实现的逐条结果必须完全相同（不只是各自通过）
if (compare) {
  for (const c of spec.cases) {
    const kernelDir = path.join(base, `${c.id}-kernel`);
    const miniDir = path.join(base, `${c.id}-mini`);
    try {
      const a = await runCase("kernel", c, kernelDir);
      const b = await runCase("mini", c, miniDir);
      const same = JSON.stringify(a) === JSON.stringify(b);
      results.push({ id: c.id, kind: "compare", ok: same, detail: same ? undefined : `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}` });
    } catch (error) {
      results.push({ id: c.id, kind: "compare", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.kind.padEnd(8)}${r.ok ? "" : `  → ${r.detail}`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nEffect Ledger v0 conformance: ${results.length - failed}/${results.length} passed`);
fs.rmSync(base, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
