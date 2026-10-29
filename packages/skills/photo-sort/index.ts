import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".tiff", ".bmp"]);

/** 用修改时间归类：YYYY-MM。没有 EXIF 依赖，离线可用。 */
function monthOf(file: string): string {
  const mtime = fs.statSync(file).mtime;
  const y = mtime.getFullYear();
  const m = String(mtime.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root }: SkillInput): Promise<Action[]> {
    const files = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && IMAGE_EXT.has(path.extname(d.name).toLowerCase()))
      .map((d) => d.name)
      .sort();

    const groups = new Map<string, string[]>();
    for (const name of files) {
      const month = monthOf(path.join(root, name));
      groups.set(month, [...(groups.get(month) ?? []), name]);
    }

    const months = [...groups.keys()].sort();
    const mkdirs: Action[] = months.map((month) => ({
      id: `mkdir:${month}`,
      kind: "fs.mkdir",
      path: path.join(root, month),
      risk: "low",
      undo: { kind: "fs.rmdir", path: path.join(root, month) },
    }));

    const moves: Action[] = [];
    for (const month of months) {
      for (const name of groups.get(month) ?? []) {
        const from = path.join(root, name);
        const to = path.join(root, month, name);
        moves.push({
          id: `move:${name}`,
          kind: "fs.move",
          from,
          to,
          risk: "low",
          pre: [{ kind: "path.exists", path: from }],
          post: [{ kind: "path.exists", path: to }],
          undo: { kind: "fs.move", from: to, to: from },
        });
      }
    }

    return [...mkdirs, ...moves];
  },
};

export default skill;
