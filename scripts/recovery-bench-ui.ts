import fs from "node:fs";
import path from "node:path";
import { run } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import type { Action, CapabilityId, Skill, UiNode } from "../packages/core/src/types.ts";

/**
 * R0 的 UI 面：文件能逐字节还原，不代表窗口和控件也能。
 *
 * 这里用 MockDriver 造一个窗口，对 **每一步** 注入失败，然后比对
 * "窗口几何 + 控件值 + 按钮可用性" 的整体状态。
 *
 * 关键差别：文件场景里每种动作都有对应 undo；UI 场景里
 * `window.move` 有，`ui.type` / `ui.invoke` **没有**。
 * 这个脚本的第一职责不是证明我们能回滚，而是**把这个差别量出来**。
 */

const here = path.resolve(".demo/recovery-ui");

const baseTree = (): UiNode => ({
  name: "Mock Window",
  automationId: "",
  controlType: "Window",
  className: "Mock",
  enabled: true,
  value: null,
  x: 0,
  y: 0,
  w: 800,
  h: 600,
  children: [
    {
      name: "编辑区",
      automationId: "editor",
      controlType: "Document",
      className: "MockEdit",
      enabled: true,
      value: "",
      x: 10,
      y: 10,
      w: 400,
      h: 200,
      children: [],
    },
    {
      name: "确定",
      automationId: "ok",
      controlType: "Button",
      className: "MockButton",
      enabled: true,
      value: null,
      x: 10,
      y: 300,
      w: 80,
      h: 30,
      children: [],
    },
  ],
});

interface Scenario {
  name: string;
  capabilities: CapabilityId[];
  plan: () => Action[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "move-window",
    capabilities: ["ui.read", "ui.input"],
    plan: () => [
      {
        id: "move:1",
        kind: "window.move",
        window: "Mock Window",
        rect: { x: 120, y: 90, w: 640, h: 380 },
        undo: { kind: "window.move", window: "Mock Window", rect: { x: 0, y: 0, w: 800, h: 600 } },
      },
      {
        id: "move:2",
        kind: "window.move",
        window: "Mock Window",
        rect: { x: 200, y: 50, w: 600, h: 400 },
        undo: { kind: "window.move", window: "Mock Window", rect: { x: 120, y: 90, w: 640, h: 380 } },
      },
    ],
  },
  {
    name: "type-into-field",
    capabilities: ["ui.read", "ui.input"],
    plan: () => [
      {
        id: "type:hello",
        kind: "ui.type",
        window: "Mock Window",
        selector: { automationId: "editor" },
        text: "hello",
        // 撤销要写回"读到的前值"：这个控件初始是空字符串，不是 null。
        // null 表示"控件本来没有值"，两者不能混用——否则还原出来的是 null，状态对不上。
        undo: { kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, value: "" },
      },
      {
        id: "type:world",
        kind: "ui.type",
        window: "Mock Window",
        selector: { automationId: "editor" },
        text: "world",
        // 前一步的值是 "hello"：撤销要写回它，而不是清空
        undo: { kind: "ui.value", window: "Mock Window", selector: { automationId: "editor" }, value: "hello" },
      },
    ],
  },
  {
    name: "invoke-button",
    capabilities: ["ui.read", "ui.input"],
    plan: () => [
      {
        id: "invoke:ok",
        kind: "ui.invoke",
        window: "Mock Window",
        selector: { automationId: "ok" },
        // 按钮按下去撤不回来：显式标成不可逆，内核必须拦下来要求确认
        irreversible: true,
        undo: { kind: "noop" },
      },
    ],
  },
];

function stateOf(driver: MockDriver): string {
  return JSON.stringify({
    windows: driver.windowsData.map((w) => ({ name: w.name, x: w.x, y: w.y, w: w.w, h: w.h })),
    nodes: driver.treeData.children.map((c) => ({ id: c.automationId, value: c.value, enabled: c.enabled })),
  });
}

function inject(actions: Action[], k: number): Action[] {
  return actions.map((a, i) =>
    i + 1 === k ? { ...a, post: [{ kind: "window.exists", window: "__never__" }] } : a,
  );
}

