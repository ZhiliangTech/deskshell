import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

const CATEGORIES: Record<string, string[]> = {
  图片: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"],
  文档: [".pdf", ".doc", ".docx", ".txt", ".md", ".xlsx", ".pptx"],
  压缩包: [".zip", ".tar", ".gz", ".7z", ".rar"],
  音视频: [".mp4", ".mov", ".mp3", ".wav", ".mkv"],
  代码: [".js", ".ts", ".py", ".rs", ".go", ".json"],
};

const TRASH = ".trash";

function categoryOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  for (const [name, exts] of Object.entries(CATEGORIES)) {
    if (exts.includes(ext)) return name;
  }
  return "其他";
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export const skill: Skill = {
  manifest: JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8"),
  ),
  async plan(input: SkillInput): Promise<Action[]> {
    const root = input.root;
    const files = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();

    const actions: Action[] = [];
    const dirs = new Set<string>();
    const byHash = new Map<string, string[]>();

    for (const name of files) {
      const full = path.join(root, name);
      const key = `${fs.statSync(full).size}:${sha256(full)}`;
      const bucket = byHash.get(key) ?? [];
      bucket.push(name);
      byHash.set(key, bucket);
    }

    const duplicates = new Set<string>();
    for (const bucket of byHash.values()) {
      bucket.sort((a, b) => a.length - b.length || a.localeCompare(b));
      for (const name of bucket.slice(1)) duplicates.add(name);
    }

    for (const name of files) {
      if (duplicates.has(name)) {
        dirs.add(TRASH);
        actions.push({
          id: `trash:${name}`,
          kind: "fs.move",
          from: path.join(root, name),
          to: path.join(root, TRASH, name),
          risk: "medium",
          undo: { kind: "fs.move", from: path.join(root, TRASH, name), to: path.join(root, name) },
        });
        continue;
      }
      const cat = categoryOf(name);
      dirs.add(cat);
      actions.push({
        id: `move:${name}`,
        kind: "fs.move",
        from: path.join(root, name),
        to: path.join(root, cat, name),
        risk: "low",
        undo: { kind: "fs.move", from: path.join(root, cat, name), to: path.join(root, name) },
      });
    }

    const mkdirs: Action[] = [...dirs].sort().map((dir) => ({
      id: `mkdir:${dir}`,
      kind: "fs.mkdir",
      path: path.join(root, dir),
      risk: "low",
      undo: { kind: "fs.rmdir", path: path.join(root, dir) },
    }));

    return [...mkdirs, ...actions];
  },
};

export default skill;
