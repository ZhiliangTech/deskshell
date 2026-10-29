// 用 GitHub Git Data API 推送本地目录（绕过 github.com 的 git 写通道）
// 用法: node scripts/push-to-github.mjs --owner <owner> --repo <repo> [--branch main] [--msg "..."]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, []),
);

const owner = args.owner;
const repo = args.repo;
const branch = args.branch ?? "main";
const message = args.msg ?? "feat: deskshell 0.1.0";
if (!owner || !repo) {
  console.error("需要 --owner 和 --repo");
  process.exit(2);
}

const settings = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".dsh", "storages", "dsh-github", "settings.json"), "utf8"),
);
const token = settings.token;
const api = `https://api.github.com/repos/${owner}/${repo}`;

const headers = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "deskshell-push",
  "Content-Type": "application/json",
};

async function call(url, method = "GET", body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const SKIP = new Set([".git", ".demo", ".tmp", "site", "node_modules", ".build"]);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) files.push(p);
  }
})(".");

console.log(`准备上传 ${files.length} 个文件`);

// 空仓库不能直接建 blob（409），先通过 Contents API 落一个初始提交
let head = await call(`${api}/git/ref/heads/${branch}`).catch(() => null);
if (!head) {
  const readme = fs.readFileSync("README.md", "utf8");
  await call(`${api}/contents/README.md`, "PUT", {
    message: "chore: 初始化仓库",
    content: Buffer.from(readme, "utf8").toString("base64"),
    branch,
  });
  head = await call(`${api}/git/ref/heads/${branch}`);
  console.log("已用 README 初始化仓库");
}

async function upload(file) {
  const content = fs.readFileSync(file).toString("base64");
  const rel = path.relative(".", file).split(path.sep).join("/");
  const blob = await call(`${api}/git/blobs`, "POST", { content, encoding: "base64" });
  return { path: rel, mode: "100644", type: "blob", sha: blob.sha };
}

const results = [];
const CONCURRENCY = 4;
for (let i = 0; i < files.length; i += CONCURRENCY) {
  const chunk = files.slice(i, i + CONCURRENCY);
  const done = await Promise.all(chunk.map(upload));
  results.push(...done);
  process.stdout.write(`\r已上传 ${results.length}/${files.length}`);
}
process.stdout.write("\n");

const tree = await call(`${api}/git/trees`, "POST", { tree: results });
const commit = await call(`${api}/git/commits`, "POST", {
  message,
  tree: tree.sha,
  parents: head ? [head.object.sha] : [],
});
await call(`${api}/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha, force: true });
console.log(`分支 ${branch} → ${commit.sha.slice(0, 7)}`);

// 轻量 tag
try {
  await call(`${api}/git/refs`, "POST", { ref: "refs/tags/v0.1.0", sha: commit.sha });
  console.log("tag v0.1.0 已创建");
} catch (err) {
  console.log("tag 跳过：", String(err).slice(0, 80));
}
console.log("DONE", `https://github.com/${owner}/${repo}`);
