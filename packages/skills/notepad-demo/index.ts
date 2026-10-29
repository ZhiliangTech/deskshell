// 由 scripts/draft-skill.ts 从录制生成 —— 草稿，需要人工补断言与撤销策略
import fs from "node:fs";
import path from "node:path";
import type { Action, Skill } from "../../core/src/types.ts";

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),
  async plan(): Promise<Action[]> {
    return [
  {
    id: "step-1",
    kind: "ui.type",
    window: "Notepad",
    selector: {"controlType":"Document","name":"文本编辑器"},
    text: "录制演示 02:03:58",
    risk: "low",
    post: [{ kind: "ui.value", window: "Notepad", selector: {"controlType":"Document","name":"文本编辑器"}, equals: "录制演示 02:03:58" }],
    undo: null,
  },
  {
    id: "step-2",
    kind: "ui.click",
    window: "Notepad",
    selector: {"controlType":"Document","name":"文本编辑器"},
    risk: "low",
    post: [], // TODO: 点击后应该出现什么？
    undo: null,
  },
  {
    id: "step-3",
    kind: "ui.type",
    window: "Notepad",
    selector: {"controlType":"Document","name":"文本编辑器"},
    text: "录制演示 02:03:58",
    risk: "low",
    post: [{ kind: "ui.value", window: "Notepad", selector: {"controlType":"Document","name":"文本编辑器"}, equals: "录制演示 02:03:58" }],
    undo: null,
  },
    ];
  },
};

export default skill;
