import fs from "node:fs";
import path from "node:path";
import type { Action, Skill, SkillInput } from "../../core/src/types.ts";

const MAX_AGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

interface LogInput extends SkillInput {
  now?: number;
  maxAgeDays?: number;
}

/** 归档旧日志：只移动，不删除；撤销就是把文件搬回去。 */
export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root, now, maxAgeDays }: LogInput): Promise<Action[]> {
    const cutoff = (now ?? Date.now()) - (maxAgeDays ?? MAX_AGE_DAYS) * DAY;
    const archiveRoot = path.join(root, "archive");

    const logs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".log"))
      .map((d) => {
        const file = path.join(root, d.name);
        return { name: d.name, file, mtime: fs.statSync(file).mtimeMs };
      })
      .filter((f) => f.mtime < cutoff)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (logs.length === 0) return [];

    const groups = new Map<string, typeof logs>();
    for (const log of logs) {
      const d = new Date(log.mtime);
      const bucket = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      groups.set(bucket, [...(groups.get(bucket) ?? []), log]);
    }

    const buckets = [...groups.keys()].sort();
    const actions: Action[] = [
      {
        id: "mkdir:archive",
        kind: "fs.mkdir",
        path: archiveRoot,
        risk: "low",
        undo: { kind: "fs.rmdir", path: archiveRoot },
      },
    ];

    for (const bucket of buckets) {
      const dir = path.join(archiveRoot, bucket);
      actions.push({
        id: `mkdir:${bucket}`,
        kind: "fs.mkdir",
        path: dir,
        risk: "low",
        undo: { kind: "fs.rmdir", path: dir },
      });
    }

    for (const log of logs) {
      const d = new Date(log.mtime);
      const bucket = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const to = path.join(archiveRoot, bucket, log.name);
      actions.push({
        id: `move:${log.name}`,
        kind: "fs.move",
        from: log.file,
        to,
        risk: "low",
        pre: [{ kind: "path.exists", path: log.file }],
        post: [{ kind: "path.exists", path: to }],
        undo: { kind: "fs.move", from: to, to: log.file },
      });
    }

    return actions;
  },
};

export default skill;
