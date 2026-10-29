#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, PolicyError, undoTask } from "../packages/core/src/kernel.ts";
import { validateManifest } from "../packages/core/src/manifest.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const HERE = import.meta.dirname;
const SKILLS = path.resolve(HERE, "..", "packages", "skills");

function c(color: number, s: string): string {
  return process.stdout.isTTY ? `\u001b[${color}m${s}\u001b[0m` : s;
}

function usage(): void {
  console.log(`deskshell — AI 电脑管家的协议内核

用法:
  deskshell list                          列出已安装的 skill
  deskshell run <name> [options]          运行一个 skill
  deskshell new <name>                    生成 skill 骨架
  deskshell verify [--input]              检查当前平台的驱动能力
  deskshell version                       版本信息
  deskshell doctor                        环境自检（Node/平台/权限/清单/可写性）
  deskshell story [--keep] [--fail]       三场景跑一遍并整体撤销；--fail 演示失败回滚
  deskshell journal [--root DIR] [--json] 查看审计日志（谁在什么时候改了什么）
  deskshell undo --task <id> [--root DIR]  撤销某个任务
  deskshell add <path> [--dir DIR] [--force]  安装外部 skill

run 选项:
  --mode preview|apply|undo   默认 preview
  --root <dir>                作用目录，默认 .demo/cli
  --window <regex>            传给 skill 的窗口匹配串
  --example <name>            使用 skill 自带的示例参数（examples/<name>.json）
  --grant <a,b>               只授予指定能力（默认全部）
  --json                      输出机器可读结果（CI/脚本用）

示例:
  deskshell run downloads-cleanup --mode apply --root .demo/downloads
  deskshell run browser-tabs --mode preview --window Edge
`);
}

