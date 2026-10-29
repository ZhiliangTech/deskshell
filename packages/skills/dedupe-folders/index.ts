import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

/** 小文件也走哈希；超过 8 MiB 只读前 8 MiB 做指纹，避免整盘 IO */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

interface DedupeInput extends SkillInput {
  /** 只处理这些扩展名（含点），默认全部 */
  extensions?: string[];
  /** 少于这个字节数的文件跳过，默认 1 字节 */
  minBytes?: number;
}

const fingerprint = (file: string, size: number): string => {
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, MAX_HASH_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return createHash("sha256").update(buf).update(String(size)).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
};

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root, extensions, minBytes }: DedupeInput): Promise<Action[]> {
    const wanted = extensions?.map((e) => e.toLowerCase());
    const floor = minBytes ?? 1;
    const keep = new Map<string, string>(); // hash -> 保留的相对路径
    const dupes: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".trash" || entry.name === ".deskshell") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (wanted && !wanted.includes(ext)) continue;
        const st = fs.statSync(abs);
        if (st.size < floor) continue;
        const hash = fingerprint(abs, st.size);
        const existing = keep.get(hash);
        if (!existing) {
          keep.set(hash, abs);
          continue;
        }
        // 先创建的算"原件"，后来者都是重复项
        const keepStat = fs.statSync(existing);
        if (st.mtimeMs < keepStat.mtimeMs) {
          keep.set(hash, abs);
          dupes.push(existing);
        } else {
          dupes.push(abs);
        }
      }
    };
    walk(root);
    if (dupes.length === 0) return [];

    const trash = path.join(root, ".trash");
    const actions: Action[] = [
      {
        id: "mkdir:.trash",
        kind: "fs.mkdir",
        path: trash,
        risk: "low",
        undo: { kind: "fs.rmdir", path: trash },
      },
    ];

    for (const file of dupes.sort()) {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      const target = path.join(trash, rel.replace(/\//g, "__"));
      actions.push({
        id: `trash:${rel}`,
        kind: "fs.move",
        from: file,
        to: target,
        risk: "medium",
        pre: [{ kind: "path.exists", path: file }],
        post: [{ kind: "path.exists", path: target }],
        undo: { kind: "fs.move", from: target, to: file },
      });
    }
    return actions;
  },
};

export default skill;
