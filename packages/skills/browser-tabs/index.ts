import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillContext, SkillInput, UiNode } from "../../core/src/types.ts";

function collectTabs(node: UiNode): string[] {
  const out: string[] = [];
  const walk = (n: UiNode): void => {
    if (n.controlType === "TabItem") out.push(n.name);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

function tidy(name: string): string {
  return name
    .replace(/\s*-\s*内存使用率.*$/, "")
    .replace(/\s*-\s*Microsoft.*Edge$/, "")
    .replace(/\s*-\s*Google Chrome$/, "")
    .trim();
}

export const skill: Skill = {
  manifest: JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8"),
  ),
  async plan(input: SkillInput, ctx: SkillContext): Promise<Action[]> {
    if (!ctx.driver) throw new Error("browser-tabs 需要 UI 驱动（ctx.driver）");
    const titleRegex = String(input.titleRegex ?? "Edge");
    const tree = await ctx.driver.tree({ titleRegex }, 8);
    const tabs = [...new Set(collectTabs(tree).map(tidy).filter((t) => t && t !== "标签页栏"))];

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const target = path.join(input.root, `tabs-${stamp}.md`);
    const content =
      `# 浏览器标签归档\n\n` +
      `- 窗口：${tree.name}\n` +
      `- 采集时间：${new Date().toISOString()}\n` +
      `- 标签数量：${tabs.length}\n\n` +
      tabs.map((t, i) => `${i + 1}. ${t}`).join("\n") +
      "\n";

    return [
      {
        id: `write:${path.basename(target)}`,
        kind: "fs.write",
        path: target,
        content,
        risk: "low",
        post: [{ kind: "path.exists", path: target }],
        undo: { kind: "fs.restore", path: target, content: null },
      },
    ];
  },
};

export default skill;
