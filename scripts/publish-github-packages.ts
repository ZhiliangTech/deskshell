// 发布到 GitHub Packages（npm 官网不可达时的替代渠道）。
// 用法: node scripts/publish-github-packages.ts [--dry-run]
//
// token 来源：~/.dsh/storages/dsh-github/settings.json（与 push-to-github 同一份）
// 需要 scope: write:packages。脚本不打印 token。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dry = process.argv.includes("--dry-run");
const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-ghpkg-"));

function githubToken(): string {
  const file = path.join(os.homedir(), ".dsh", "storages", "dsh-github", "settings.json");
  if (!fs.existsSync(file)) throw new Error(`找不到 GitHub 凭据：${file}`);
  const token = JSON.parse(fs.readFileSync(file, "utf8")).token as string;
  if (!token) throw new Error("凭据文件里没有 token");
  return token;
}

async function fetchNpm(): Promise<string> {
  const meta = await (await fetch("https://registry.npmjs.org/npm/latest")).json();
  const buf = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  fs.writeFileSync(path.join(work, "npm.tgz"), buf);
  execFileSync("tar", ["xzf", "npm.tgz"], { cwd: work, stdio: "ignore" });
  return path.join(work, "package", "bin", "npm-cli.js");
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
if (!pkg.name.startsWith("@")) throw new Error("GitHub Packages 需要作用域包名（@owner/name）");

const npmCli = await fetchNpm();
const npmrc = path.join(work, ".npmrc");
fs.writeFileSync(
  npmrc,
  dry ? "" : `//npm.pkg.github.com/:_authToken=${githubToken()}\n@zhiliangtech:registry=https://npm.pkg.github.com\n`,
  "utf8",
);

const args = [npmCli, "publish", "--registry", "https://npm.pkg.github.com", "--userconfig", npmrc];
if (dry) args.push("--dry-run");

console.log(`package: ${pkg.name}@${pkg.version}`);
console.log(dry ? "mode: dry-run" : "mode: publish → npm.pkg.github.com");

const out = execFileSync(process.execPath, args, {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
console.log(out.trim().slice(-2000));

if (!dry) {
  const url = `https://npm.pkg.github.com/${pkg.name.replace("/", "%2f")}`;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${githubToken()}` } });
    if (r.ok) {
      const j = await r.json();
      console.log(`registry sees: ${j.name} latest=${j["dist-tags"]?.latest ?? "?"}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

fs.rmSync(work, { recursive: true, force: true });
