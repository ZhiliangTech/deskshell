import { execFileSync } from "node:child_process";
import fsp from "node:fs";
import p from "node:path";
const work = "F:/开源项目1/deskshell/.mail/.deps";
fsp.mkdirSync(work, { recursive: true });
const meta = await (await fetch("https://registry.npmjs.org/npm/latest")).json();
const tgz = p.join(work, "npm.tgz");
if (!fsp.existsSync(tgz)) {
  fsp.writeFileSync(tgz, Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer()));
  execFileSync("tar", ["xzf", "npm.tgz"], { cwd: work, stdio: "ignore" });
}
const cli = p.join(work, "package", "bin", "npm-cli.js");
console.log("npm cli:", fsp.existsSync(cli));
try {
  const out = execFileSync(process.execPath, [cli, "install", "imapflow", "--prefix", work, "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
  console.log("install ok", String(out).slice(-200));
} catch (e) {
  console.log("install failed:", String((e && e.stdout) || "").slice(-300), String((e && e.stderr) || "").slice(-300));
}
const dir = p.join(work, "node_modules", "imapflow");
console.log("imapflow present:", fsp.existsSync(dir));
if (fsp.existsSync(dir)) {
  const pkg = JSON.parse(fsp.readFileSync(p.join(dir, "package.json"), "utf8"));
  console.log("version:", pkg.version, "| main:", pkg.main, "| module:", pkg.module, "| type:", pkg.type);
}
