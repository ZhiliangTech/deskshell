// 发布无 scope 的包名 deskshell（registry 上 404，可用），不受 npm 用户名限制。
// 用法: node scripts/publish-npm-unscoped.ts [--dry-run]
// token 来源：环境变量 NPM_TOKEN 或 ~/.npmrc
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dry = process.argv.includes("--dry-run");
const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-unscoped-"));
const NAME = (process.env.NPM_NAME || "deskshell").trim();

function token(): string {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN.trim();
  const npmrc = path.join(os.homedir(), ".npmrc");
  if (fs.existsSync(npmrc)) {
    const m = /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(\S+)/.exec(fs.readFileSync(npmrc, "utf8"));
    if (m) return m[1];
  }
  console.error("缺少 npm token：先跑 node scripts/npm-token.ts，或设置 NPM_TOKEN。");
  process.exit(2);
}

async function npmCli(): Promise<string> {
  const meta: any = await (await fetch("https://registry.npmjs.org/npm/latest")).json();
  const buf = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const tgz = path.join(work, "npm.tgz");
  fs.writeFileSync(tgz, buf);
  execFileSync("tar", ["xzf", "npm.tgz"], { cwd: work, stdio: "ignore" });
  const cli = path.join(work, "package", "bin", "npm-cli.js");
  if (!fs.existsSync(cli)) throw new Error("npm CLI 解包失败");
  return cli;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outPkg = { ...pkg, name: NAME, publishConfig: { registry: "https://registry.npmjs.org", access: "public" } };
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify(outPkg, null, 2));

for (const entry of pkg.files ?? []) {
  const src = path.join(root, entry);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(work, entry), { recursive: true });
}
for (const f of ["README.md", "LICENSE", "CHANGELOG.md"]) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(work, f));
}

const cli = await npmCli();
const npmrc = path.join(work, ".npmrc");
fs.writeFileSync(npmrc, dry ? "" : `//registry.npmjs.org/:_authToken=${token()}\n`, "utf8");
const args = [cli, "publish", "--access", "public", "--userconfig", npmrc];
const otp = (process.env.NPM_OTP ?? "").trim();
if (otp) args.push(`--otp=${otp}`);
if (dry) args.push("--dry-run");
console.log(`packing ${NAME}@${pkg.version} from a temp copy (repo untouched)`);
try {
  const out = execFileSync(process.execPath, args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(out.trim().slice(-1500));
  if (!dry) console.log(`published: ${NAME}@${pkg.version} → npm i -g ${NAME}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
