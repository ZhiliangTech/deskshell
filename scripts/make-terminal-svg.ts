import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 把 30 秒 demo 的真实输出渲染成一张 SVG「终端截图」。
 *
 * 为什么不录 gif/asciinema：那条链要额外的录制工具或外部服务，而且截图会过期。
 * 这里的输入永远来自**当场跑出来的输出**，改代码就重跑，图跟着变。
 */
const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 时间戳每次都不同：渲染前抹掉，保证图是确定的（可复现）
const normalize = (s: string): string => s.replace(/"ts":\d+/g, '"ts":…');

const raw = execFileSync(process.execPath, [path.resolve("apps/cli-demo/thirty-seconds.ts"), "--fast"], {
  encoding: "utf8",
});
const lines = normalize(raw).replace(/\r/g, "").split("\n");
while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

const FONT = 13;
const LINE_H = 20;
const PAD_X = 20;
const PAD_TOP = 56;
const width = 880;
const height = PAD_TOP + lines.length * LINE_H + 20;

const colorOf = (line: string): string => {
  if (/\bFAIL\b/.test(line)) return "#ff6b6b";
  if (/\b还是不要|❌/.test(line)) return "#ff6b6b";
  if (/✅/.test(line)) return "#4ade80";
  if (/\bok\b/.test(line)) return "#4ade80";
  if (/^\s*undo /.test(line)) return "#93c5fd";
  if (/^deskshell —/.test(line)) return "#e5e7eb";
  return "#c9d1d9";
};

const MAX_CHARS = 104;
const clipped = lines.map((l) => (l.length > MAX_CHARS ? `${l.slice(0, MAX_CHARS - 1)}…` : l));
const overflow = lines.filter((l) => l.length > MAX_CHARS).length;
if (overflow > 0) console.log(`注意：${overflow} 行超长，已截断到 ${MAX_CHARS} 字符`);

const body = clipped
  .map((line, i) => {
    const y = PAD_TOP + i * LINE_H;
    return `  <text x="${PAD_X}" y="${y}" fill="${colorOf(line)}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}" xml:space="preserve">${escapeXml(line) || " "}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="deskshell 30-second demo: four steps succeed, the fifth fails, everything rolls back, directory is byte-identical">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#111418"/>
      <stop offset="100%" stop-color="#0b0e12"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="12" fill="url(#bg)" stroke="#2a3038"/>
  <rect width="${width}" height="36" rx="12" fill="#171b21"/>
  <rect y="24" width="${width}" height="12" fill="#171b21"/>
  <circle cx="22" cy="18" r="5.5" fill="#ff5f56"/>
  <circle cx="42" cy="18" r="5.5" fill="#ffbd2e"/>
  <circle cx="62" cy="18" r="5.5" fill="#27c93f"/>
  <text x="${width / 2}" y="22" fill="#8b949e" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="12">node apps/cli-demo/thirty-seconds.ts</text>
${body}
</svg>
`;

const out = path.resolve("docs/assets/thirty-seconds.svg");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg, "utf8");
console.log(`rendered ${lines.length} lines → ${path.relative(process.cwd(), out)} (${(svg.length / 1024).toFixed(1)} KB)`);
