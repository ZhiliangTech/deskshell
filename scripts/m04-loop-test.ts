import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import type { Action, CapabilityId, Skill, UiNode } from "../packages/core/src/types.ts";

/**
 * M04：录制 → 草稿 → 补完断言 → 连跑三次结果一致。
 *
 * 这里刻意用真录制样本（spec/fixtures/recording-notepad.jsonl）生成草稿，
 * 再模拟"人把断言补完"，最后在 MockDriver 上回放三次。
 * 之所以不在真 Notepad 上回放：用户桌面上的窗口不属于测试夹具，碰它是越界。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const skillDir = path.resolve("packages/skills/m04-draft");
const recording = path.resolve("spec/fixtures/recording-notepad.jsonl");

check("录制样本存在", fs.existsSync(recording));

// 1) 从真录制生成草稿
if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
const draftOut = execFileSync(
  process.execPath,
  ["scripts/draft-skill.ts", "--recording", recording, "--name", "m04-draft", "--only", "Notepad"],
  { encoding: "utf8" },
);
check("草稿生成成功", /有效 \d+ → 合并后 \d+ 步/.test(draftOut), draftOut.trim().slice(-120));
check("草稿产出 plan.json", fs.existsSync(path.join(skillDir, "plan.json")));

interface Step {
  id: string;
  kind: "ui.click" | "ui.type";
  window: string;
  selector: Record<string, unknown>;
  text?: string;
  post: Array<Record<string, unknown>>;
  todo?: string | null;
}

const plan = JSON.parse(fs.readFileSync(path.join(skillDir, "plan.json"), "utf8")) as { steps: Step[] };
check("草稿至少一步", plan.steps.length >= 1, `${plan.steps.length} 步`);

// 2) 草稿的问题要能被看到：有的断言指向了噪声窗口（输入法），有的是空断言
const needsWork = plan.steps.filter(
  (s) => s.post.length === 0 || s.post.some((p) => String(p.window) !== s.window),
);
check(
  "草稿里确实存在需要人工修正的断言",
  needsWork.length > 0,
  needsWork.map((s) => s.id).join(","),
);

// 3) 补完：点击后至少断言同一窗口里该控件仍然存在
const completed: Step[] = plan.steps.map((s) => ({
  ...s,
  post: [{ kind: "ui.exists", window: s.window, selector: s.selector }],
}));

// 4) 用 MockDriver 造一个"Notepad"，回放三次
const notepadTree: UiNode = {
  name: "Notepad",
  automationId: "",
  controlType: "Window",
  className: "Notepad",
  enabled: true,
  value: null,
  x: 0,
  y: 0,
  w: 800,
  h: 600,
  children: [
    {
      name: "文本编辑器",
      automationId: "15",
      controlType: "Document",
      className: "Edit",
      enabled: true,
      value: "",
      x: 10,
      y: 10,
      w: 400,
      h: 200,
      children: [],
    },
  ],
};

const makeDriver = (): MockDriver => {
  const d = new MockDriver();
  d.windowsData = [{ name: "Notepad", className: "Notepad", pid: 1, x: 0, y: 0, w: 800, h: 600 }];
  d.treeData = structuredClone(notepadTree);
  return d;
};

const skill: Skill = {
  manifest: {
    name: "m04-completed",
    version: "0.1.0",
    description: "把草稿的断言补完后得到的 skill",
    entry: "./index.ts",
    capabilities: [
      { id: "ui.read", scope: "Notepad", reason: "读取记事本控件" },
      { id: "ui.input", scope: "Notepad", reason: "点击与输入" },
    ],
  },
  async plan() {
    return completed.map(
      (s) =>
        ({
          id: s.id,
          kind: s.kind,
          window: s.window,
          selector: s.selector,
          ...(s.text !== undefined ? { text: s.text } : {}),
          post: s.post,
          undo: { kind: "noop" },
        }) as unknown as Action,
    );
  },
};

const granted: CapabilityId[] = ["ui.read", "ui.input"];
const outcomes: string[] = [];
for (let i = 0; i < 3; i++) {
  const root = path.resolve(`.demo/m04/run-${i}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const report = await run(
    skill,
    { root },
    { mode: "apply", root, granted, journalPath: path.join(root, ".deskshell", "journal.jsonl") },
    { driver: makeDriver() },
  );
  outcomes.push(report.steps.map((s) => `${s.actionId}:${s.status}`).join("|"));
  check(`第 ${i + 1} 次回放全部断言通过`, report.steps.every((s) => s.status === "ok"), JSON.stringify(report.steps));
}

check("三次回放结果完全一致", new Set(outcomes).size === 1, outcomes.join(" / "));

// 5) 清理生成的草稿，避免污染 skill 列表
fs.rmSync(skillDir, { recursive: true, force: true });
void pathToFileURL;

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