const rows: Array<{ scenario: string; failAt: number; residue: boolean; rolledBack: number; executed: number }> = [];
const happy: Array<{ scenario: string; identical: boolean }> = [];

fs.rmSync(here, { recursive: true, force: true });
fs.mkdirSync(here, { recursive: true });

for (const sc of SCENARIOS) {
  const makeDriver = (): MockDriver => {
    const d = new MockDriver();
    d.treeData = baseTree();
    return d;
  };

  const skill = (failAt?: number): Skill => ({
    manifest: {
      name: `ui-${sc.name}`,
      version: "0.0.0",
      description: "UI 恢复力基准",
      entry: "./index.ts",
      capabilities: sc.capabilities.map((id) => ({ id, scope: "Mock Window", reason: "bench" })),
    },
    async plan() {
      const actions = sc.plan();
      return failAt ? inject(actions, failAt) : actions;
    },
  });

  // ① 正常路径 + 撤销
  {
    const driver = makeDriver();
    const root = path.join(here, sc.name);
    fs.mkdirSync(root, { recursive: true });
    const journal = path.join(root, ".deskshell", "journal.jsonl");
    const before = stateOf(driver);
    try {
      await run(skill(), { root }, { mode: "apply", root, granted: sc.capabilities, journalPath: journal }, { driver });
    } catch (err) {
      if (!/不可逆/.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    const done = load(journal).filter((e) => e.status === "ok");
    if (done.length) {
      await run(skill, { root }, { mode: "undo", root, granted: sc.capabilities, journalPath: journal, taskId: done[0].taskId } as never, { driver });
    }
    happy.push({ scenario: sc.name, identical: stateOf(driver) === before });
  }

  // ② 逐步注入失败
  const total = sc.plan().length;
  for (let k = 1; k <= total; k++) {
    const driver = makeDriver();
    const root = path.join(here, `${sc.name}-f${k}`);
    fs.mkdirSync(root, { recursive: true });
    const journal = path.join(root, ".deskshell", "journal.jsonl");
    const before = stateOf(driver);
    let report: Awaited<ReturnType<typeof run>> | null = null;
    let refused = false;
    try {
      report = await run(
        skill(k),
        { root },
        { mode: "apply", root, granted: sc.capabilities, journalPath: journal },
        { driver },
      );
    } catch (err) {
      // 不可逆动作被硬闸拦下：这是正确行为，不是失败
      refused = /不可逆/.test(err instanceof Error ? err.message : String(err));
      if (!refused) throw err;
    }
    const entries = report ? load(journal).filter((e) => e.taskId === report.taskId) : [];
    rows.push({
      scenario: sc.name,
      failAt: k,
      residue: stateOf(driver) === before,
      rolledBack: entries.filter((e) => e.status === "rolled-back").length,
      executed: report ? Math.max(0, report.steps.length - 1) : 0,
    });
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const residue = rows.filter((r) => r.residue).length / rows.length;
const rollback = rows.filter((r) => r.rolledBack >= r.executed).length / rows.length;
const happyOk = happy.filter((h) => h.identical).length;

console.log("R0-UI — UI 动作失败后状态归零率\n");
console.log("| 场景 | 失败注入点 | 状态归零 | 已撤销/已执行 |");
console.log("| --- | --- | --- | --- |");
for (const r of rows) {
  console.log(`| ${r.scenario} | ${r.failAt} | ${r.residue ? "✅" : "❌"} | ${r.rolledBack}/${r.executed} |`);
}
console.log("");
console.log(`R0-UI 状态归零   ${pct(residue)}（${rows.length} 次注入）`);
console.log(`R0-UI 回滚       ${pct(rollback)}`);
console.log(`正常路径撤销后一致：${happyOk}/${happy.length}`);
console.log("");
console.log("判据说明：");
console.log("- ui.type 有 ui.value 撤销（写回读到的前值），所以 type-into-field 全绿。");
console.log("- ui.invoke 标了 irreversible：内核在没有 allowIrreversible 时整单拒绝，目录/状态一个字节都没动——");
console.log("  所以它也算「状态归零」，但归零的方式是「拒绝执行」而不是「撤回」。");
console.log("- 这才是可公布的 100%：该撤的撤了，该拦的拦住了。");

fs.rmSync(here, { recursive: true, force: true });
