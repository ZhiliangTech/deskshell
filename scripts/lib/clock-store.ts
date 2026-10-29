import fs from "node:fs";
import path from "node:path";

/** 工作时钟的存储层：只负责读写与统计，命令行入口在 scripts/clock.ts */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIR = path.join(ROOT, ".worklog");
const LOG = path.join(DIR, "activity.jsonl");
export const GAP_LIMIT_MS = 5 * 60 * 1000;

export interface Mark {
  ts: number;
  label: string;
  kind: string;
}

export function loadMarks(): Mark[] {
  if (!fs.existsSync(LOG)) return [];
  return fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Mark)
    .sort((a, b) => a.ts - b.ts);
}

export function saveMarks(marks: Mark[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  const body = marks
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((m) => JSON.stringify(m))
    .join("\n");
  fs.writeFileSync(LOG, body + "\n", "utf8");
}

/** 记一笔"我刚干了活"。失败不影响调用方：时钟坏了不能拖垮构建。 */
export function tick(label: string, kind = "auto"): void {
  try {
    const marks = loadMarks();
    marks.push({ ts: Date.now(), label, kind });
    saveMarks(marks);
  } catch {
    /* 时钟是旁路，不能影响主流程 */
  }
}

export interface Session {
  start: number;
  end: number;
  activeMs: number;
  marks: Mark[];
}

export function sessions(marks: Mark[]): Session[] {
  const out: Session[] = [];
  let cur: Session | null = null;
  for (const m of marks) {
    if (!cur) {
      cur = { start: m.ts, end: m.ts, activeMs: 0, marks: [m] };
      continue;
    }
    const gap = m.ts - cur.end;
    if (gap <= GAP_LIMIT_MS) {
      cur.activeMs += gap;
      cur.end = m.ts;
      cur.marks.push(m);
    } else {
      out.push(cur);
      cur = { start: m.ts, end: m.ts, activeMs: 0, marks: [m] };
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const totalActiveMs = (marks: Mark[]): number =>
  sessions(marks).reduce((n, s) => n + s.activeMs, 0);

export const fmtDur = (ms: number): string => {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
};
