import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");

/** skills 页没有对应 markdown，由下面的 renderSkillsPage() 从包清单生成 */
const SKILLS_SLUG = "skills";

const ORDER = [
  "index",
  "install",
  "quickstart",
  "protocol",
  "writing-a-skill",
  SKILLS_SLUG,
  "recipes",
  "undo-and-trust",
  "recovery",
  "recording",
  "drivers",
  "mcp",
  "shell",
  "internals",
  "versioning",
  "roadmap",
  "faq",
];

/** 站点文案的每语言字典：表格表头、搜索框、技能页文案都走这里 */
interface Copy {
  skillsTitle: string;
  skillsIntro: string;
  th: {
    name: string;
    version: string;
    description: string;
    capabilities: string;
    platforms: string;
  };
  listed: (n: number) => string;
  hidden: (n: number) => string;
  allPlatforms: string;
  noSkills: string;
  emptyCaps: string;
  searchPlaceholder: string;
  searchLabel: string;
  noMatch: string;
}

const COPY_EN: Copy = {
  skillsTitle: "Skills",
  skillsIntro:
    "Each skill is a directory under `packages/skills`: a `skill.json` manifest plus a `plan()` implementation. This table is generated from those manifests by `scripts/build-docs.ts` — change the manifest, not this page.",
  th: {
    name: "Skill",
    version: "Version",
    description: "Description",
    capabilities: "Capabilities",
    platforms: "Platforms",
  },
  listed: (n) => `${n} public skill${n === 1 ? "" : "s"}`,
  hidden: (n) =>
    `${n} internal skill${n === 1 ? "" : "s"} hidden (test fixtures and recorded demos)`,
  allPlatforms: "all platforms",
  noSkills: "No public skills yet.",
  emptyCaps: "none",
  searchPlaceholder: "Filter pages…",
  searchLabel: "Filter documentation pages",
  noMatch: "No matching page",
};

const COPY_ZH: Copy = {
  skillsTitle: "技能目录",
  skillsIntro:
    "每个技能都是 `packages/skills` 下的一个目录：`skill.json` 清单加 `plan()` 实现。本页由 `scripts/build-docs.ts` 在构建时依据这些清单生成——改清单，不要改这一页。",
  th: {
    name: "技能",
    version: "版本",
    description: "说明",
    capabilities: "能力",
    platforms: "平台",
  },
  listed: (n) => `${n} 个公开技能`,
  hidden: (n) => `${n} 个 internal 技能未列出（测试夹具与录制演示）`,
  allPlatforms: "全平台",
  noSkills: "暂无公开技能。",
  emptyCaps: "无",
  searchPlaceholder: "筛选页面…",
  searchLabel: "筛选文档页面",
  noMatch: "没有匹配的页面",
};

interface Lang {
  code: "en" | "zh";
  src: string;
  out: string;
  switchTo: string;
  switchLabel: string;
  subtitle: string;
  copy: Copy;
}

const LANGS: Lang[] = [
  {
    code: "en",
    src: "docs",
    out: "en",
    switchTo: "zh-CN",
    switchLabel: "简体中文",
    subtitle: "protocol-first AI computer shell",
    copy: COPY_EN,
  },
  {
    code: "zh",
    src: "docs/zh-CN",
    out: "zh-CN",
    switchTo: "en",
    switchLabel: "English",
    subtitle: "协议优先的 AI 电脑管家",
    copy: COPY_ZH,
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 站点里所有页面都在下一层（/en/、/zh-CN/），资源前缀统一是 ../ */
const BASE = "../";

function assetPath(p: string): string {
  if (/^(https?:|#|mailto:|\/|\.\.\/)/.test(p)) return p;
  return BASE + p;
}

function inline(s: string): string {
  let out = esc(s);
  // 图片先于链接处理，避免 ![a](b) 被当成链接
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    return `<img src="${assetPath(src)}" alt="${alt}" loading="lazy">`;
  });
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

const RAW_TAG = /^<\/?(p|div|img|br|sub|sup|center|h[1-6]|table|blockquote)\b/i;

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

    // 允许少量内联 HTML（居中的 banner 等）
    if (RAW_TAG.test(line.trim())) {
      flush();
      out.push(line.trim());
      i++;
      continue;
    }

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
      out.push(
        `<h${level} id="${text.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-")}">${inline(text)}</h${level}>`,
      );
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

interface SkillCapability {
  id: string;
  scope?: string;
  reason: string;
}

interface SkillManifest {
  name: string;
  version: string;
  description: string;
  internal?: boolean;
  platforms?: string[];
  capabilities?: SkillCapability[];
}

/** 读每个 skill 包目录下的 skill.json；internal 的不进公开列表，只计数 */
function loadSkills(): { listed: SkillManifest[]; hidden: number } {
  const dir = path.join(ROOT, "packages", "skills");
  const all: SkillManifest[] = [];

  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, entry, "skill.json");
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as SkillManifest;
      for (const key of ["name", "version", "description"] as const) {
        if (typeof manifest[key] !== "string" || manifest[key] === "") {
          throw new Error(`${path.relative(ROOT, file)}: "${key}" is required`);
        }
      }
      all.push(manifest);
    }
  }

  all.sort((a, b) => a.name.localeCompare(b.name));
  const listed = all.filter((s) => s.internal !== true);
  return { listed, hidden: all.length - listed.length };
}

