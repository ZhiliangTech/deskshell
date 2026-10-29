import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

interface ShotInput extends SkillInput {
  /** 只处理名字里含这些词的文件（默认常见截图前缀） */
  patterns?: string[];
}

const DEFAULT_PATTERNS = ["screenshot", "screen shot", "截图", "snipaste"];
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const pad = (n: number): string => String(n).padStart(2, "0");

/** 截图按日期归档：YYYY/MM/ + 时间前缀，方便按时间排。 */
export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root, patterns }: ShotInput): Promise<Action[]> {
    const words = (patterns ?? DEFAULT_PATTERNS).map((w) => w.toLowerCase());
    const shots = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => {
        const lower = name.toLowerCase();
        return IMAGE_EXT.has(path.extname(lower)) && words.some((w) => lower.includes(w));
      })
      .sort();

    if (shots.length === 0) return [];

    const plan: Array<{ from: string; to: string; dir: string }> = [];
    for (const name of shots) {
      const abs = path.join(root, name);
      const st = fs.statSync(abs);
      const d = st.mtime;
      const rel = path.join(String(d.getFullYear()), pad(d.getMonth() + 1));
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const target = path.join(rel, `${stamp}-${name}`);
      plan.push({ from: abs, to: path.join(root, target), dir: path.join(root, rel) });
    }

    // 逐级建目录：只对"当前不存在"的层级生成动作。
    // 只建叶子会让中间层（如 2026）在撤销后残留，做不到逐字节还原。
    const needed: string[] = [];
    for (const p of plan) {
      let dir = p.dir;
      const chain: string[] = [];
      while (dir.startsWith(root) && dir !== root) {
        chain.unshift(dir);
        dir = path.dirname(dir);
      }
      for (const d of chain) {
        if (!fs.existsSync(d) && !needed.includes(d)) needed.push(d);
      }
    }
    const actions: Action[] = needed
      .sort((a, b) => a.length - b.length)
      .map((dir) => ({
        id: `mkdir:${path.relative(root, dir).replace(/\\/g, "/")}`,
        kind: "fs.mkdir" as const,
        path: dir,
        risk: "low" as const,
        undo: { kind: "fs.rmdir" as const, path: dir },
      }));

    for (const p of plan) {
      const rel = path.relative(root, p.to).replace(/\\/g, "/");
      actions.push({
        id: `move:${rel}`,
        kind: "fs.move",
        from: p.from,
        to: p.to,
        risk: "low",
        pre: [
          { kind: "path.exists", path: p.from },
          { kind: "path.absent", path: p.to },
        ],
        post: [{ kind: "path.exists", path: p.to }],
        undo: { kind: "fs.move", from: p.to, to: p.from },
      });
    }
    return actions;
  },
};

export default skill;
