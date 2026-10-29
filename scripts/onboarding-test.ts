import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * M09：假装自己是外人。
 *
 * 把打好的 tarball 装进一个临时目录（不碰全局、不联网），然后在**空的临时工作目录**里
 * 只照文档执行：new → 改一处 → list → preview → apply → undo。
 * 任何一步跑不通，都是产品/文档的问题，不是测试的问题。
 */
const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};

const repo = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-onboard-"));
const prefix = path.join(work, "prefix");
const sandbox = path.join(work, "sandbox");
fs.mkdirSync(sandbox, { recursive: true });

// Windows 上 npm / deskshell 都是 .cmd，spawn 必须走 shell，否则 EINVAL
const winShell = process.platform === "win32";

const run = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? sandbox,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: winShell,
  });

const tryRun = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number; out: string } => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? sandbox,
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: winShell,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// npm 不一定在 PATH 里（Node 可能来自别的发行包），按候选找第一个存在的
function pickNpm(): string {
  const exe = process.platform === "win32" ? "npm.cmd" : "npm";
  const candidates = [
    process.env.DESKSHELL_NPM,
    path.join(path.dirname(process.execPath), exe),
    ...(process.platform === "win32" ? ["C:/Users/zhili/Programs/node/npm.cmd"] : []),
    exe,
  ].filter((x): x is string => Boolean(x));
  for (const c of candidates) {
    if (c === exe || fs.existsSync(c)) return c;
  }
  return exe;
}

const npm = pickNpm();

// ---------- 1) 打包并装进临时 prefix ----------
let tarball = "";
try {
  const packOut = run(npm, ["pack", repo, "--pack-destination", work], { cwd: work });
  tarball = packOut.trim().split(/\r?\n/).pop() ?? "";
} catch (err) {
  check("能打包出 tarball", false, String(err).slice(0, 200));
  console.log(checks.join("\n"));
  process.exit(1);
}
check("能打包出 tarball", tarball.endsWith(".tgz"), tarball);

const install = tryRun(npm, ["i", "--prefix", prefix, "--no-audit", "--no-fund", path.join(work, tarball)], { cwd: work });
check("能把包装进临时 prefix（离线，用本地 tarball）", install.code === 0, install.out.slice(-300));

const bin = process.platform === "win32"
  ? path.join(prefix, "node_modules", ".bin", "deskshell.cmd")
  : path.join(prefix, "node_modules", ".bin", "deskshell");
check("安装后拿到 deskshell 可执行", fs.existsSync(bin), bin);

const skillsDir = path.join(work, "user-skills");
// deskshell 的 shim 会调用 `node`，所以把当前 node 所在目录放进 PATH——
// 真实用户装完能跑，前提也是 node 在 PATH 里。
const env = {
  DESKSHELL_SKILLS_DIR: skillsDir,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
};

// ---------- 2) 按文档跑：deskshell new ----------
const made = tryRun(bin, ["new", "hello-report"], { env });
check("deskshell new 成功", made.code === 0, made.out.slice(-300));
const newDir = path.join(skillsDir, "hello-report");
check("skill 落在用户技能目录（不是仓库里）", fs.existsSync(path.join(newDir, "skill.json")), newDir);
check("new 打印了下一步指引", /下一步/.test(made.out), made.out.slice(-160));

// ---------- 3) 只改一处：把描述换掉 ----------
const manifestFile = path.join(newDir, "skill.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { name: string; description: string };
manifest.description = "列出 root 里的文件并写成 report.md（陌生人也能改的一步）";
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
check("改 skill.json 后仍是合法 JSON", JSON.parse(fs.readFileSync(manifestFile, "utf8")).description.includes("陌生人"));

// ---------- 4) 能列出来 ----------
const listed = tryRun(bin, ["list"], { env });
check("deskshell list 能看到新 skill", listed.code === 0 && listed.out.includes("hello-report"), listed.out.slice(-200));

// ---------- 5) 预览 → 执行 → 撤销 ----------
const fixture = path.join(work, "downloads");
fs.mkdirSync(fixture, { recursive: true });
for (const f of ["a.txt", "b.jpg", "c.md"]) fs.writeFileSync(path.join(fixture, f), f);

const preview = tryRun(bin, ["run", "hello-report", "--root", fixture, "--mode", "preview"], { env });
check("预览成功", preview.code === 0, preview.out.slice(-300));
check("预览显示了计划和汇总", /汇总|步/.test(preview.out), preview.out.slice(-200));
check("预览没有产生日志", !fs.existsSync(path.join(fixture, ".deskshell", "journal.jsonl")));

const applied = tryRun(bin, ["run", "hello-report", "--root", fixture, "--mode", "apply"], { env });
check("执行成功", applied.code === 0, applied.out.slice(-300));
check("执行后 report.md 存在", fs.existsSync(path.join(fixture, "report.md")));

const undone = tryRun(bin, ["undo", "--last", "--root", fixture], { env });
check("撤销成功", undone.code === 0, undone.out.slice(-300));
check("撤销后 report.md 不在了", !fs.existsSync(path.join(fixture, "report.md")));

// ---------- 6) 错误信息要能指路 ----------
const missing = tryRun(bin, ["run", "no-such-skill", "--root", fixture], { env });
check("跑不存在的 skill 时退出码非零", missing.code !== 0, String(missing.code));
check("错误信息提示用 list 查看可用技能", /list/.test(missing.out), missing.out.slice(-200));

// ---------- 清理 ----------
fs.rmSync(work, { recursive: true, force: true });

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
