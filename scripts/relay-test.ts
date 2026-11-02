import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "../packages/core/src/journal.ts";
import { undoTask } from "../packages/core/src/kernel.ts";
import { RelayError, runRelay, stubBackend } from "../packages/relay/src/relay.ts";
import type { RelayBackend } from "../packages/relay/src/relay.ts";

/**
 * Relay 的管线测试：清单 → 调用 → 落盘 → 撤销 → 账本。
 *
 * 这里刻意**不测模型**：中转站的产品本体是这条管线，模型是可替换的一端。
 * 用 stub 后端就能把"发出去什么、写回来什么、能不能撤"全部验证掉。
 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-relay-"));
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function check(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

function fixture(name: string): { dir: string; journalPath: string } {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const journalPath = path.join(dir, ".deskshell", "journal.jsonl");
  fs.rmSync(journalPath, { force: true });
  return { dir, journalPath };
}

/** 记录调用次数的后端，用来证明 dry-run 真的没发出去 */
function countingBackend(): { backend: RelayBackend; calls: () => number } {
  let calls = 0;
  const inner = stubBackend({ id: "counting" });
  return {
    calls: () => calls,
    backend: {
      id: inner.id,
      vendor: inner.vendor,
      model: inner.model,
      async complete(input) {
        calls++;
        return inner.complete(input);
      },
    },
  };
}

// 1) 回显与清单
await check("清单与输出：字节数、摘要、不含绝对路径", async () => {
  const { dir, journalPath } = fixture("manifest");
  const file = path.join(dir, "note.md");
  fs.writeFileSync(file, "第一行\n第二行\n");
  const result = await runRelay({
    text: fs.readFileSync(file, "utf8"),
    label: "note.md",
    backend: stubBackend(),
    outPath: path.join(dir, "out.md"),
    journalPath,
  });
  assert.equal(result.manifest.label, "note.md");
  assert.ok(result.manifest.inputBytes > 0);
  assert.match(result.manifest.inputDigest, /^[0-9a-f]{64}$/);
  assert.ok(result.output.includes("第一行"), "stub 应把原文带回来");
  const manifestJson = JSON.stringify(result.manifest);
  assert.equal(manifestJson.includes(base), false, "外发清单里不能出现绝对路径");
  assert.equal(manifestJson.includes(dir), false);
});

// 2) dry-run：只出清单，不发送、不写盘
await check("dry-run 不调用后端也不写文件", async () => {
  const { dir, journalPath } = fixture("dry-run");
  const { backend, calls } = countingBackend();
  const out = path.join(dir, "out.md");
  const result = await runRelay({ text: "材料", label: "x.txt", backend, outPath: out, journalPath, dryRun: true });
  assert.equal(calls(), 0);
  assert.equal(fs.existsSync(out), false);
  assert.equal(result.manifest.inputBytes, Buffer.byteLength("材料"));
});

// 3) 写新文件 → 账本有记录 → 撤销后文件消失
await check("写新文件可撤销，且进账本", async () => {
  const { dir, journalPath } = fixture("new-file");
  const out = path.join(dir, "result.md");
  const result = await runRelay({ text: "原文", backend: stubBackend(), outPath: out, journalPath });
  assert.ok(fs.existsSync(out));
  assert.equal(fs.readFileSync(out, "utf8"), result.output);
  const entries = load(journalPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].skill, "relay");
  assert.equal(entries[0].kind, "fs.write");

  const undone = await undoTask(result.written!.taskId!, {
    mode: "undo",
    root: dir,
    granted: [],
    journalPath,
  });
  assert.equal(undone.rolledBack, 1);
  assert.equal(fs.existsSync(out), false, "新文件撤销后应被删除");
});

// 4) 覆盖已有文件 → 撤销后逐字节还原
await check("覆盖原文件后撤销逐字节还原", async () => {
  const { dir, journalPath } = fixture("overwrite");
  const out = path.join(dir, "doc.md");
  const original = "原始内容\r\n第二段\r\n";
  fs.writeFileSync(out, original, "utf8");
  const before = fs.readFileSync(out);

  const result = await runRelay({ text: "新内容", backend: stubBackend(), outPath: out, journalPath });
  assert.notEqual(fs.readFileSync(out, "utf8"), original);

  const undone = await undoTask(result.written!.taskId!, { mode: "undo", root: dir, granted: [], journalPath });
  assert.equal(undone.rolledBack, 1);
  assert.deepEqual(fs.readFileSync(out), before, "撤销必须逐字节还原（含换行符）");
});

// 5) 输入校验
await check("空输入与超大输入被拒绝", async () => {
  const { dir, journalPath } = fixture("limits");
  await assert.rejects(
    runRelay({ text: "   ", backend: stubBackend(), journalPath }),
    (error: unknown) => error instanceof RelayError && error.code === "EMPTY_INPUT",
  );
  await assert.rejects(
    runRelay({ text: "x".repeat(64), backend: stubBackend(), journalPath, maxInputBytes: 16 }),
    (error: unknown) => error instanceof RelayError && error.code === "INPUT_TOO_LARGE",
  );
});

// 6) 清单标签不能是路径（防止顺手把绝对路径带进清单）
await check("标签不接受路径", async () => {
  const { journalPath } = fixture("label");
  await assert.rejects(
    runRelay({ text: "x", label: "C:\\Users\\me\\secret.txt", backend: stubBackend(), journalPath }),
    (error: unknown) => error instanceof RelayError && error.code === "INVALID_LABEL",
  );
});

// 7) 直接点名道姓：不写文件时只返回结果，不碰账本
await check("只返回结果时不写账本", async () => {
  const { dir, journalPath } = fixture("stdout-only");
  const result = await runRelay({ text: "abc", backend: stubBackend(), journalPath });
  assert.equal(result.written, undefined);
  assert.ok(result.output.includes("abc"));
  assert.equal(fs.existsSync(path.join(dir, ".deskshell")), false);
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`Relay pipeline checks passed: ${passed}/${results.length}`);
fs.rmSync(base, { recursive: true, force: true });
