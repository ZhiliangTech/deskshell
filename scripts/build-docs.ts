import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");
const OUT = path.join(ROOT, "site");

const ORDER = [
  "index",
  "quickstart",
  "protocol",
  "writing-a-skill",
  "undo-and-trust",
  "recording",
  "drivers",
  "versioning",
  "roadmap",
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function render(md: string): { title: string; html: string } {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let title = "";
  let i = 0;
  let para: string[] = [];

  const flush = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flush();
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        `<pre><code${lang ? ` class="lang-${lang}"` : ""}>${esc(buf.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      const text = h[2];
      if (level === 1 && !title) title = text;
      out.push(`<h${level} id="${text.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-")}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (/^-\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^-\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (line.startsWith("> ")) {
      flush();
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      i++;
      continue;
    }

    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();

  return { title: title || "docs", html: out.join("\n") };
}

const pages = ORDER.map((slug) => {
  const file = path.join(DOCS, `${slug}.md`);
  const { title, html } = render(fs.readFileSync(file, "utf8"));
  return { slug, title, html };
});

const nav = pages
  .map((p) => `<a class="nav-item" href="${p.slug}.html">${esc(p.title)}</a>`)
  .join("\n");

const css = `
:root { --fg:#1c1e21; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --bg:#fff; }
* { box-sizing: border-box; }
body { margin:0; font:16px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
.layout { display:flex; min-height:100vh; }
aside { width:260px; padding:28px 20px; border-right:1px solid var(--line); position:sticky; top:0; height:100vh; overflow:auto; }
.brand { font-weight:700; font-size:18px; margin-bottom:4px; }
.brand small { display:block; color:var(--muted); font-weight:400; font-size:12px; margin-top:6px; }
.nav-item { display:block; padding:7px 10px; margin:2px 0; border-radius:6px; color:var(--fg); text-decoration:none; font-size:14px; }
.nav-item:hover { background:#f3f4f6; }
main { flex:1; padding:40px 56px 80px; max-width:860px; }
h1 { font-size:30px; margin:0 0 20px; }
h2 { font-size:21px; margin:34px 0 12px; padding-top:8px; border-top:1px solid var(--line); }
h3 { font-size:17px; margin:22px 0 8px; }
p { margin:10px 0; }
code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:13.5px; font-family:ui-monospace,Consolas,monospace; }
pre { background:#0f172a; color:#e2e8f0; padding:16px 18px; border-radius:10px; overflow:auto; }
pre code { background:none; color:inherit; padding:0; font-size:13px; }
blockquote { margin:14px 0; padding:10px 16px; border-left:3px solid var(--accent); background:#f8fafc; color:#334155; }
ul,ol { padding-left:22px; }
li { margin:4px 0; }
a { color:var(--accent); }
.pager { display:flex; justify-content:space-between; margin-top:48px; padding-top:16px; border-top:1px solid var(--line); font-size:14px; }
footer { color:var(--muted); font-size:12px; margin-top:40px; }
`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "style.css"), css.trim() + "\n", "utf8");

// 静态资源（截图 / 动图 / SVG）一起拷过去
const assets = path.join(DOCS, "assets");
if (fs.existsSync(assets)) {
  fs.cpSync(assets, path.join(OUT, "assets"), { recursive: true });
}

pages.forEach((page, idx) => {
  const prev = idx > 0 ? pages[idx - 1] : null;
  const next = idx < pages.length - 1 ? pages[idx + 1] : null;
  const pager = `<div class="pager"><span>${prev ? `<a href="${prev.slug}.html">← ${esc(prev.title)}</a>` : ""}</span><span>${next ? `<a href="${next.slug}.html">${esc(next.title)} →</a>` : ""}</span></div>`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)} · deskshell</title>
<link rel="stylesheet" href="style.css">
</head><body><div class="layout">
<aside><div class="brand">deskshell<small>AI 电脑管家 · 协议 v0</small></div>${nav}</aside>
<main>${page.html}${pager}<footer>deskshell docs · 由 scripts/build-docs.ts 生成，请修改 docs/*.md</footer></main>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT, `${page.slug}.html`), html, "utf8");
});

console.log(`built ${pages.length} pages → ${OUT}`);
for (const p of pages) {
  const size = fs.statSync(path.join(OUT, `${p.slug}.html`)).size;
  console.log(`  ${p.slug.padEnd(18)} ${String(size).padStart(6)} bytes  ${p.title}`);
}
