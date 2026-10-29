// 发布到 npm：本机没有 npm CLI，所以先从 registry 取一份临时 npm 再执行。
// 用法: NPM_TOKEN=xxxx node scripts/publish-npm.mjs [--dry-run]
//
// token 来源优先级：环境变量 NPM_TOKEN > ~/.npmrc 里的 //registry.npmjs.org/:_authToken
// 脚本不会把 token 打到任何输出里。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dry = process.argv.includes("--dry-run");
const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-publish-"));

function token(): string {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN.trim();
  const npmrc = path.join(os.homedir(), ".npmrc");
  if (fs.existsSync(npmrc)) {
    const m = /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(\S+)/.exec(fs.readFileSync(npmrc, "utf8"));
    if (m) return m[1];
  }
  console.error(
    "缺少 npm token。两种方式二选一：\n" +
      "  1) 在本会话里提供：export NPM_TOKEN=npm_xxx（或告诉我，我写进临时环境）\n" +
      "  2) 写入 ~/.npmrc： //registry.npmjs.org/:_authToken=npm_xxx",
  );
  process.exit(2);
}

async function fetchNpm(): Promise<string> {
  const meta = await (await fetch("https://registry.npmjs.org/npm/latest")).json();
  const url = meta.dist.tarball as string;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const tgz = path.join(work, "npm.tgz");
  fs.writeFileSync(tgz, buf);
  execFileSync("tar", ["xzf", "npm.tgz"], { cwd: work, stdio: "ignore" });
  const cli = path.join(work, "package", "bin", "npm-cli.js");
  if (!fs.existsSync(cli)) throw new Error("npm CLI 解包失败");
  return cli;
}

const npmCli = await fetchNpm();
const npmrc = path.join(work, ".npmrc");
fs.writeFileSync(
  npmrc,
  dry ? "" : `//registry.npmjs.org/:_authToken=${token()}\n`,
  "utf8",
);

const args = [npmCli, dry ? "publish" : "publish", "--access", "public", "--userconfig", npmrc];
if (dry) args.push("--dry-run");

console.log(`cwd: ${root}`);
console.log(`npm: ${process.versions.node} → ${npmCli.replace(work, "<tmp>")}`);
console.log(dry ? "mode: dry-run" : "mode: publish");

const out = execFileSync(process.execPath, args, {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
console.log(out.trim().slice(-2000));

if (!dry) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const url = `https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}/${pkg.version}`;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      console.log(`published: ${pkg.name}@${pkg.version} · tarball ${j.dist?.tarball ?? "?"}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

fs.rmSync(work, { recursive: true, force: true });
