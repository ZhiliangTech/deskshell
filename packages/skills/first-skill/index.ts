import fs from "node:fs";
import path from "node:path";
import type { Action, Skill } from "../../core/src/types.ts";

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root }): Promise<Action[]> {
    const files = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile());
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase() || "(无扩展名)";
      groups.set(ext, [...(groups.get(ext) ?? []), f.name]);
    }

    const lines = [...groups.entries()]
      .sort()
      .map(([ext, names]) => `- ${ext}: ${names.length} 个（${names.slice(0, 3).join(", ")}）`);
    const content = `# 文件清单\n\n共 ${files.length} 个文件\n\n${lines.join("\n")}\n`;
    const target = path.join(root, "report.md");

    return [
      {
        id: "write:report",
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
