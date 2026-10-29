# 写一个 skill

一个 skill 就是一个目录：`skill.json` + `index.ts`。核心只有一个函数 `plan()`。

## 15 分钟写出第一个 skill

整套流程有自动化：`scripts/onboarding-test.ts` 会把 tarball 打进临时 prefix，然后**只照这份清单**执行一遍。文档和产品一旦对不上，这个测试就会红。

```powershell
# 0. 前置：Node 22+ 在 PATH 里（shim 要调用 node）
deskshell --version

# 1. 生成骨架 —— 落在 ~/.deskshell/skills/<name>，不会往你的工作目录里塞仓库结构
deskshell new hello-report
# → 生成 skill.json + index.ts，并打印下一步

# 2. 只改一处：打开 index.ts 改 plan()
#    （模板本身已经把文件列表写成 report.md）

# 3. 能被列出来吗？
deskshell list | Select-String hello-report

# 4. 预览：什么都不碰
deskshell run hello-report --root .\some-folder --mode preview

# 5. 执行，再撤销 —— 两步走完整套信任模型
deskshell run hello-report --root .\some-folder --mode apply
deskshell undo --last --root .\some-folder
```

预期预览长这样：

```
汇总：...
步骤：
  write:report  [ok]
```

三个真正会绊住人的坑（都已修，且被测试钉住）：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `'"node"' 不是内部或外部命令` | 装了 Node 但不在 `PATH` | 把安装目录加进 `PATH`，重开终端 |
| `deskshell new` 在你文件旁边建了 `packages/skills` | 老版本行为 | 升级；现在写到用户技能目录，给本仓库贡献才用 `--in-repo` |
| `--last needs a positive integer` | 老版本必须带数字 | 现在 `deskshell undo --last` 就是"撤最近 1 个"，`--last 3` 照旧 |

## 最小模板

```ts
import type { Action, Skill } from "../../core/src/types.ts";

export const skill: Skill = {
  manifest: {
    name: "hello-move",
    version: "0.1.0",
    description: "把 a.txt 移到 docs/ 下",
    entry: "./index.ts",
    capabilities: [
      { id: "fs.write", scope: "{{root}}", reason: "在 root 内移动文件" },
    ],
  },
  async plan({ root }) {
    return [
      {
        id: "mkdir:docs",
        kind: "fs.mkdir",
        path: `${root}/docs`,
        risk: "low",
        undo: { kind: "fs.rmdir", path: `${root}/docs` },
      },
      {
        id: "move:a",
        kind: "fs.move",
        from: `${root}/a.txt`,
        to: `${root}/docs/a.txt`,
        risk: "low",
        pre: [{ kind: "path.exists", path: `${root}/a.txt` }],
        post: [{ kind: "path.exists", path: `${root}/docs/a.txt` }],
        undo: { kind: "fs.move", from: `${root}/docs/a.txt`, to: `${root}/a.txt` },
      },
    ];
  },
};
```

## 三条硬规则

**规则一：每个动作都要有 post 断言。**
不是"执行没报错就算成功"，而是"目标状态确实成立了才算成功"。

**规则二：每个动作都要能撤销。**
能改就能撤。删除类需求请用"移入回收站目录"表达，而不是 `fs.delete`。

**规则三：不要碰系统 API。**
skill 里不写 `fs.writeFileSync`、不写 `child_process`、不写 UIA。你只能产出 `Action`，由内核去执行。

## 需要限定平台怎么办

在 `skill.json` 里声明：

```json
{ "platforms": ["win32"] }
```

缺省表示全平台。声明之后，`deskshell list` 会在其它平台标注"仅 win32"，用户一眼能看出这个 skill 在 Mac 上跑不了。

## 需要读屏幕怎么办

`plan(input, ctx)` 的第二个参数是上下文，里面有 `ctx.driver`：

```ts
async plan({ root }, ctx) {
  const tree = await ctx.driver!.tree({ titleRegex: "Edge" }, 8);
  const tabs = walk(tree).filter((n) => n.controlType === "TabItem");
  // 根据观察结果生成 Action
}
```

观察是只读的，不产生副作用；所有副作用必须回到 `Action` 里。

## 常见错误

**只写 pre 不写 post**：失败会在下游爆炸，且无法定位是哪一步坏的。

**undo 写成 null**：内核会拒绝执行。这是故意的。

**路径用相对路径**：一律用 `path.join(input.root, ...)`，并确保不越界。

**在 plan 里做副作用**：plan 会被调用两次（预览一次、执行一次），任何写入都会翻倍。

## 调试

```bash
node apps/cli-demo/main.ts --mode preview   # 只看计划，不动手
```

预览会打印每一步的 `risk` 与 `undoable`，这是最快的自检方式。
