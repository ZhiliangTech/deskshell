import fs from "node:fs";
import path from "node:path";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import { run } from "../packages/core/src/kernel.ts";
import { findNode, checkAssertion } from "../packages/core/src/executor.ts";
import { validateManifest } from "../packages/core/src/manifest.ts";
import type { Action, CapabilityId, Skill } from "../packages/core/src/types.ts";

const root = path.resolve(".demo/contract");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const journal = path.join(root, "journal.jsonl");
const driver = new MockDriver();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => boolean | Promise<boolean>, detail = ""): Promise<void> {
  return (async () => {
    try {
      const ok = await fn();
      results.push({ name, ok, detail: ok ? "" : detail || "断言失败" });
    } catch (err) {
      results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  })();
}

function makeSkill(actions: Action[], caps: string[] = ["ui.read", "ui.input", "fs.read", "fs.write"]): Skill {
  return {
    manifest: {
      name: "contract",
      version: "0.0.0",
      description: "contract test",
      entry: "./index.ts",
      capabilities: caps.map((id) => ({
        id: id as CapabilityId,
        scope: id.startsWith("fs.") ? root : "mock",
        reason: "契约测试",
      })),
    },
    async plan() {
      return actions;
    },
  };
}

// 1) 驱动接口：树遍历
await check("driver.tree", async () => {
  const tree = await driver.tree({ titleRegex: "Mock" });
  const editor = findNode(tree, { automationId: "editor" });
  return editor?.controlType === "Document";
}, "找不到 editor 节点");

// 2) 输入 + ui.value 断言通过
await check("ui.type+assert", async () => {
  const skill = makeSkill([
    {
      id: "type",
      kind: "ui.type",
      window: "Mock Window",
      selector: { automationId: "editor" },
      text: "hello",
      post: [{ kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, equals: "hello" }],
      undo: null,
    },
  ]);
  const report = await run(skill, { root }, { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: journal }, { driver });
  return report.steps[0]?.status === "ok";
}, "输入后断言未通过");

// 3) 断言失败必须阻断
await check("assert.blocks", async () => {
  const skill = makeSkill([
    {
      id: "bad",
      kind: "ui.type",
      window: "Mock Window",
      selector: { automationId: "editor" },
      text: "world",
      post: [{ kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, equals: "never" }],
      undo: null,
    },
  ]);
  const report = await run(skill, { root }, { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: journal }, { driver });
  return report.steps[0]?.status === "failed";
}, "错误断言竟然通过了");

// 4) 跨域事务：文件写入 + UI 失败 → 文件必须回滚
await check("rollback.cross-domain", async () => {
  const target = path.join(root, "should-be-gone.md");
  const skill = makeSkill([
    {
      id: "write",
      kind: "fs.write",
      path: target,
      content: "temp",
      post: [{ kind: "path.exists", path: target }],
      undo: { kind: "fs.restore", path: target, content: null },
    },
    {
      id: "ui-fail",
      kind: "ui.type",
      window: "Mock Window",
      selector: { automationId: "editor" },
      text: "x",
      post: [{ kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, equals: "impossible" }],
      undo: null,
    },
  ]);
  const report = await run(skill, { root }, { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: journal }, { driver });
  const existed = fs.existsSync(target);
  return report.rolledBack === 1 && !existed;
}, "文件没有被回滚");

// 5) invoke 走驱动且状态改变
await check("ui.invoke", async () => {
  const before = driver.treeData.children[1].enabled;
  const skill = makeSkill([
    { id: "ok", kind: "ui.invoke", window: "Mock Window", selector: { automationId: "ok" }, post: [], undo: null },
  ]);
  await run(skill, { root }, { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: journal }, { driver });
  return before === true && driver.treeData.children[1].enabled === false && driver.calls.some((c) => c.startsWith("invoke:"));
}, "invoke 未生效");

// 6) 能力未授予 → 整体拒绝
await check("policy.deny", async () => {
  const skill = makeSkill([{ id: "noop", kind: "ui.click", window: "Mock Window", selector: { automationId: "ok" }, undo: null }], ["ui.read"]);
  try {
    await run(skill, { root }, { mode: "apply", root, granted: ["ui.read"], journalPath: journal }, { driver });
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes("ui.input");
  }
}, "没有拒绝未授权的能力");

// 7) 窗口几何：移动 → 断言 → 撤销还原（独立日志，避免与其他用例互相影响）
await check("window.move+undo", async () => {
  const moveJournal = path.join(root, "journal-move.jsonl");
  fs.rmSync(moveJournal, { force: true });
  const before = await driver.bounds({ titleRegex: "Mock Window" });
  const target = { x: 120, y: 80, w: 500, h: 400 };
  const skill = makeSkill([
    {
      id: "tile",
      kind: "window.move",
      window: "Mock Window",
      rect: target,
      post: [{ kind: "window.rect", window: "Mock Window", rect: target, tolerance: 1 }],
      undo: { kind: "window.move", window: "Mock Window", rect: before },
    },
  ]);
  const report = await run(skill, { root }, { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: moveJournal }, { driver });
  const moved = await driver.bounds({ titleRegex: "Mock Window" });
  const undoReport = await run(skill, { root }, { mode: "undo", root, granted: [], journalPath: moveJournal }, { driver });
  const restored = await driver.bounds({ titleRegex: "Mock Window" });
  const ok =
    report.steps[0]?.status === "ok" &&
    moved.x === target.x &&
    undoReport.rolledBack === 1 &&
    restored.x === before.x &&
    restored.w === before.w;
  if (!ok) {
    (globalThis as Record<string, unknown>).__moveDebug = {
      apply: report.steps[0]?.status,
      moved,
      target,
      undoRolled: undoReport.rolledBack,
      restored,
      before,
    };
  }
  return ok;
}, "窗口移动或撤销失败");

// 8) 窗口出现断言：存在则通过，不存在则按超时失败
await check("window.exists", async () => {
  const hit = await checkAssertion(
    { kind: "window.exists", window: "Mock Window", timeoutMs: 300 },
    { root, driver },
  );
  const miss = await checkAssertion(
    { kind: "window.exists", window: "No Such Window", timeoutMs: 300 },
    { root, driver },
  );
  return hit === true && miss === false;
}, "window.exists 判定不对");

// 9) 控件存在断言
await check("ui.exists", async () => {
  const hit = await checkAssertion(
    { kind: "ui.exists", window: "Mock Window", selector: { automationId: "editor" } },
    { root, driver },
  );
  const miss = await checkAssertion(
    { kind: "ui.exists", window: "Mock Window", selector: { automationId: "nope" } },
    { root, driver },
  );
  return hit === true && miss === false;
}, "ui.exists 判定不对");

// 10) 清单校验：合法通过，未知能力/空理由/未知平台必须被拒
await check("manifest.validate", async () => {
  const good = validateManifest({
    name: "ok",
    version: "0.1.0",
    description: "d",
    entry: "./index.ts",
    capabilities: [{ id: "fs.read", scope: "{{root}}", reason: "读文件" }],
  });
  const bad = validateManifest({
    name: "bad",
    version: "0.1.0",
    description: "d",
    entry: "./index.ts",
    capabilities: [{ id: "fs.destroy", reason: "" }],
    platforms: ["amiga"],
  });
  return good.ok && !bad.ok && bad.problems.some((p) => p.field === "capabilities[0].id");
}, "清单校验不符合预期");

// 11) 失败动作自身的副作用必须被撤销
await check("rollback.self", async () => {
  const target = path.join(root, "self.txt");
  const skill = makeSkill([
    {
      id: "write-then-fail",
      kind: "fs.write",
      path: target,
      content: "x",
      post: [{ kind: "path.exists", path: path.join(root, "never.txt") }],
      undo: { kind: "fs.restore", path: target, content: null },
    },
  ]);
  const report = await run(skill, { root }, { mode: "apply", root, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: path.join(root, "journal-self.jsonl") }, {});
  return report.steps[0]?.status === "failed" && !fs.existsSync(target) && report.rolledBack === 1;
}, "失败动作自身的副作用没有回滚");

// 12) 符号链接逃逸：root 内的 junction / 文件软链接不能把写入带出去
await check("symlink.escape", async () => {
  const base = path.join(root, "linkroot");
  const outside = path.join(root, "outside");
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const junction = path.join(base, "jump");
  fs.symlinkSync(outside, junction, "junction");

  // 注意：能力作用域必须绑定到 base，用外层 root 会在能力检查阶段就先失败，
  // 那样测不到符号链接这一层。
  const write = (target: string): Skill => ({
    manifest: {
      name: "symlink-probe",
      version: "0.0.0",
      description: "probe",
      entry: "./index.ts",
      capabilities: [{ id: "fs.write", scope: base, reason: "probe" }],
    },
    async plan() {
      return [{ id: "w", kind: "fs.write", path: target, content: "x", post: [], undo: null } as Action];
    },
  });

  const attempt = async (target: string): Promise<boolean> => {
    const skill = write(target);
    try {
      await run(
        skill,
        { root: base },
        { mode: "apply", root: base, granted: skill.manifest.capabilities.map((c) => c.id), journalPath: path.join(base, "j.jsonl") },
        {},
      );
      return false; // 没被拒绝
    } catch (err) {
      return /符号链接/.test(String(err));
    }
  };

  const dirEscapeBlocked = await attempt(path.join(junction, "pwn.txt"));

  // 文件级别软链接在 Windows 上需要额外权限；没有权限就跳过这一半
  let fileEscapeBlocked = true;
  try {
    const outsideFile = path.join(outside, "target.txt");
    fs.writeFileSync(outsideFile, "orig");
    const fileLink = path.join(base, "file-link");
    fs.symlinkSync(outsideFile, fileLink, "file");
    fileEscapeBlocked = await attempt(fileLink);
    if (fs.readFileSync(outsideFile, "utf8") !== "orig") fileEscapeBlocked = false;
  } catch {
    fileEscapeBlocked = true; // 无权限建软链接，跳过
  }

  const leaked = fs.existsSync(path.join(outside, "pwn.txt"));
  return dirEscapeBlocked && fileEscapeBlocked && !leaked;
}, "符号链接逃逸没有被拦截");

for (const r of results) {
  const dbg = r.name === "window.move+undo" ? (globalThis as Record<string, unknown>).__moveDebug : undefined;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(22)} ${r.detail}${dbg ? " " + JSON.stringify(dbg) : ""}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
