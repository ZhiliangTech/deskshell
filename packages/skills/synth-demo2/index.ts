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
    kind: "ui.click",
    window: "App",
    selector: {"controlType":"Button","name":"设置","automationId":"settings"},
    risk: "low",
    post: [{ kind: "ui.exists", window: "App", selector: {"controlType":"Button","name":"保存","automationId":"save"} }], // 断言由录制推断：点击后焦点落到该控件
    undo: null,
  },
    ];
  },
};

export default skill;
