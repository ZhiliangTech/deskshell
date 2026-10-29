import fs from "node:fs";
import path from "node:path";
import type { JournalEntry } from "./types.ts";

export function append(journalPath: string, entry: JournalEntry): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, JSON.stringify(entry) + "\n", "utf8");
}

export function load(journalPath: string): JournalEntry[] {
  if (!fs.existsSync(journalPath)) return [];
  return fs
    .readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

export function markRolledBack(journalPath: string, entries: JournalEntry[]): void {
  fs.writeFileSync(
    journalPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""),
    "utf8",
  );
}
