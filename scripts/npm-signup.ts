// 在 registry 上创建 npm 账号并立刻发布（不需要 www.npmjs.com）。
// 用法:
//   NPM_USER=xxx NPM_PASS=yyy NPM_EMAIL=you@example.com node scripts/npm-signup.ts [--dry-run]
//
// 说明：
// - 走的是 PUT /-/user/org.couchdb.user:<name>，和 npm adduser 同一个接口；
// - 用户名必须未被占用（当前 deskshell、deskshell-dev 之类的名字是空的，但用户名要自己挑）；
// - 新账号可能需要在邮箱里点一次验证，验证前发布会被拒（403），这不是脚本的问题；
// - 脚本只打印 token 前 8 位，不写日志。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REGISTRY = "https://registry.npmjs.org";
const dry = process.argv.includes("--dry-run");
const user = (process.env.NPM_USER ?? "").trim();
const pass = process.env.NPM_PASS ?? "";
const email = (process.env.NPM_EMAIL ?? "").trim();

if (dry) {
  console.log("计划：PUT " + REGISTRY + "/-/user/org.couchdb.user:<name>");
  console.log("需要的环境变量：NPM_USER / NPM_PASS / NPM_EMAIL");
  console.log("后果：在 npm 上创建一个账号（不可撤销，用户名永久占用）");
  process.exit(0);
}

if (!user || !pass || !email) {
  console.error("缺少 NPM_USER / NPM_PASS / NPM_EMAIL 之一。");
  process.exit(2);
}

const body = {
  _id: `org.couchdb.user:${user}`,
  name: user,
  password: pass,
  email,
  type: "user",
  roles: [] as string[],
  date: new Date().toISOString(),
};

const res = await fetch(`${REGISTRY}/-/user/org.couchdb.user:${encodeURIComponent(user)}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();

if (res.status === 409) {
  console.error(`用户名 ${user} 已被占用。换一个名字，或直接用 node scripts/npm-token.ts 登录已有账号。`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`创建失败: ${res.status} ${text.slice(0, 300)}`);
  process.exit(1);
}

let token = "";
try { token = JSON.parse(text).token ?? ""; } catch {}
if (!token) {
  console.error("账号可能已创建，但没有返回 token。用 npm-token.ts 再登录一次。");
  process.exit(1);
}

const npmrc = path.join(os.homedir(), ".npmrc");
const line = `//registry.npmjs.org/:_authToken=${token}`;
const current = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, "utf8") : "";
const kept = current.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("//registry.npmjs.org/:_authToken="));
fs.writeFileSync(npmrc, (kept.length ? kept.join("\n") + "\n" : "") + line + "\n", { mode: 0o600 });

console.log(`账号已创建并登录: ${user}`);
console.log(`token: ${token.slice(0, 8)}… → ${npmrc}`);
console.log("下一步：node scripts/publish-npm-unscoped.ts");
console.log("如果发布返回 403，去邮箱点验证链接再重跑（邮箱验证走邮件，不经过 npm 网站）。");
