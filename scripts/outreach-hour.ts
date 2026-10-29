// 每小时账号运营的状态计算器：只读 TRACKER.csv，不联网、不写文件。
// 用法: node scripts/outreach-hour.ts [--json]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CSV = path.join(ROOT, "outreach", "TRACKER.csv");
const json = process.argv.includes("--json");

type Row = Record<string, string>;

function parse(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) return [];
  const head = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Row = {};
    head.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

function split(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === String.fromCharCode(34)) { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");
const local = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

const rows = fs.existsSync(CSV) ? parse(fs.readFileSync(CSV, "utf8")) : [];
const active = rows.filter((r) => (r.outcome ?? "") !== "dead" && (r.outcome ?? "") !== "done");

const dueFirst = active.filter((r) => r.outcome === "planned" && (!r.first_touch_date || r.first_touch_date <= local));
const dueFollow1 = active.filter((r) => r.followup1_date && r.followup1_date <= local && !r.reply && r.outcome === "sent");
const dueFollow2 = active.filter((r) => r.followup2_date && r.followup2_date <= local && !r.reply && r.outcome !== "dead");
const waiting = active.filter((r) => r.outcome === "sent" && r.reply === "");
const sentToday = rows.filter((r) => r.outcome === "sent" && r.first_touch_date === local).length;
const replied = rows.filter((r) => r.reply && r.reply !== "").length;

const result = {
  date: local,
  total: rows.length,
  sentToday,
  quotaLeft: Math.max(0, 5 - sentToday),
  waitingReply: waiting.length,
  replied,
  dueFollow1: dueFollow1.map((r) => r.handle),
  dueFollow2: dueFollow2.map((r) => r.handle),
  plannedDue: dueFirst.map((r) => r.handle),
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`outreach-hour ${local}`);
  console.log(`  rows=${rows.length}  sentToday=${sentToday}/5  waiting=${waiting.length}  replied=${replied}`);
  console.log(`  due follow-up 1: ${dueFollow1.length ? dueFollow1.map((r) => r.handle + "@" + r.followup1_date).join(", ") : "none"}`);
  console.log(`  due follow-up 2: ${dueFollow2.length ? dueFollow2.map((r) => r.handle + "@" + r.followup2_date).join(", ") : "none"}`);
  console.log(`  planned for today: ${dueFirst.length ? dueFirst.map((r) => r.handle).join(", ") : "none"}`);
  console.log("");
  console.log("next: 回信优先 -> 发最多 3 条 -> 到期跟进 -> 更新 TRACKER.csv");
}
