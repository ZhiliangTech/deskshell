import fs from "node:fs";
import path from "node:path";
import type { Action, Skill } from "../../core/src/types.ts";

const selector = { controlType: "Document", name: "文本编辑器" };

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),
  async plan(): Promise<Action[]> {
    return [
      {
        id: "type-ok",
        kind: "ui.type",
        window: "Notepad",
        selector,
        text: "hello",
        risk: "low",
        post: [{ kind: "ui.value", window: "Notepad", selector, equals: "hello" }],
        undo: null,
      },
      {
        id: "assert-wrong",
        kind: "ui.type",
        window: "Notepad",
        selector,
        text: "world",
        risk: "low",
        post: [{ kind: "ui.value", window: "Notepad", selector, equals: "this-will-never-match" }],
        undo: null,
      },
      {
        id: "must-not-run",
        kind: "ui.type",
        window: "Notepad",
        selector,
        text: "SHOULD-NOT-APPEAR",
        risk: "low",
        undo: null,
      },
    ];
  },
};

export default skill;
