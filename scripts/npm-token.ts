// 不打开 www.npmjs.com 也能拿到 npm token：直接走 registry 的 legacy 登录接口。
// 用法:
//   NPM_USER=xxx NPM_PASS=yyy [NPM_EMAIL=zzz] [NPM_OTP=123456] node scripts/npm-token.ts
//   node scripts/npm-token.ts --dry-run     # 只探测接口可达性，不登录
//
// 成功后会写入 ~/.npmrc 的 //registry.npmjs.org/:_authToken，并打印 token 的前 8 位用于核对。
// 脚本不会把完整 token 打到标准输出，也不会上传到任何地方。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const dry = process.argv.includes("--dry-run");
const user = (process.env.NPM_USER ?? "").trim();
const pass = process.env.NPM_PASS ?? "";
const email = (process.env.NPM_EMAIL ?? "").trim();
const otp = (process.env.NPM_OTP ?? "").trim();

async function probe(): Promise<boolean> {
  const r = await fetch(`${REGISTRY}/-/ping`);
  console.log(`registry ping: ${r.status}`);
  return r.ok;
}

if (dry) {
  const ok = await probe();
  console.log(ok ? "registry 可达：可以用 legacy 登录，不需要 www.npmjs.com" : "registry 不可达：这条路也不通，改用 GitHub 渠道");
  process.exit(ok ? 0 : 1);
}

if (!user || !pass) {
  console.error("缺少凭据。设置 NPM_USER / NPM_PASS（有 2FA 再加 NPM_OTP）后重跑。");
  process.exit(2);
}

const doc = {
  _id: `org.couchdb.user:${user}`,
  name: user,
  password: pass,
  email: email || undefined,
  type: "user",
  roles: [] as string[],
  date: new Date().toISOString(),
};

const headers: Record<string, string> = { "content-type": "application/json" };
if (otp) headers["npm-otp"] = otp;

const res = await fetch(`${REGISTRY}/-/user/org.couchdb.user:${encodeURIComponent(user)}`, {
  method: "PUT",
  headers,
  body: JSON.stringify(doc),
});
const text = await res.text();

if (!res.ok) {
  console.error(`登录失败: ${res.status} ${text.slice(0, 400)}`);
  console.error("常见原因：密码错、开了 2FA 但没给 NPM_OTP、账号被锁。");
  process.exit(1);
}

let token = "";
let who = user;
try {
  const j = JSON.parse(text);
  token = j.token ?? "";
  who = j.username ?? j.name ?? user;
} catch {
  console.error("响应不是 JSON，登录未完成：" + text.slice(0, 200));
  process.exit(1);
}

if (!token) {
  console.error("没有拿到 token（响应里没有 token 字段）。");
  process.exit(1);
}

const npmrc = path.join(os.homedir(), ".npmrc");
const line = `//registry.npmjs.org/:_authToken=${token}`;
let current = "";
if (fs.existsSync(npmrc)) current = fs.readFileSync(npmrc, "utf8");
const cleaned = current
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith("//registry.npmjs.org/:_authToken="))
  .join("\n");
fs.writeFileSync(npmrc, (cleaned ? cleaned + "\n" : "") + line + "\n", { mode: 0o600 });

console.log(`登录成功，用户: ${who}`);
console.log(`token: ${token.slice(0, 8)}…（已写入 ${npmrc}，权限 600）`);
console.log("");
console.log("下一步：");
if (who === "ciceroyang") {
  console.log("  node scripts/publish-npm.ts            # 发布 @zhiliangtech/deskshell");
} else {
  console.log("  你的 npm 用户名不是 ciceroyang，scoped 包发不了，改用无 scope 的 deskshell：");
  console.log("  node scripts/publish-npm-unscoped.ts");
}
