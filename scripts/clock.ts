import fs from "node:fs";
import path from "node:path";
import { ROOT, fmtDur, loadMarks, saveMarks, sessions, totalActiveMs } from "./lib/clock-store.ts";

interface Milestone {
  id: string;
  title: string;
  from: number;
  to: number;
  accept: string;
  check: string;
  done?: boolean;
  doneAt?: string;
  evidence?: string;
}

const MILESTONES_FILE = path.join(ROOT, "goals", "milestones.json");

function loadMilestones(): { goalHours: number; milestones: Milestone[] } | null {
  if (!fs.existsSync(MILESTONES_FILE)) return null;
  return JSON.parse(fs.readFileSync(MILESTONES_FILE, "utf8"));
}

/**
 * 工作时钟 CLI。我没有内部时钟，所以靠"干活时留下的痕迹 + 相邻间隔"估算有效时长。
 * 相邻记录 ≤5 分钟算连续工作；超过就视为离开，不计入。
 */
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

if (cmd === "tick") {
  const marks = loadMarks();
  marks.push({ ts: Date.now(), label: flag("label", "work")!, kind: flag("kind", "manual")! });
  saveMarks(marks);
  console.log(`tick ${flag("label", "work")} · 累计有效 ${fmtDur(totalActiveMs(marks))}`);
  process.exit(0);
}

if (cmd === "backfill") {
  const files = argv.slice(1).filter((a) => !a.startsWith("--"));
  const marks = loadMarks();
  const seen = new Set(marks.map((m) => m.ts));
  let added = 0;
  for (const rel of files) {
    const p = path.resolve(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const ts = Math.round(fs.statSync(p).mtimeMs);
    if (seen.has(ts)) continue;
    marks.push({ ts, label: rel, kind: "backfill" });
    seen.add(ts);
    added++;
  }
  saveMarks(marks);
  console.log(`backfill: +${added} 条`);
  process.exit(0);
}

if (cmd === "milestone") {
  const id = argv[1];
  const plan = loadMilestones();
  if (!plan || !id) {
    console.error("用法: clock milestone <M01> --evidence \"...\"");
    process.exit(2);
  }
  const m = plan.milestones.find((x) => x.id === id);
  if (!m) {
    console.error(`没有这个里程碑：${id}`);
    process.exit(2);
  }
  m.done = true;
  m.doneAt = new Date().toISOString().slice(0, 10);
  m.evidence = flag("evidence", "");
  fs.writeFileSync(MILESTONES_FILE, JSON.stringify(plan, null, 2) + "\n", "utf8");
  console.log(`✅ ${m.id} ${m.title} 已验收${m.evidence ? `：${m.evidence}` : ""}`);
  process.exit(0);
}

if (cmd === "report") {
  const marks = loadMarks();
  const s = sessions(marks);
  console.log(`${marks.length} 条记录 · ${s.length} 段会话\n`);
  for (const x of s) {
    console.log(`${fmtTime(x.start)} → ${fmtTime(x.end)}  ${fmtDur(x.activeMs).padStart(10)}  ${x.marks.length} 条`);
  }
  process.exit(0);
}

const marks = loadMarks();
const s = sessions(marks);
const active = totalActiveMs(marks);
const goal = Number(flag("goal", "480"));
const activeHours = active / 3600000;
const remaining = Math.max(0, goal - activeHours);
const last = s[s.length - 1];

const lines = [
  `有效工作时长：${fmtDur(active)}（${activeHours.toFixed(2)} 小时）`,
  `目标：${goal} 小时 · 进度 ${((activeHours / goal) * 100).toFixed(2)}% · 还差 ${remaining.toFixed(1)} 小时`,
  `会话段数：${s.length}` +
    (last ? ` · 最近一段 ${fmtTime(last.start)} → ${fmtTime(last.end)}（${fmtDur(last.activeMs)}）` : ""),
];
if (s.length > 1) {
  const avg = active / s.length;
  lines.push(`按每段平均 ${fmtDur(avg)} 估算，还需约 ${Math.ceil((remaining * 3600000) / Math.max(avg, 1))} 段`);
}

// ---- 里程碑 ----
const plan = loadMilestones();
const msLines: string[] = [];
if (plan) {
  const cur = plan.milestones.find((m) => activeHours >= m.from && activeHours < m.to) ??
    plan.milestones[plan.milestones.length - 1];
  const intoHours = Math.max(0, activeHours - cur.from);
  const spanHours = cur.to - cur.from;
  const pct = Math.min(100, (intoHours / spanHours) * 100);
  const doneCount = plan.milestones.filter((m) => m.done).length;
  lines.push(`当前里程碑：${cur.id} ${cur.title}（${intoHours.toFixed(1)}/${spanHours} h，${pct.toFixed(0)}%）`);
  lines.push(`已验收里程碑：${doneCount}/${plan.milestones.length}`);

  msLines.push("## 里程碑（480 小时拆分）", "");
  msLines.push("| 里程碑 | 预算 | 状态 | 验收标准 |");
  msLines.push("| --- | --- | --- | --- |");
  for (const m of plan.milestones) {
    const state = m.done
      ? `✅ ${m.doneAt ?? ""}`
      : activeHours >= m.to
        ? "⏳ 到时未验收"
        : activeHours >= m.from
          ? "▶ 进行中"
          : "· 未开始";
    msLines.push(`| ${m.id} ${m.title} | ${m.from}–${m.to} h | ${state} | ${m.accept} |`);
  }
  msLines.push("");
  msLines.push(`当前里程碑的验收命令：\`${cur.check}\``);
  msLines.push("");
}

const out = ["# WORKLOG — 有效工作时长", "", ...lines.map((l) => `- ${l}`), "", ...msLines, "## 会话", ""];
out.push("| 开始 | 结束 | 有效时长 | 记录数 |");
out.push("| --- | --- | --- | --- |");
for (const x of s.slice(-20)) {
  out.push(`| ${fmtTime(x.start)} | ${fmtTime(x.end)} | ${fmtDur(x.activeMs)} | ${x.marks.length} |`);
}
out.push("");
out.push("> 由 `node scripts/clock.ts` 生成。相邻记录间隔 >5 分钟视为离开，不计入。");
out.push("> 记录来源：每次跑构建/测试/推送/发布都会自动打点，加上手工 `clock tick`。");
const body = out.join("\n") + "\n";

if (argv.includes("--write")) fs.writeFileSync(path.join(ROOT, "WORKLOG.md"), body, "utf8");
console.log(body);
