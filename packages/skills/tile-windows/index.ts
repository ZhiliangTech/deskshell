import fs from "node:fs";
import path from "node:path";
import type { Action, Rect, Skill, SkillContext, SkillInput } from "../../core/src/types.ts";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cellFor(area: Rect, count: number, index: number): Rect {
  if (count <= 1) return area;
  if (count === 2) {
    const w = Math.floor(area.w / 2);
    return { x: area.x + index * w, y: area.y, w, h: area.h };
  }
  const halfW = Math.floor(area.w / 2);
  const halfH = Math.floor(area.h / 2);
  const col = index % 2;
  const row = Math.floor(index / 2);
  return { x: area.x + col * halfW, y: area.y + row * halfH, w: halfW, h: halfH };
}

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan(input: SkillInput, ctx: SkillContext): Promise<Action[]> {
    if (!ctx.driver?.moveWindow) throw new Error("当前驱动不支持窗口移动");
    const area = (input.area as Rect | undefined) ?? { x: 0, y: 0, w: 1600, h: 900 };
    const limit = Number(input.limit ?? 2);
    const skip = new RegExp(String(input.exclude ?? "Shell_TrayWnd|Progman|Narrator|DSH"));

    const wins = await ctx.driver.windows();
    const include = input.include ? new RegExp(String(input.include)) : null;
    const targets = wins
      .filter((w) => w.name && w.w > 200 && w.h > 150 && !skip.test(w.className) && !skip.test(w.name))
      .filter((w) => (include ? include.test(w.name) : true))
      .slice(0, limit);

    return targets.map((w, i) => {
      const cell = cellFor(area, targets.length, i);
      const window = escape(w.name);
      return {
        id: `tile:${i + 1}`,
        kind: "window.move",
        window,
        rect: cell,
        risk: "low",
        post: [{ kind: "window.rect", window, rect: cell, tolerance: 12 }],
        undo: {
          kind: "window.move",
          window,
          rect: { x: w.x, y: w.y, w: w.w, h: w.h },
        },
      } satisfies Action;
    });
  },
};

export default skill;
