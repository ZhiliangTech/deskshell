import fs from "node:fs";
import path from "node:path";
import type { JournalEntry } from "./types.ts";

/** load() 会在条目上带上它来自哪个文件，撤销时才能只改对文件 */
export type LoadedEntry = JournalEntry & { __file?: string };

/** 默认 5 MiB；测试里用环境变量调小 */
const MAX_BYTES = (): number => Number(process.env.DESKSHELL_JOURNAL_MAX_BYTES ?? 5 * 1024 * 1024);

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** 同一目录下的轮转文件：journal-*.jsonl，按名字升序即时间升序 */
function rotatedFiles(journalPath: string): string[] {
  const dir = path.dirname(journalPath);
  const base = path.basename(journalPath, ".jsonl");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".jsonl"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** 超过阈值就把当前日志改名归档，主文件重新开始 */
function maybeRotate(journalPath: string): void {
  if (!fs.existsSync(journalPath)) return;
  if (fs.statSync(journalPath).size < MAX_BYTES()) return;
  let target = path.join(path.dirname(journalPath), `journal-${stamp()}.jsonl`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(path.dirname(journalPath), `journal-${stamp()}-${n++}.jsonl`);
  }
  fs.renameSync(journalPath, target);
}

export function append(journalPath: string, entry: JournalEntry): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  maybeRotate(journalPath);
  fs.appendFileSync(journalPath, JSON.stringify(entry) + "\n", "utf8");
}

function readFile(file: string): LoadedEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ ...(JSON.parse(line) as JournalEntry), __file: file }));
}

/** 读全部条目：轮转文件在前、当前文件在后，最后按 ts 稳定排序（同一毫秒保持写入顺序） */
export function load(journalPath: string): LoadedEntry[] {
  const files = [
    ...rotatedFiles(journalPath).sort(
      (a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs || a.localeCompare(b),
    ),
    journalPath,
  ];
  return files
    .flatMap(readFile)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.ts - b.entry.ts || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * 只重写状态发生变化的那几个文件。
 * 轮转之后条目分散在多个文件里，整份重写会把别的文件的内容并进来、造成重复。
 */
export function markRolledBack(journalPath: string, entries: LoadedEntry[]): void {
  const byFile = new Map<string, Map<string, JournalEntry["status"]>>();
  for (const e of entries) {
    const file = e.__file ?? journalPath;
    const key = `${e.taskId}:${e.actionId}`;
    const target = byFile.get(file) ?? new Map();
    target.set(key, e.status);
    byFile.set(file, target);
  }

  for (const [file, statuses] of byFile) {
    if (!fs.existsSync(file)) continue;
    const rows = readFile(file).map((row) => {
      const want = statuses.get(`${row.taskId}:${row.actionId}`);
      return want ? { ...row, status: want } : row;
    });
    const body = rows
      .map(({ __file, ...rest }) => JSON.stringify(rest))
      .join("\n");
    fs.writeFileSync(file, body + (rows.length ? "\n" : ""), "utf8");
  }
}
