import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 公共 npm 的发布前检查与发布。
 *
 * 三条路，按账号的 2FA 配置走：
 *   1. 默认（不发布）：把"到底卡在哪"一次说清（登录状态、名字占用、版本是否已发）；
 *   2. `--apply`：终端里当场问 6 位验证码（TOTP 认证器的码 30 秒过期，拷来就晚了）；
 *   3. `--apply --token npm_xxx`（或环境变量 NPM_TOKEN）：用 Automation token 发，
 *      不需要验证码。token 写进临时 npmrc（600），发完立刻删，不进命令行历史。
 *
 * 用法：
 *   node scripts/publish-npm-public.ts
 *   node scripts/publish-npm-public.ts --apply
 *   NPM_TOKEN=npm_xxx node scripts/publish-npm-public.ts --apply
 */

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const otpIndexOf = (): number => args.findIndex((a) => a === "--otp" || a.startsWith("--otp="));
const otpAt = otpIndexOf();
const otp =
  otpAt > -1
    ? (args[otpAt].includes("=") ? args[otpAt].split("=")[1] : args[otpAt + 1])?.trim()
    : undefined;
const tokenAt = args.indexOf("--token");
const tokenFileAt = args.indexOf("--token-file");
const token =
  (tokenAt > -1 ? args[tokenAt + 1] : undefined)?.trim() ||
  (tokenFileAt > -1 && fs.existsSync(args[tokenFileAt + 1])
    ? fs.readFileSync(args[tokenFileAt + 1], "utf8").trim()
    : undefined) ||
  process.env.NPM_TOKEN?.trim() ||
  undefined;

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
const rows: string[] = [];
const say = (s: string): void => {
  rows.push(s);
  console.log(s);
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (argv: string[]): { ok: boolean; out: string } => {
  try {
    // Windows 上 .cmd 不能直接 execFile：Node 会抛 EINVAL，「未登录」和「发布失败(空)」都是它
    const out = execFileSync(npm, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    return { ok: false, out: text || e.message || e.code || "npm 没有输出" };
  }
};

say(`包名：${pkg.name}@${pkg.version}`);

// ① 登录状态
const who = run(["whoami", "--registry", "https://registry.npmjs.org"]);
if (who.ok) say(`npm 登录：${who.out}`);
else say(`npm 登录：未登录（${who.out.split("\n")[0] ?? "未知原因"}）→ 先跑 npm login`);

// ② 名字是否被占用（registry 直查，不依赖 npm 客户端）
let nameState = "未知";
try {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`);
  if (res.status === 404) nameState = "这个名字在公共 npm 上没人用（可以直接发）";
  else if (res.ok) {
    const data = (await res.json()) as { versions?: Record<string, unknown> };
    const versions = Object.keys(data.versions ?? {});
    nameState = `名字已被占用，现有版本：${versions.slice(-5).join(", ") || "(无)"}`;
    if (versions.includes(pkg.version)) nameState += `；${pkg.version} 已经发布过`;
  } else nameState = `查询失败：HTTP ${res.status}`;
} catch (err) {
  nameState = `查询失败：${err instanceof Error ? err.message : String(err)}`;
}
say(`名字状态：${nameState}`);

// ③ 版本与发布策略
say(`发布策略：publishConfig 里指向 GitHub Packages；公共 npm 需要显式 --registry 覆盖`);

if (!apply) {
  say("");
  say("这只是检查。真要发：node scripts/publish-npm-public.ts --apply");
} else if (token) {
  // Automation token：不需要验证码。写进临时 npmrc（600），发完删掉，
  // 这样 token 不会出现在命令行历史里。
  say("");
  say(`用 token 发布（${token.slice(0, 8)}…，共 ${token.length} 字符）……`);
  const npmrc = path.join(os.tmpdir(), `deskshell-npmrc-${Date.now()}`);
  fs.writeFileSync(npmrc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  try {
    const r = run([
      "publish",
      "--access",
      "public",
      "--registry",
      "https://registry.npmjs.org",
      "--userconfig",
      npmrc,
    ]);
    if (r.ok) {
      say(`已发布：${pkg.name}@${pkg.version}`);
    } else {
      say(`发布失败：\n${r.out.slice(-800)}`);
      if (/EOTP|one-time password/i.test(r.out)) {
        say("");
        say("这个 token 不是 Automation 类型：普通 token 仍要验证码。");
        say("去 npmjs.com → Access Tokens → Generate New Token → 选 Automation。");
      } else if (/401|403|E401|E403/.test(r.out)) {
        say("");
        say("token 被拒：确认它有 publish 权限，且没被撤销/过期。");
      }
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(npmrc, { force: true });
  }
} else {
  // 2FA 码 30 秒过期：靠 --otp 从别处拷过来经常来不及。
  // 所以在终端里直接问，敲完立刻发。
  let code = otp;
  if (!code) {
    if (process.stdin.isTTY) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        say("");
        say("账号是 auth-and-writes，发布要一次性验证码（认证器上现在那个 6 位）。");
        say("如果你的认证器根本不显示数字，那是 WebAuthn/passkey —— 命令行用不了，");
        say("请改用 Automation token：node scripts/publish-npm-public.ts --apply --token npm_xxx");
        code = (await rl.question("验证码（或直接回车取消）：")).trim();
      } finally {
        rl.close();
      }
      if (!/^\d{6}$/.test(code)) {
        say("取消。");
        process.exitCode = 2;
        process.exit(2);
      }
    } else {
      say("");
      say("非交互环境：用 --otp=<6 位码>，或用 NPM_TOKEN 传 Automation token。");
      process.exitCode = 2;
      process.exit(2);
    }
  }

  say("");
  say("开始发布……");
  const publishArgs = [
    "publish",
    "--access",
    "public",
    "--registry",
    "https://registry.npmjs.org",
    `--otp=${code}`,
  ];
  const r = run(publishArgs);
  if (r.ok) {
    say(`已发布：${pkg.name}@${pkg.version}`);
  } else {
    say(`发布失败：\n${r.out.slice(-800)}`);
    if (/EOTP|one-time password/i.test(r.out)) {
      say("");
      say("码被拒（过期或重复使用）。再跑一次，输入认证器上**当下**那一个。");
    }
    process.exitCode = 1;
  }
}

fs.writeFileSync(".demo/npm-public-report.txt", `${rows.join("\n")}\n`, "utf8");
