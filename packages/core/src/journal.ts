import fs from "node:fs";
import path from "node:path";
import type { JournalEntry } from "./types.ts";

/** load() 会在条目上带上它来自哪个文件，撤销时才能只改对文件 */
export type LoadedEntry = JournalEntry & { __file?: string };

/** 默认 5 MiB；测试里用环境变量调小 */
const MAX_BYTES = (): number => Number(process.env.DESKSHELL_JOURNAL_MAX_BYTES ?? 5 * 1024 * 1024);

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** 轮转文件的前缀：跟主文件同名，不硬编码 journal-（自定义日志名也要能读回来） */
function rotatedPrefix(journalPath: string): string {
  return `${path.basename(journalPath, ".jsonl")}-`;
}

/** 同一目录下的轮转文件：<主名>-*.jsonl，按名字升序即时间升序 */
function rotatedFiles(journalPath: string): string[] {
  const dir = path.dirname(journalPath);
  const prefix = rotatedPrefix(journalPath);
  let names: string[];
  try {
    if (!fs.existsSync(dir)) return [];
    names = fs.readdirSync(dir);
  } catch {
    // 目录读不了（权限、被删）：当作没有历史，不能让 history/undo 整体崩
    return [];
  }
  return names
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    // 只认普通文件：同名的目录/链接会让 readFileSync 抛 EISDIR/EPERM，
    // 而一个普通的 fs.mkdir 就能造出这种名字（审计可用性也算账本完整性）
    .filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((f) => path.join(dir, f));
}

/** 超过阈值就把当前日志改名归档，主文件重新开始 */
function maybeRotate(journalPath: string): void {
  if (!fs.existsSync(journalPath)) return;
  if (fs.statSync(journalPath).size < MAX_BYTES()) return;
  const prefix = rotatedPrefix(journalPath);
  let target = path.join(path.dirname(journalPath), `${prefix}${stamp()}.jsonl`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(path.dirname(journalPath), `${prefix}${stamp()}-${n++}.jsonl`);
  }
  fs.renameSync(journalPath, target);
}

export function append(journalPath: string, entry: JournalEntry): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  maybeRotate(journalPath);
  fs.appendFileSync(journalPath, JSON.stringify(entry) + "\n", "utf8");
}

function readLines(file: string): string[] {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    // 单个文件读不了，不能让整份账本跟着不可读
    return [];
  }
}

/**
 * 解析一行；坏行返回 null 而不是抛。
 *
 * 崩溃或断电会留下半行 JSON。之前这里直接 JSON.parse，一行残缺就让整份账本不可读，
 * 而"崩溃之后"恰恰是最需要账本的时候。坏行跳过，好行照常生效。
 */
function parseLine(line: string, file: string): LoadedEntry | null {
  try {
    const parsed = JSON.parse(line) as JournalEntry;
    if (!parsed || typeof parsed !== "object") return null;
    return { ...parsed, __file: file };
  } catch {
    return null;
  }
}

function readFile(file: string): LoadedEntry[] {
  const out: LoadedEntry[] = [];
  for (const line of readLines(file)) {
    if (line.trim().length === 0) continue;
    const entry = parseLine(line, file);
    if (entry) out.push(entry);
  }
  return out;
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
 * 读不懂的行原样保留：不能因为要改状态就把审计记录里的坏行抹掉。
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
    const patched = readLines(file).map((line) => {
      if (line.trim().length === 0) return line;
      const row = parseLine(line, file);
      if (!row) return line;
      const want = statuses.get(`${row.taskId}:${row.actionId}`);
      if (!want) return line;
      const { __file, ...rest } = row;
      return JSON.stringify({ ...rest, status: want });
    });
    const body = patched.join("\n").replace(/\n+$/, "");
    fs.writeFileSync(file, body.length > 0 ? `${body}\n` : "", "utf8");
  }
}
