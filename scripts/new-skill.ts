import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce<Array<[string, string]>>((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] ?? ""]);
    return acc;
  }, []),
);

const name = args.name;
if (!name) {
  console.error("用法: node scripts/new-skill.ts --name my-skill");
  process.exit(2);
}

const base = args.dir && args.dir.length > 0 ? args.dir : path.join("packages", "skills");
const dir = path.join(base, name);
if (fs.existsSync(dir)) {
  console.error(`目录已存在：${dir}`);
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const manifest = {
  name,
  version: "0.1.0",
  description: "把 root 里的文件按扩展名列一个清单",
  entry: "./index.ts",
  capabilities: [
    { id: "fs.read", scope: "{{root}}", reason: "读取目录，按扩展名分组" },
    { id: "fs.write", scope: "{{root}}", reason: "把清单写入 report.md" },
  ],
};
fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

const source = `import fs from "node:fs";
import path from "node:path";
import type { Action, Skill } from "../../core/src/types.ts";

export const skill: Skill = {
  manifest: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "skill.json"), "utf8")),

  async plan({ root }): Promise<Action[]> {
    const files = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile());
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase() || "(无扩展名)";
      groups.set(ext, [...(groups.get(ext) ?? []), f.name]);
    }

    const lines = [...groups.entries()]
      .sort()
      .map(([ext, names]) => \`- \${ext}: \${names.length} 个（\${names.slice(0, 3).join(", ")}）\`);
    const content = \`# 文件清单\\n\\n共 \${files.length} 个文件\\n\\n\${lines.join("\\n")}\\n\`;
    const target = path.join(root, "report.md");

    return [
      {
        id: "write:report",
        kind: "fs.write",
        path: target,
        content,
        risk: "low",
        post: [{ kind: "path.exists", path: target }],
        undo: { kind: "fs.restore", path: target, content: null },
      },
    ];
  },
};

export default skill;
`;
fs.writeFileSync(path.join(dir, "index.ts"), source, "utf8");

console.log(`[新建] ${dir}`);
console.log(`  1. 改 index.ts 里的 plan()`);
console.log(`  2. 预览： node apps/cli-demo/run.ts --skill ${dir}/index.ts --mode preview`);
console.log(`  3. 执行： node apps/cli-demo/run.ts --skill ${dir}/index.ts --mode apply --root .demo/downloads`);

const rel = path.relative(process.cwd(), dir) || dir;
console.log("");
console.log("下一步：");
console.log(`  1. 打开 ${path.join(rel, "index.ts")}，改 plan() 里的动作`);
console.log(`  2. deskshell run ${name} --root . --mode preview   # 只看计划，不动文件`);
console.log(`  3. deskshell run ${name} --root . --mode apply`);
console.log(`  4. deskshell undo --last --root .                 # 撤销`);
