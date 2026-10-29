import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

interface MirrorInput extends SkillInput {
  /** 源子目录（相对 root），默认 src */
  source?: string;
  /** 目标子目录（相对 root），默认 mirror */
  dest?: string;
  /** 单个文件上限，超过就跳过（fs.write 走字符串，二进制不安全），默认 512 KiB */
  maxFileBytes?: number;
}

const TEXT_EXT = new Set([".md", ".txt", ".json", ".ts", ".js", ".css", ".html", ".yml", ".yaml", ".toml", ".ini"]);

/** 递归列出目录下的文本文件（相对路径 → 绝对路径） */
function listTextFiles(base: string, limit: number): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(base)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".trash" || entry.name === ".deskshell") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      if (fs.statSync(abs).size > limit) continue;
      out.set(path.relative(base, abs).replace(/\\/g, "/"), abs);
    }
  };
  walk(base);
  return out;
}

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root, source, dest, maxFileBytes }: MirrorInput): Promise<Action[]> {
    const srcDir = path.join(root, source ?? "src");
    const dstDir = path.join(root, dest ?? "mirror");
    const limit = maxFileBytes ?? 512 * 1024;
    const src = listTextFiles(srcDir, limit);
    const dst = listTextFiles(dstDir, limit);

    const actions: Action[] = [];
    // 逐级建目录，只为不存在的层级生成动作（撤销才可能逐字节还原）
    const neededDirs: string[] = [];
    for (const rel of src.keys()) {
      let dir = path.join(dstDir, path.dirname(rel));
      const chain: string[] = [];
      while (dir.startsWith(dstDir) && dir !== dstDir) {
        chain.unshift(dir);
        dir = path.dirname(dir);
      }
      for (const d of chain) {
        if (!fs.existsSync(d) && !neededDirs.includes(d)) neededDirs.push(d);
      }
    }
    for (const dir of neededDirs.sort((a, b) => a.length - b.length)) {
      const rel = path.relative(dstDir, dir).replace(/\\/g, "__");
      actions.push({
        id: `mkdir:${rel}`,
        kind: "fs.mkdir",
        path: dir,
        risk: "low",
        undo: { kind: "fs.rmdir", path: dir },
      });
    }

    for (const [rel, abs] of [...src.entries()].sort()) {
      const target = path.join(dstDir, rel);
      const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      const content = fs.readFileSync(abs, "utf8");
      if (before === content) continue;
      actions.push({
        id: `write:${rel.replace(/\//g, "__")}`,
        kind: "fs.write",
        path: target,
        content,
        risk: "low",
        pre: before === null ? [{ kind: "path.absent", path: target }] : [],
        post: [{ kind: "path.exists", path: target }],
        undo: { kind: "fs.restore", path: target, content: before },
      });
    }

    const extras = [...dst.keys()].filter((rel) => !src.has(rel)).sort();
    if (extras.length > 0) {
      const trash = path.join(root, ".trash");
      actions.unshift({
        id: "mkdir:.trash",
        kind: "fs.mkdir",
        path: trash,
        risk: "low",
        undo: { kind: "fs.rmdir", path: trash },
      });
      for (const rel of extras) {
        const abs = path.join(dstDir, rel);
        const target = path.join(trash, rel.replace(/\//g, "__"));
        actions.push({
          id: `trash:${rel.replace(/\//g, "__")}`,
          kind: "fs.move",
          from: abs,
          to: target,
          risk: "medium",
          pre: [{ kind: "path.exists", path: abs }],
          post: [{ kind: "path.exists", path: target }],
          undo: { kind: "fs.move", from: target, to: abs },
        });
      }
    }

    return actions;
  },
};

export default skill;