/** skills 页整页生成，标题/表头/汇总行全部走 lang 文案字典 */
function renderSkillsPage(
  skills: SkillManifest[],
  hidden: number,
  copy: Copy,
): { title: string; html: string } {
  const capsCell = (skill: SkillManifest): string => {
    const caps = skill.capabilities ?? [];
    if (caps.length === 0) return `<span class="muted">${esc(copy.emptyCaps)}</span>`;
    const items = caps.map((cap) => {
      const scope = cap.scope ? ` <span class="cap-scope">${esc(cap.scope)}</span>` : "";
      return `<li><code>${esc(cap.id)}</code>${scope} — ${esc(cap.reason)}</li>`;
    });
    return `<ul class="caps">${items.join("")}</ul>`;
  };

  const head =
    `<thead><tr>` +
    [`name`, `version`, `description`, `capabilities`, `platforms`]
      .map((key) => `<th>${esc(copy.th[key as keyof Copy["th"]])}</th>`)
      .join("") +
    `</tr></thead>`;

  const rows = skills.map((skill) => {
    const platforms = skill.platforms?.length
      ? skill.platforms.map((p) => esc(p)).join(", ")
      : esc(copy.allPlatforms);
    return (
      `<tr><td><code>${esc(skill.name)}</code></td>` +
      `<td>${esc(skill.version)}</td>` +
      `<td>${esc(skill.description)}</td>` +
      `<td>${capsCell(skill)}</td>` +
      `<td>${platforms}</td></tr>`
    );
  });

  const body = rows.length
    ? `<table class="skills">${head}<tbody>${rows.join("")}</tbody></table>`
    : `<p>${esc(copy.noSkills)}</p>`;

  const counts = `<p class="muted">${esc(copy.listed(skills.length))} · ${esc(copy.hidden(hidden))}</p>`;

  return {
    title: copy.skillsTitle,
    html: [
      `<h1 id="${SKILLS_SLUG}">${esc(copy.skillsTitle)}</h1>`,
      `<p>${inline(copy.skillsIntro)}</p>`,
      body,
      counts,
    ].join("\n"),
  };
}

const css = `
:root { --fg:#1c1e21; --muted:#6b7280; --line:#e5e7eb; --accent:#FF7A59; --ink:#0B0F14; --bg:#fff; }
* { box-sizing: border-box; }
body { margin:0; font:16px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
.layout { display:flex; min-height:100vh; }
aside { width:270px; padding:26px 20px; border-right:1px solid var(--line); position:sticky; top:0; height:100vh; overflow:auto; }
.brand { display:flex; align-items:center; gap:8px; font-weight:700; font-size:18px; margin-bottom:6px; flex-wrap:wrap; }
.brand img { border-radius:8px; }
.brand small { flex-basis:100%; color:var(--muted); font-weight:400; font-size:12px; margin-top:2px; }
.switch { display:inline-block; margin:6px 0 14px; font-size:13px; color:var(--accent); text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:2px 10px; }
.switch:hover { border-color:var(--accent); }
.nav-item { display:block; padding:7px 10px; margin:2px 0; border-radius:6px; color:var(--fg); text-decoration:none; font-size:14px; }
.nav-item:hover { background:#f6f7f9; }
.nav-item[hidden] { display:none; }
.search { width:100%; margin:2px 0 8px; padding:6px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; font-size:13px; color:var(--fg); background:#fff; }
.search:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px #ffe9e2; }
.nav-empty { color:var(--muted); font-size:12.5px; margin:4px 10px 0; }
table.skills { width:100%; border-collapse:collapse; margin:18px 0 10px; font-size:14px; }
table.skills th, table.skills td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
table.skills th { background:#f9fafb; color:var(--muted); font-size:12.5px; letter-spacing:.04em; text-transform:uppercase; }
table.skills td:first-child { white-space:nowrap; }
ul.caps { margin:0; padding-left:0; list-style:none; }
ul.caps li { margin:3px 0; font-size:13px; }
.cap-scope { color:var(--muted); font-family:ui-monospace,Consolas,monospace; font-size:12px; }
.muted { color:var(--muted); font-size:13px; }
main { flex:1; padding:40px 56px 80px; max-width:880px; }
h1 { font-size:30px; margin:0 0 18px; }
h2 { font-size:21px; margin:34px 0 12px; padding-top:8px; border-top:1px solid var(--line); }
h3 { font-size:17px; margin:22px 0 8px; }
img { max-width:100%; }
code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:13.5px; font-family:ui-monospace,Consolas,monospace; }
pre { background:#0d1117; color:#e6edf3; padding:16px 18px; border-radius:10px; overflow:auto; }
pre code { background:none; color:inherit; padding:0; font-size:13px; }
blockquote { margin:14px 0; padding:10px 16px; border-left:3px solid var(--accent); background:#fff7f4; color:#334155; }
ul,ol { padding-left:22px; }
li { margin:4px 0; }
a { color:#d9480f; }
.pager { display:flex; justify-content:space-between; margin-top:48px; padding-top:16px; border-top:1px solid var(--line); font-size:14px; }
footer { color:var(--muted); font-size:12px; margin-top:40px; }
`;

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
fs.writeFileSync(path.join(SITE, "style.css"), css.trim() + "\n", "utf8");

