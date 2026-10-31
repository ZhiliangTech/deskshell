import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 把 R0 基准搬到别人的机器上跑。
 *
 * 这不是"对比工具"，是"把我们的数字搬到对方的环境里复算一遍"——
 * 换机器能复现，数字才有意义；只在作者笔记本上成立的东西不值得引用。
 *
 * 需要的环境变量（缺一个就干净地跳过，不报错）：
 *   R0_SSH_HOST   目标机器（e2b / daytona / 你的 VPS 都行）
 *   R0_SSH_USER   登录用户，默认 root
 *   R0_SSH_KEY    私钥路径，可选（默认用 ssh agent）
 *   R0_REMOTE_DIR 远端目录，默认 /tmp/deskshell-r0
 *
 * 用法：
 *   node scripts/r0-remote.ts            # 有环境变量就跑，没有就说明缺什么
 *   node scripts/r0-remote.ts --print    # 只打印将要执行的命令
 */
const host = process.env.R0_SSH_HOST;
const user = process.env.R0_SSH_USER ?? "root";
const key = process.env.R0_SSH_KEY;
const remote = process.env.R0_REMOTE_DIR ?? "/tmp/deskshell-r0";
const printOnly = process.argv.includes("--print");

const sshBase = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", ...(key ? ["-i", key] : [])];
const target = `${user}@${host}`;

function ssh(command: string): string {
  return execFileSync("ssh", [...sshBase, target, command], { encoding: "utf8" });
}

function scp(local: string, dest: string): void {
  execFileSync("scp", [...sshBase, local, `${target}:${dest}`], { stdio: "inherit" });
}

if (!host) {
  console.log("跳过：没有设置 R0_SSH_HOST。");
  console.log("");
  console.log("想把 R0 跑到别人的机器上（或者只是换台机器复算），给三个变量就够了：");
  console.log("  R0_SSH_HOST=你的机器  R0_SSH_USER=root  [R0_SSH_KEY=~/.ssh/id_ed25519]");
  console.log("");
  console.log("这台机器上能跑的对应命令：");
  console.log("  node scripts/recovery-bench.ts      # 文件面");
  console.log("  node scripts/recovery-bench-ui.ts   # UI 面（需要 Mock 驱动，无窗口）");
  process.exit(0);
}

const tarball = path.resolve(".demo/deskshell-r0.tgz");
fs.mkdirSync(path.dirname(tarball), { recursive: true });
execFileSync("tar", ["-czf", tarball, "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".demo", "."], {
  stdio: "inherit",
});

const steps: Array<[string, () => void | string]> = [
  ["远端准备目录", () => ssh(`mkdir -p ${remote}`)],
  ["上传", () => scp(tarball, `${remote}/src.tgz`)],
  ["解包", () => ssh(`cd ${remote} && tar -xzf src.tgz && rm -f src.tgz`)],
  ["远端 node 版本", () => ssh(`node --version || echo "没有 node"`)],
  ["跑文件面 R0", () => ssh(`cd ${remote} && node scripts/recovery-bench.ts`)],
  ["跑 UI 面 R0", () => ssh(`cd ${remote} && node scripts/recovery-bench-ui.ts`)],
];

if (printOnly) {
  console.log(`目标：${target}:${remote}`);
  for (const [name] of steps) console.log(`  将执行：${name}`);
  process.exit(0);
}

for (const [name, fn] of steps) {
  process.stdout.write(`→ ${name} … `);
  const out = fn();
  console.log("done");
  if (typeof out === "string" && out.trim() && /R0|version|跳过/.test(out)) {
    console.log(out.trim().split("\n").slice(-6).join("\n"));
  }
}

console.log("");
console.log("远端算完的数字在上面。把它贴进 outreach/STATE.md，并注明机器与 node 版本——");
console.log("只写一个百分比、不说在哪跑出来的，等于没跑。");
