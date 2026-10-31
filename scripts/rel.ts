import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".dsh/storages/dsh-github/settings.json"), "utf8"),
).token;
const h = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "x",
  "Content-Type": "application/json",
};
const OWNER = "ZhiliangTech";
const REPO = "deskshell";
const api = `https://api.github.com/repos/${OWNER}/${REPO}`;
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
const version = pkg.version;
const assetName = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;

const ref = await (await fetch(`${api}/git/ref/heads/main`, { headers: h })).json();
console.log("main", ref.object.sha.slice(0, 7));

const exists = await fetch(`${api}/git/refs/tags/v${version}`, { headers: h });
if (exists.status === 200) {
  await fetch(`${api}/git/refs/tags/v${version}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ sha: ref.object.sha, force: true }),
  });
  console.log("tag moved");
} else {
  const t = await fetch(`${api}/git/refs`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ ref: `refs/tags/v${version}`, sha: ref.object.sha }),
  });
  console.log("tag", t.status);
}

const body = `\`mcp install\` 之前会往一个不存在的客户端目录里写配置——写成功了，但用户打开客户端什么也看不到。

## 现在

    $ deskshell mcp install --client claude
    没找到 claude 的安装目录（<home>）。
    先把客户端装上，或者确认路径没错；就是要写的话加 --force。

退出码 2，不写任何文件。装了客户端才写；要强行写就 \`--force\`。

## 证据

\`\`\`
regress 53/53（mcp.install 15 → 17 条，新增"装了/没装"两条判定）
\`\`\``;

const rel = await (
  await fetch(`${api}/releases`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ tag_name: `v${version}`, name: `deskshell ${version}`, body }),
  })
).json();
console.log("release:", rel.html_url ?? rel.message);

const asset = path.join(os.homedir(), assetName);
const up = await fetch(
  `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${assetName}`,
  { method: "POST", headers: { ...h, "Content-Type": "application/octet-stream" }, body: fs.readFileSync(asset) },
);
const j = await up.json();
console.log("asset:", up.status, j.browser_download_url ?? j.message);