// 静态资源只拷一次
for (const [from, to] of [
  [path.join(ROOT, "docs", "assets"), path.join(SITE, "assets")],
  [path.join(ROOT, "brand"), path.join(SITE, "brand")],
] as const) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

let built = 0;

const skills = loadSkills();

for (const lang of LANGS) {
  const srcDir = path.join(ROOT, lang.src);
  const outDir = path.join(SITE, lang.out);
  fs.mkdirSync(outDir, { recursive: true });

  const pages = ORDER.map((slug) => {
    // skills 页没有 markdown 源，整页由包清单生成
    if (slug === SKILLS_SLUG) {
      return {
        slug,
        ...renderSkillsPage(skills.listed, skills.hidden, lang.copy),
        source: "packages/skills/*/skill.json",
      };
    }
    const file = path.join(srcDir, `${slug}.md`);
    const md = fs.readFileSync(file, "utf8");
    const { title, html } = render(md);
    return { slug, title, html, source: `${lang.src}/${slug}.md` };
  });

  const nav = pages
    .map((p) => `<a class="nav-item" href="${p.slug}.html">${esc(p.title)}</a>`)
    .join("\n");

  pages.forEach((page, idx) => {
    const prev = idx > 0 ? pages[idx - 1] : null;
    const next = idx < pages.length - 1 ? pages[idx + 1] : null;
    const pager = `<div class="pager"><span>${prev ? `<a href="${prev.slug}.html">← ${esc(prev.title)}</a>` : ""}</span><span>${next ? `<a href="${next.slug}.html">${esc(next.title)} →</a>` : ""}</span></div>`;
    const html = `<!doctype html>
<html lang="${lang.code === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)} · deskshell</title>
<link rel="icon" href="${BASE}brand/logo-mark.svg">
<link rel="stylesheet" href="${BASE}style.css">
</head><body><div class="layout">
<aside>
  <div class="brand"><img src="${BASE}brand/logo-mark.svg" width="28" height="28" alt=""> <span>deskshell</span><small>${lang.subtitle}</small></div>
  <a class="switch" href="${BASE}${lang.switchTo}/${page.slug}.html">${lang.switchLabel}</a>
  <input id="nav-search" class="search" type="search" autocomplete="off" placeholder="${esc(lang.copy.searchPlaceholder)}" aria-label="${esc(lang.copy.searchLabel)}" hidden>
  <p id="nav-empty" class="nav-empty" hidden>${esc(lang.copy.noMatch)}</p>
  ${nav}
</aside>
<main>${page.html}${pager}<footer>deskshell docs · built from ${page.source} by scripts/build-docs.ts</footer></main>
</div>
<script>
/* 侧栏搜索：渐进增强，脚本不跑时输入框保持 hidden */
(function () {
  var box = document.getElementById("nav-search");
  if (!box) return;
  var items = Array.prototype.slice.call(document.querySelectorAll(".nav-item"));
  var empty = document.getElementById("nav-empty");
  box.hidden = false;
  box.addEventListener("input", function () {
    var q = box.value.trim().toLowerCase();
    var shown = 0;
    items.forEach(function (a) {
      var hit = !q || a.textContent.toLowerCase().indexOf(q) !== -1;
      a.hidden = !hit;
      if (hit) shown++;
    });
    if (empty) empty.hidden = shown !== 0 || !q;
  });
})();
</script>
</body></html>`;
    fs.writeFileSync(path.join(outDir, `${page.slug}.html`), html, "utf8");
    built++;
  });
}

// 根路径跳转到英文站
fs.writeFileSync(
  path.join(SITE, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>deskshell docs</title>
<meta http-equiv="refresh" content="0;url=en/index.html">
<link rel="canonical" href="en/index.html">
<p>Redirecting to <a href="en/index.html">English docs</a> · <a href="zh-CN/index.html">中文文档</a></p>`,
  "utf8",
);

console.log(`built ${built} pages → ${SITE}`);
for (const lang of LANGS) {
  const files = fs.readdirSync(path.join(SITE, lang.out)).filter((f) => f.endsWith(".html"));
  console.log(`  ${lang.out.padEnd(6)} ${files.length} pages`);
}
