import fs from "node:fs";
import path from "node:path";

interface Sample {
  ts: number;
  type: "focus" | "click" | "window-open";
  window: string;
  controlType: string;
  name: string;
  automationId: string;
  value: string | null;
  x: number;
  y: number;
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce<Array<[string, string]>>((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, []),
);

const recording = args.recording;
const name = args.name ?? "recorded-skill";
if (!recording) {
  console.error("用法: node scripts/draft-skill.ts --recording <file.jsonl> --name <skill-name> [--only <regex>]");
  process.exit(2);
}

const samples = fs
  .readFileSync(recording, "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Sample);

// 1) 去掉连续重复帧
const events: Sample[] = [];
for (const s of samples) {
  const p = events[events.length - 1];
  const same =
    p &&
    p.type === s.type &&
    p.window === s.window &&
    p.controlType === s.controlType &&
    p.name === s.name &&
    p.value === s.value &&
    p.x === s.x &&
    p.y === s.y;
  if (!same) events.push(s);
}

const only = args.only ? new RegExp(args.only) : null;
const IGNORED_TYPES = new Set(["Window", "Pane", "Group", "Image", "Text"]);

// 2) 选出可执行的事件（点击、有输入的焦点），window-open 只用来推断断言
const meaningful: Sample[] = [];
for (const e of events) {
  if (!e.window || !e.controlType) continue;
  if (only && !only.test(e.window)) continue;
  const isClick = e.type === "click";
  const isTyping = e.type === "focus" && !!e.value;
  if (!isClick && !isTyping) continue;
  if (IGNORED_TYPES.has(e.controlType)) continue;
  meaningful.push(e);
}

// 3) 输入过程会被采样成多个前缀值，只保留最后一次
const collapsed: Sample[] = [];
for (const e of meaningful) {
  const prev = collapsed[collapsed.length - 1];
  const sameTarget =
    prev &&
    prev.type === e.type &&
    prev.window === e.window &&
    prev.controlType === e.controlType &&
    prev.name === e.name &&
    (e.type === "focus" ? (prev.value ?? "").length <= (e.value ?? "").length : prev.x === e.x && prev.y === e.y);
  if (sameTarget) collapsed[collapsed.length - 1] = e;
  else collapsed.push(e);
}

/** 点击后 3 秒内出现新窗口 → 用"窗口出现"作为这条点击的断言 */
function openedWindowAfter(click: Sample): Sample | undefined {
  return events.find(
    (e) => e.type === "window-open" && e.ts > click.ts && e.ts - click.ts <= 3000,
  );
}

/** 没有新窗口时，看看焦点是不是落到了另一个控件上——那是"点击改变了界面"的第二种信号 */
function focusAfter(click: Sample): Sample | undefined {
  return events.find(
    (e) =>
      e.type === "focus" &&
      e.ts > click.ts &&
      e.ts - click.ts <= 2500 &&
      e.controlType !== "Window" &&
      e.controlType !== "Pane" &&
      (e.automationId || e.name) &&
      (e.automationId !== click.automationId || e.name !== click.name),
  );
}

const stableWindow = (w: string): string => w.split(" - ").pop() ?? w;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 能力作用域必须是真实窗口名：占位符会被策略层拒绝，草稿也就跑不起来
const windowScopes = [...new Set(collapsed.map((e) => stableWindow(e.window)))].filter(Boolean);
const scope = windowScopes.length ? windowScopes.map(escapeRegex).join("|") : ".*";

const steps = collapsed.map((e, i) => {
  const selector = {
    controlType: e.controlType,
    ...(e.name ? { name: e.name } : {}),
    ...(e.automationId ? { automationId: e.automationId } : {}),
  };
  const window = stableWindow(e.window);

  if (e.type === "click") {
    const opened = openedWindowAfter(e);
    const focused = opened ? undefined : focusAfter(e);
    let post = "[]";
    let todo = "// TODO: 点击后应该出现什么？";
    if (opened) {
      post = `[{ kind: "window.exists", window: ${JSON.stringify(escapeRegex(opened.window))}, timeoutMs: 2000 }]`;
      todo = "// 断言由录制推断：点击后新窗口出现";
    } else if (focused) {
      const focusSelector = {
        controlType: focused.controlType,
        ...(focused.name ? { name: focused.name } : {}),
        ...(focused.automationId ? { automationId: focused.automationId } : {}),
      };
      post = `[{ kind: "ui.exists", window: ${JSON.stringify(stableWindow(focused.window))}, selector: ${JSON.stringify(focusSelector)} }]`;
      todo = "// 断言由录制推断：点击后焦点落到该控件";
    }
    return `  {
    id: "step-${i + 1}",
    kind: "ui.click",
    window: ${JSON.stringify(window)},
    selector: ${JSON.stringify(selector)},
    risk: "low",
    post: ${post}, ${todo}
    undo: null,
  },`;
  }

  return `  {
    id: "step-${i + 1}",
    kind: "ui.type",
    window: ${JSON.stringify(window)},
    selector: ${JSON.stringify(selector)},
    text: ${JSON.stringify(e.value)},
    risk: "low",
    post: [{ kind: "ui.value", window: ${JSON.stringify(window)}, selector: ${JSON.stringify(selector)}, equals: ${JSON.stringify(e.value)} }],
    undo: null,
  },`;
});

const dir = path.join("packages", "skills", name);
fs.mkdirSync(dir, { recursive: true });

const clicks = collapsed.filter((e) => e.type === "click");
const inferred = clicks.filter((c) => openedWindowAfter(c) !== undefined).length;

const manifest = {
  name,
  version: "0.1.0",
  description: `由录制生成：${collapsed.length} 步（${clicks.length} 次点击，${inferred} 条断言自动推断）`,
  entry: "./index.ts",
  capabilities: [
    { id: "ui.read", scope, reason: "回放录制时的界面观察" },
    { id: "ui.input", scope, reason: "回放录制时的点击与输入" },
  ],
};
fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

const source = `// 由 scripts/draft-skill.ts 从录制生成 —— 草稿，需要人工补断言与撤销策略
import fs from "node:fs";
import path from "node:path";
import type { Action, Skill } from "../../core/src/types.ts";

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),
  async plan(): Promise<Action[]> {
    return [
${steps.join("\n")}
    ];
  },
};

export default skill;
`;
fs.writeFileSync(path.join(dir, "index.ts"), source, "utf8");

console.log(`[草稿] ${dir}/index.ts`);
console.log(`  · 采样事件 ${events.length} → 有效 ${meaningful.length} → 合并后 ${collapsed.length} 步`);
console.log(`  · 点击 ${clicks.length} 次，其中 ${inferred} 次通过"新窗口出现"自动推断出断言`);
console.log(`  · 输入 ${collapsed.filter((e) => e.type === "focus").length} 次，断言为 ui.value`);
console.log(`\n预览： node apps/cli-demo/run.ts --skill packages/skills/${name}/index.ts --mode preview`);
