#!/usr/bin/env node
/**
 * Published entry point for the `deskshell` CLI.
 *
 * The CLI is written in TypeScript and relies on Node's native type stripping
 * (no build step). Node refuses to strip types for any file that lives under a
 * `node_modules` directory — ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — and
 * no flag (`--experimental-strip-types`, `--experimental-transform-types`)
 * lifts that restriction.
 *
 * So: from a source checkout the CLI runs in place; from an installed copy the
 * runtime tree is mirrored once per version into a user cache and executed from
 * there. `bin/deskshell.ts` stays the real implementation and remains the file
 * you edit.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(ROOT, "bin", "deskshell.ts");
const RUNTIME_DIRS = ["bin", "packages", "schema", "scripts", "apps"];

function fail(message) {
  console.error(`deskshell: ${message}`);
  process.exit(1);
}

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (!ok) {
    fail(
      `需要 Node >= 22.18 或 >= 23.6 才能直接运行 TypeScript，当前是 ${process.versions.node}。`,
    );
  }
}

function insideNodeModules(dir) {
  return dir
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((part) => part.toLowerCase() === "node_modules");
}

function cacheRoot() {
  const candidates = [
    process.env.DESKSHELL_RUNTIME_DIR,
    path.join(os.homedir(), ".deskshell", "runtime"),
    path.join(os.tmpdir(), "deskshell-runtime"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // try the next candidate
    }
  }
  fail("找不到可写的缓存目录（可用 DESKSHELL_RUNTIME_DIR 指定）");
}

/**
 * 手写递归拷贝：Node 22.23.4 的 fs.cpSync 在 Windows 上拷这个包会直接触发
 * 访问违例（exit -1073741819），换成 readdir + copyFileSync 就正常。
 */
function copyTree(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyTree(path.join(src, entry.name), path.join(dst, entry.name));
    }
    return;
  }
  if (stat.isFile()) fs.copyFileSync(src, dst);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.isFile()) {
      const stat = fs.statSync(path.join(ROOT, rel));
      out.push(`${rel.replace(/\\/g, "/")}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    }
  }
  return out;
}

function fingerprint(version) {
  const rows = RUNTIME_DIRS.filter((dir) => fs.existsSync(path.join(ROOT, dir)))
    .flatMap((dir) => walk(dir, []))
    .sort();
  return createHash("sha256").update(`${version}\n${rows.join("\n")}`).digest("hex").slice(0, 12);
}

function mirror() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const target = path.join(cacheRoot(), `${pkg.name}@${pkg.version}-${fingerprint(pkg.version)}`);
  if (fs.existsSync(path.join(target, "bin", "deskshell.ts"))) return target;

  const staging = `${target}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const dir of RUNTIME_DIRS) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) copyTree(src, path.join(staging, dir));
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(staging, "package.json"));
  try {
    fs.renameSync(staging, target);
  } catch {
    // another process won the race; use whatever landed there
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(path.join(target, "bin", "deskshell.ts"))) {
      fail(`无法准备运行目录：${target}`);
    }
  }
  return target;
}

checkNode();
if (!fs.existsSync(ENTRY)) fail(`缺少 ${ENTRY}`);
const base = insideNodeModules(ROOT) ? mirror() : ROOT;
const child = spawnSync(process.execPath, [path.join(base, "bin", "deskshell.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (child.error) fail(child.error.message);
process.exitCode = child.status ?? 1;
