// 从 GitHub 拉取 main 分支全部文件到当前目录（当 git fetch 通道不可用时使用）
// 用法: node scripts/sync-from-github.mjs --owner <owner> --repo <repo>
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
if (!owner || !repo) {
  console.error("需要 --owner 和 --repo");
  process.exit(2);
}

const token = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".dsh", "storages", "dsh-github", "settings.json"), "utf8"),
).token;
const headers = { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "User-Agent": "deskshell-sync" };
const api = `https://api.github.com/repos/${owner}/${repo}`;

async function get(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

const tree = await get(`${api}/git/trees/${branch}?recursive=1`);
const blobs = tree.tree.filter((n) => n.type === "blob");
console.log(`远端 ${blobs.length} 个文件`);

let written = 0;
for (const b of blobs) {
  const data = await get(`${api}/git/blobs/${b.sha}`);
  const content = Buffer.from(data.content, "base64");
  const target = path.join(".", b.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  written++;
  if (written % 20 === 0) process.stdout.write(`\r已写入 ${written}/${blobs.length}`);
}
process.stdout.write(`\r已写入 ${written}/${blobs.length}\n`);
console.log("commit:", tree.sha);
