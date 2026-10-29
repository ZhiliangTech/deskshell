import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

interface RenameInput extends SkillInput {
  /** 只匹配 root 下的文件，支持单个 * 通配，默认 *.jpg */
  pattern?: string;
  /** 新名字前缀，默认 photo */
  prefix?: string;
  /** 序号位数，默认 3 */
  pad?: number;
}

const toRegex = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

/** 批量改名：每个动作都带 pre/post/undo；目标已存在就让它失败，绝不覆盖。 */
export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root, pattern, prefix, pad }: RenameInput): Promise<Action[]> {
    const re = toRegex(pattern ?? "*.jpg");
    const name = prefix ?? "photo";
    const width = pad ?? 3;

    const files = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && re.test(d.name))
      .map((d) => d.name)
      .sort();

    const actions: Action[] = [];
    let index = 0;
    for (const file of files) {
      index += 1;
      const ext = path.extname(file);
      const target = `${name}-${String(index).padStart(width, "0")}${ext.toLowerCase()}`;
      if (target === file) continue;

      const from = path.join(root, file);
      const to = path.join(root, target);
      actions.push({
        id: `rename:${file}`,
        kind: "fs.move",
        from,
        to,
        risk: "medium",
        pre: [
          { kind: "path.exists", path: from },
          { kind: "path.absent", path: to },
        ],
        post: [{ kind: "path.exists", path: to }],
        undo: { kind: "fs.move", from: to, to: from },
      });
    }
    return actions;
  },
};

export default skill;
