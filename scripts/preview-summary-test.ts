import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run } from "../packages/core/src/kernel.ts";
import { makePhotoFixture } from "./make-photo-fixture.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 预览汇总：不执行任何动作，但要说清楚"会改什么、能不能撤、风险多大"。
 */
const root = path.resolve(".demo/preview-summary");
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

makePhotoFixture(root);
const journal = path.join(root, ".deskshell", "journal.jsonl");
const photo = (await import(pathToFileURL(path.resolve("packages/skills/photo-sort/index.ts")).href)) as {
  skill: Skill;
};

const report = await run(
  photo.skill,
  { root },
  { mode: "preview", root, granted: photo.skill.manifest.capabilities.map((c) => c.id) as CapabilityId[], journalPath: journal },
  {},
);

const sum = report.summary;
check("预览不写日志", !fs.existsSync(journal));
check("汇总存在", Boolean(sum));
if (sum) {
  check("统计到 3 个新建目录", sum.mkdir === 3, `mkdir=${sum.mkdir}`);
  check("统计到 10 次移动", sum.move === 10, `move=${sum.move}`);
  check("全部可撤销", sum.undoable === sum.total && sum.notUndoable === 0, `${sum.undoable}/${sum.total}`);
  check("风险全部 low", sum.risk.low === sum.total, JSON.stringify(sum.risk));
}

// 含不可撤销动作的探针
const unsafe: Skill = {
  manifest: {
    name: "unsafe-probe",
    version: "0.0.0",
    description: "probe",
    entry: "./index.ts",
    capabilities: [{ id: "ui.input", scope: ".*", reason: "probe" }],
  },
  async plan() {
    return [
      {
        id: "click",
        kind: "ui.click",
        window: "Notepad",
        selector: { controlType: "Button", name: "OK" },
        risk: "high",
        post: [],
        undo: { kind: "noop" },
      },
      {
        id: "type",
        kind: "ui.type",
        window: "Notepad",
        selector: { controlType: "Document" },
        text: "hi",
        risk: "medium",
        post: [],
        undo: null as never,
      },
    ];
  },
};

const unsafeReport = await run(
  unsafe,
  { root },
  { mode: "preview", root, granted: ["ui.input"], journalPath: journal },
  {},
);
const us = unsafeReport.summary;
check("不可撤销动作被计数", Boolean(us) && us!.notUndoable === 1 && us!.ui === 2, JSON.stringify(us));
check("风险分布正确", Boolean(us) && us!.risk.high === 1 && us!.risk.medium === 1, JSON.stringify(us?.risk));

// CLI 层：汇总行真的打印出来
const cli = execFileSync(process.execPath, ["bin/deskshell.ts", "run", "photo-sort", "--root", root], {
  cwd: path.resolve(import.meta.dirname, ".."),
  encoding: "utf8",
});
check("CLI 打印汇总行", /汇总：新建 3 · 移动 10/.test(cli) && /可撤销 13\/13/.test(cli));

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