function listSkills(): Array<{
  name: string;
  version: string;
  description: string;
  dir: string;
  caps: string[];
  internal: boolean;
  platforms?: string[];
}> {
  if (!fs.existsSync(SKILLS)) return [];
  return fs
    .readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = path.join(SKILLS, d.name, "skill.json");
      if (!fs.existsSync(file)) return null;
      const m = JSON.parse(fs.readFileSync(file, "utf8")) as {
        name: string;
        version: string;
        description: string;
        internal?: boolean;
        platforms?: string[];
        capabilities: Array<{ id: string }>;
      };
      return {
        name: m.name,
        version: m.version,
        description: m.description,
        dir: path.join(SKILLS, d.name),
        caps: m.capabilities.map((x) => x.id),
        internal: m.internal === true,
        platforms: m.platforms,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parse(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = "true";
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

async function runSkill(name: string, flags: Record<string, string>): Promise<number> {
  const json = flags.json === "true";
  const entry = listSkills().find((s) => s.name === name);
  if (!entry) {
    if (json) console.log(JSON.stringify({ ok: false, error: `skill not found: ${name}` }));
    else console.error(`找不到 skill: ${name}（先跑 deskshell list）`);
    return 2;
  }
  const mod = (await import(pathToFileURL(path.join(entry.dir, "index.ts")).href)) as {
    skill?: Skill;
    default?: Skill;
  };
  const skill = mod.skill ?? mod.default;
  if (!skill) {
    if (json) console.log(JSON.stringify({ ok: false, error: `${name} 没有导出 skill` }));
    else console.error(`${name} 没有导出 skill`);
    return 2;
  }

  const root = path.resolve(flags.root ?? ".demo/cli");
  const mode = (flags.mode ?? "preview") as "preview" | "apply" | "undo";
  const needsDriver = entry.caps.some((x) => x.startsWith("ui.") || x === "window.move");
  const granted = (flags.grant ? flags.grant.split(",") : entry.caps) as CapabilityId[];

  let driver;
  if (needsDriver) {
    if (process.platform === "win32") {
      const { WindowsDriver } = await import("../packages/drivers/windows/driver.ts");
      driver = new WindowsDriver();
    } else if (process.platform === "darwin") {
      const { MacDriver } = await import("../packages/drivers/macos/driver.ts");
      driver = new MacDriver();
    } else {
      if (json) console.log(JSON.stringify({ ok: false, error: "no driver for this platform" }));
      else console.error("当前平台还没有驱动实现");
      return 2;
    }
  }

  if (!json) {
    console.log(c(36, `${skill.manifest.name}@${skill.manifest.version}`) + `  mode=${mode}  root=${root}`);
    console.log(`能力: ${granted.join(", ")}`);
  }

  const input: Record<string, unknown> = { root };
  if (flags.window) input.titleRegex = flags.window;
  if (flags.example) {
    const file = path.join(entry.dir, "examples", `${flags.example}.json`);
    if (!fs.existsSync(file)) {
      const msg = `没有这个示例：examples/${flags.example}.json`;
      if (json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(msg);
      return 2;
    }
    const example = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    Object.assign(input, example);
    if (!json) console.log(`示例: examples/${flags.example}.json`);
  }

  try {
    const report = await run(
      skill,
      input,
      { mode, root, granted, journalPath: path.join(root, ".deskshell", "journal.jsonl") },
      { driver },
    );

    if (json) {
      console.log(
        JSON.stringify({
          ok: !report.steps.some((s) => s.status === "failed"),
          skill: skill.manifest.name,
          version: skill.manifest.version,
          mode,
          root,
          granted,
          steps: report.steps,
          rolledBack: report.rolledBack,
        }),
      );
    } else {
      for (const s of report.steps) {
        const mark = s.status === "ok" ? c(32, "✓") : s.status === "skipped" ? "·" : c(31, "✗");
        console.log(`  ${mark} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
      }
      if (report.rolledBack) console.log(`  ↩ 回滚 ${report.rolledBack} 步`);
    }
    return report.steps.some((s) => s.status === "failed") ? 1 : 0;
  } catch (err) {
    if (err instanceof PolicyError) {
      if (json) console.log(JSON.stringify({ ok: false, error: "policy", reasons: err.reasons }));
      else console.error(c(31, "拒绝：") + err.reasons.join("; "));
      return 2;
    }
    throw err;
  }
}

const argv = process.argv.slice(2);
const { positional, flags } = parse(argv);
const cmd = positional[0];

switch (cmd) {
  case "list": {
    const skills = listSkills();
    const pub = skills.filter((s) => !s.internal);
    const hidden = skills.filter((s) => s.internal);
    console.log(`${pub.length} 个 skill\n`);
    for (const s of pub) {
      const usable = !s.platforms || s.platforms.includes(process.platform);
      const note = usable ? "" : c(33, `（仅 ${s.platforms?.join("/")}）`);
      console.log(`${s.name.padEnd(20)} v${s.version.padEnd(8)} ${s.description}${note}`);
      console.log(`${"".padEnd(20)} 能力: ${s.caps.join(", ")}`);
    }
    if (hidden.length) {
      console.log(`\n（另有 ${hidden.length} 个内部/测试 skill：${hidden.map((s) => s.name).join(", ")}）`);
    }
    break;
  }
  case "run": {
    const name = positional[1];
    if (!name) {
      usage();
      process.exitCode = 2;
      break;
    }
    process.exitCode = await runSkill(name, flags);
    break;
  }
  case "new": {
    const name = positional[1];
    if (!name) {
      usage();
      process.exitCode = 2;
      break;
    }
    const r = spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "new-skill.ts"), "--name", name], {
      stdio: "inherit",
    });
    process.exitCode = r.status ?? 1;
    break;
  }
  case "verify": {
    const args = [path.join(HERE, "..", "scripts", "verify-driver.ts")];
    if (flags.input) args.push("--input");
    const r = spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
    break;
  }
  case "version": {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    console.log(`${pkg.name.replace(/^@[^/]+\//, "")} ${pkg.version}  (protocol v0, node ${process.versions.node}, ${process.platform})`);
    break;
  }
  case "doctor": {
    const r = spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "doctor.ts")], {
      stdio: "inherit",
    });
    process.exitCode = r.status ?? 1;
    break;
  }
  case "story": {
    const args = [path.join(HERE, "..", "apps", "cli-demo", "story.ts")];
    if (flags.keep) args.push("--keep");
    if (flags.fail) args.push("--fail");
    const r = spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
    break;
  }
  case "journal": {
    const root = path.resolve(flags.root ?? ".demo/cli");
    const file = path.join(root, ".deskshell", "journal.jsonl");
    if (!fs.existsSync(file)) {
      console.error(`没有审计日志：${file}`);
      process.exitCode = 2;
      break;
    }
    const entries = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as {
        ts: number;
        taskId: string;
        actionId: string;
        summary: string;
        status: "ok" | "rolled-back";
      });

    const tasks = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = tasks.get(e.taskId) ?? [];
      list.push(e);
      tasks.set(e.taskId, list);
    }

    if (flags.json === "true") {
      console.log(
        JSON.stringify({
          file,
          tasks: [...tasks.entries()].map(([taskId, list]) => ({
            taskId,
            startedAt: new Date(Math.min(...list.map((x) => x.ts))).toISOString(),
            steps: list.length,
            rolledBack: list.filter((x) => x.status === "rolled-back").length,
            entries: list,
          })),
        }),
      );
      break;
    }

    console.log(`${tasks.size} 个任务 / ${entries.length} 步  (${file})\n`);
    for (const [taskId, list] of tasks) {
      const start = new Date(Math.min(...list.map((x) => x.ts)));
      const rolled = list.filter((x) => x.status === "rolled-back").length;
      const failed = list.filter((x) => x.status === "failed").length;
      const state = failed
        ? `失败 ${failed} 步`
        : rolled === list.length
          ? "已撤销"
          : rolled > 0
            ? `部分撤销(${rolled})`
            : "已执行";
      console.log(`${taskId}  ${start.toLocaleString("zh-CN")}  ${list.length} 步  ${state}`);
      for (const e of list.slice(0, 6)) {
        const mark = e.status === "ok" ? "✓" : e.status === "failed" ? "✗" : "↩";
        console.log(`  ${mark} ${e.summary}${e.status === "failed" && e.detail ? `  (${e.detail})` : ""}`);
      }
      if (list.length > 6) console.log(`  … 其余 ${list.length - 6} 步`);
      console.log("");
    }
    break;
  }
  case "undo": {
    const taskId = flags.task;
    if (!taskId) {
      console.error("用法: deskshell undo --task <taskId> [--root DIR]");
      console.error("taskId 可以从 deskshell journal 的输出里拿");
      process.exitCode = 2;
      break;
    }
    const root = path.resolve(flags.root ?? ".demo/cli");
    const report = await undoTask(taskId, {
      mode: "undo",
      root,
      granted: [],
      journalPath: path.join(root, ".deskshell", "journal.jsonl"),
    });
    if (flags.json === "true") {
      console.log(JSON.stringify({ ok: true, taskId, steps: report.steps, rolledBack: report.rolledBack }));
    } else {
      if (report.rolledBack === 0) console.log(`没有可撤销的步骤：${taskId}`);
      for (const s of report.steps) {
        console.log(`  ${s.status === "ok" ? "↩" : "✗"} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
      }
      if (report.rolledBack) console.log(`已撤销 ${report.rolledBack} 步`);
    }
    break;
  }
  case "add": {
    const src = positional[1];
    if (!src) {
      usage();
      process.exitCode = 2;
      break;
    }
    const srcDir = path.resolve(src);
    const manifestFile = path.join(srcDir, "skill.json");
    if (!fs.existsSync(manifestFile)) {
      console.error(`不是合法的 skill 目录（缺 skill.json）：${srcDir}`);
      process.exitCode = 2;
      break;
    }
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      name?: string;
      version?: string;
      description?: string;
      entry?: string;
      capabilities?: Array<{ id: string; reason: string }>;
      platforms?: string[];
    };
    const check = validateManifest(m);
    if (!check.ok) {
      console.error("skill.json 校验失败：");
      for (const p of check.problems) console.error(`  · ${p.field}: ${p.message}`);
      process.exitCode = 2;
      break;
    }
    const destRoot = path.resolve(flags.dir ?? SKILLS);
    const dest = path.join(destRoot, m.name);
    if (fs.existsSync(dest) && flags.force !== "true") {
      console.error(`目标已存在：${dest}（加 --force 覆盖）`);
      process.exitCode = 2;
      break;
    }
    fs.mkdirSync(destRoot, { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true, force: true });
    console.log(`已安装 ${m.name}@${m.version ?? "0.0.0"} → ${dest}`);
    console.log("它会申请这些能力：");
    for (const c of m.capabilities) console.log(`  · ${c.id}  ${c.reason}`);
    break;
  }
  default:
    usage();
    process.exitCode = cmd ? 2 : 0;
}
