import fs from "node:fs";
import path from "node:path";
import { PolicyError, run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { validateManifest } from "../packages/core/src/manifest.ts";
import type { Action, CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 兼容性测试：v0 冻结时写下的动作序列，必须在新内核上继续跑通并能撤销。
 * 样本是数据（spec/fixtures/*.json），不是代码——这样它不会跟着实现一起漂。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const subst = (value: unknown, root: string): unknown => {
  if (typeof value === "string") return value.replaceAll("{{root}}", root);
  if (Array.isArray(value)) return value.map((v) => subst(v, root));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = subst(v, root);
    return out;
  }
  return value;
};

interface LegacySample {
  manifest: Record<string, unknown>;
  actions: Action[];
  expect: { afterApply: { files: string[]; content: string }; afterUndo: { files: string[] } };
}

const dir = path.resolve(".demo/compat");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const sample = JSON.parse(
  fs.readFileSync(path.resolve("spec/fixtures/v0-legacy-sample.json"), "utf8"),
) as LegacySample;

// 1) 老清单仍然被接受
const manifestCheck = validateManifest(sample.manifest);
check("v0 样本清单通过校验", manifestCheck.ok, JSON.stringify(manifestCheck.problems));

// 2) 老的写法（没有 protocol 字段）也能跑
const skill: Skill = {
  manifest: sample.manifest as unknown as Skill["manifest"],
  async plan() {
    return subst(sample.actions, dir) as Action[];
  },
};

const journal = path.join(dir, ".deskshell", "journal.jsonl");
const granted = (skill.manifest.capabilities as Array<{ id: string }>).map((c) => c.id) as CapabilityId[];

const applied = await run(skill, { root: dir }, { mode: "apply", root: dir, granted, journalPath: journal }, {});
check("v0 动作序列执行成功", applied.steps.every((s) => s.status === "ok"), JSON.stringify(applied.steps));

const yPath = path.join(dir, "a", "y.txt");
check(
  "执行后文件落在预期位置且内容正确",
  fs.existsSync(yPath) && fs.readFileSync(yPath, "utf8") === sample.expect.afterApply.content,
);
check("执行后 x.txt 已不存在", !fs.existsSync(path.join(dir, "a", "x.txt")));

// 3) 撤销回到空目录
const taskId = load(journal)[0]?.taskId;
const undone = await undoTask(taskId, { mode: "undo", root: dir, granted, journalPath: journal }, {});
check("撤销全部成功", undone.rolledBack === applied.steps.length, `${undone.rolledBack}/${applied.steps.length}`);
const leftovers = fs.existsSync(path.join(dir, "a")) ? fs.readdirSync(path.join(dir, "a")) : [];
check("撤销后目录清空", leftovers.length === 0 && !fs.existsSync(path.join(dir, "a")));

// 4) 策略层仍然生效：声明 fs.read 却做 fs.mkdir 必须被拒
const bogus: Skill = {
  manifest: {
    name: "bogus-capability",
    version: "0.1.0",
    description: "只声明 fs.read，却试图建目录",
    entry: "./index.ts",
    capabilities: [{ id: "fs.read", scope: dir, reason: "r" }],
  },
  async plan() {
    return [
      {
        id: "mkdir-z",
        kind: "fs.mkdir",
        path: path.join(dir, "z"),
        post: [{ kind: "path.exists", path: path.join(dir, "z") }],
        undo: { kind: "fs.rmdir", path: path.join(dir, "z") },
      } as Action,
    ];
  },
};

let policyHeld = false;
try {
  await run(bogus, { root: dir }, { mode: "apply", root: dir, granted: ["fs.read"], journalPath: path.join(dir, "j2.jsonl") }, {});
} catch (err) {
  // PolicyError 的 message 不含细节，要看 reasons
  policyHeld =
    err instanceof PolicyError
      ? err.reasons.some((r) => r.includes("fs.write"))
      : /需要能力/.test(String(err));
}
check("未声明能力时动作被拒（策略仍生效）", policyHeld);

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
