import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] ?? ".demo/downloads");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const jpg = crypto.randomBytes(2048);
const pdf = crypto.randomBytes(4096);
const dup = Buffer.from("same-content-for-duplicate-detection", "utf8");

const files: Array<[string, Buffer]> = [
  ["IMG_2041.jpg", jpg],
  ["IMG_2042.jpg", jpg], // 重复
  ["screenshot.png", crypto.randomBytes(1024)],
  ["合同-终稿.pdf", pdf],
  ["合同-终稿(1).pdf", pdf], // 重复
  ["readme.md", Buffer.from("# notes", "utf8")],
  ["notes.txt", dup],
  ["notes-copy.txt", dup], // 重复
  ["archive.zip", crypto.randomBytes(512)],
  ["demo.mp4", crypto.randomBytes(8192)],
  ["app.ts", Buffer.from("export const x = 1;", "utf8")],
  ["data.json", Buffer.from('{"ok":true}', "utf8")],
  ["未命名文件", Buffer.from("misc", "utf8")],
];

for (const [name, content] of files) {
  fs.writeFileSync(path.join(root, name), content);
}

const count = fs.readdirSync(root).length;
console.log(`fixture ready: ${root}  (${count} files)`);
