// 用 GitHub Git Data API 推送本地目录（绕过 github.com 的 git 写通道）
// 用法: node scripts/push-to-github.mjs --owner <owner> --repo <repo> [--branch main] [--msg "..."]
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { tick } from "./lib/clock-store.ts";

tick("push to GitHub", "ship");
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

async function call(url, method = "GET", body, attempt = 0) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    // GitHub 的"二次限流"就是 403/429：并发上传 blob 很容易触发，退避重试即可
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 4) {
      const wait = 800 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      return call(url, method, body, attempt + 1);
    }
    throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 200)}`);
  }
  return json;
}

const SKIP = new Set([".git", ".demo", ".tmp", "site", "node_modules", ".build", ".worklog", ".deskshell", ".mail"]);
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

// 远端已有的 blob 不再重传：内容 sha 一致就复用远端 sha。
// 这样一次推送只上传真正改动的文件，也不会撞上二级限流。
const remoteBlobs = new Map();
if (head) {
  try {
    const tree = await call(`${api}/git/trees/${head.object.sha}?recursive=1`);
    for (const e of tree.tree) if (e.type === "blob") remoteBlobs.set(e.path, e.sha);
  } catch {}
}

const localSha = (buf) =>
  crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

async function uploadWithRetry(payload) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      return await call(`${api}/git/blobs`, "POST", payload);
    } catch (e) {
      last = e;
      const m = String(e.message);
      if (!/→ (403|429|500|502|503)/.test(m)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, i)));
    }
  }
  throw last;
}

const results = [];
let uploaded = 0;
let unchanged = 0;
for (const file of files) {
  const rel = path.relative(".", file).split(path.sep).join("/");
  const buf = fs.readFileSync(file);
  const sha = localSha(buf);
  if (remoteBlobs.get(rel) === sha) {
    results.push({ path: rel, mode: "100644", type: "blob", sha });
    unchanged++;
    continue;
  }
  const blob = await uploadWithRetry({ content: buf.toString("base64"), encoding: "base64" });
  results.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
  uploaded++;
  process.stdout.write(`\r已上传 ${uploaded}（未变 ${unchanged}）/${files.length}`);
}
process.stdout.write(`\n合计：上传 ${uploaded}，复用远端 ${unchanged}\n`);

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
