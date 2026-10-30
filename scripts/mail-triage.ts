// 本地邮件分诊：把导出的 .eml / .mbox 丢进 .mail/ 目录，直接汇总来信。
// 用法: node scripts/mail-triage.ts [dir]   （默认 .mail/）
// 不联网、不发信、不改任何东西。
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".mail");
const WATCH = ["abrichr", "richard.abrich", "openadapt", "abrir",
  "pm-shawn", "abu-cowork", "ayuayue", "pideck", "gnh1201", "welsonjs",
  "wh1isper", "agent-foundation", "echovic", "orca-agent", "lukemarsden", "helix",
  "monglong0214", "logic-pro-mcp", "deskshell"];

type Mail = { from: string; to: string; subject: string; date: string; body: string; file: string; kind: string };

function parseHeaders(chunk: string) {
  const [head, ...rest] = chunk.split(/\r?\n\r?\n/);
  const get = (k: string) => {
    const m = new RegExp("^" + k + ":\\s*(.*)$", "im").exec(head);
    return m ? m[1].trim() : "";
  };
  return { from: get("From"), to: get("To"), subject: get("Subject"), date: get("Date"), body: rest.join("\n\n") };
}

function classify(m: Mail): string {
  const f = (m.from + " " + m.subject).toLowerCase();
  if (/mailer-daemon|postmaster|undeliverable|delivery status|delivery has failed/.test(f)) return "BOUNCE";
  if (/no\s*reply|do not reply|noreply/.test(f)) return "NOREPLY";
  return "REPLY?";
}

const mails: Mail[] = [];
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const txt = fs.readFileSync(p, "utf8");
    if (f.endsWith(".mbox") || /^From /m.test(txt)) {
      for (const chunk of txt.split(/^From .*$/m).filter((c) => c.trim())) {
        const h = parseHeaders(chunk);
        mails.push({ ...h, file: f, kind: "" });
      }
    } else {
      const h = parseHeaders(txt);
      mails.push({ ...h, file: f, kind: "" });
    }
  }
}

for (const m of mails) m.kind = classify(m);
const interesting = mails.filter((m) => {
  const hay = (m.from + " " + m.subject + " " + m.body).toLowerCase();
  return WATCH.some((w) => hay.includes(w)) || m.kind !== "REPLY?";
});

if (!mails.length) {
  console.log(`没有找到邮件。把导出的 .eml / .mbox 放进 ${dir} 再跑一次。`);
  process.exit(0);
}

console.log(`共 ${mails.length} 封，命中 ${interesting.length} 封\n`);
for (const m of interesting) {
  console.log(`[${m.kind}] ${m.date}`);
  console.log(`  from: ${m.from}`);
  console.log(`  subj: ${m.subject}`);
  console.log(`  body: ${m.body.replace(/\s+/g, " ").trim().slice(0, 160)}`);
  console.log("");
}
