import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * 公共 npm 的发布前检查与发布。
 *
 * 这块一直卡在"维护者要用 2FA 批准"上，所以脚本只做两件事：
 *   1. 默认 `--check`：把"到底卡在哪"一次说清（登录状态、名字占用、版本是否已发）；
 *   2. `--apply --otp 123456`：真的发，OTP 只在本次进程里用，不落盘。
 *
 * 用法：
 *   node scripts/publish-npm-public.ts                 # 只检查
 *   node scripts/publish-npm-public.ts --apply --otp 123456
 */

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const otpIndex = args.indexOf("--otp");
const otp = otpIndex > -1 ? args[otpIndex + 1] : undefined;

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
const rows: string[] = [];
const say = (s: string): void => {
  rows.push(s);
  console.log(s);
};

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (argv: string[]): { ok: boolean; out: string } => {
  try {
    const out = execFileSync(npm, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
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
  say("这只是检查。真要发：node scripts/publish-npm-public.ts --apply --otp <6 位验证码>");
} else {
  if (!otp) {
    say("");
    say("需要 --otp：公共 npm 的发布要用 2FA 验证码批准（一次性的，脚本不保存）");
    process.exitCode = 2;
  } else {
    say("");
    say("开始发布……");
    const r = run([
      "publish",
      "--access",
      "public",
      "--registry",
      "https://registry.npmjs.org",
      "--otp",
      otp,
    ]);
    say(r.ok ? `已发布：${pkg.name}@${pkg.version}` : `发布失败：\n${r.out.slice(-600)}`);
    if (!r.ok) process.exitCode = 1;
  }
}

fs.writeFileSync(".demo/npm-public-report.txt", `${rows.join("\n")}\n`, "utf8");
