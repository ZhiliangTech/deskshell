import fs from "node:fs";
import path from "node:path";

/**
 * 递归拷贝目录/文件。
 *
 * 为什么不用 `fs.cpSync`：Node 22.23.4 在 Windows 上拷目录树会直接触发访问违例
 * （进程 exit -1073741819 / bash 报 139），拷同样的内容换成 readdir + copyFileSync
 * 就正常。这个坑先是在 `bin/deskshell.mjs` 里被踩到并绕开，文档构建和发布脚本里
 * 仍然用着 cpSync，于是 `node scripts/build-docs.ts` 在 Windows 上会静默崩掉。
 * 统一走这一个实现，别再各自拷一遍。
 *
 * 语义对齐 `fs.cpSync(src, dst, { recursive: true })` 的常用部分：
 * - 目录递归创建，文件覆盖写；
 * - 已存在的目标目录不报错；
 * - 符号链接/联接点不跟随（拷贝链接本身），避免拷进环里。
 */
export function copyTree(src: string, dst: string): void {
  const stat = fs.lstatSync(src);

  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    fs.rmSync(dst, { force: true, recursive: false });
    fs.symlinkSync(target, dst);
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyTree(path.join(src, entry.name), path.join(dst, entry.name));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
