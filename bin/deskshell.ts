#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, PolicyError, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { validateManifest } from "../packages/core/src/manifest.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

const HERE = import.meta.dirname;
const SKILLS = path.resolve(HERE, "..", "packages", "skills");
/** 用户安装的 skill 放这里，跟包版本无关（升级 deskhell 不会丢） */
const USER_SKILLS =
  process.env.DESKSHELL_SKILLS_DIR ?? path.join(os.homedir(), ".deskshell", "skills");

function c(color: number, s: string): string {
  return process.stdout.isTTY ? `\u001b[${color}m${s}\u001b[0m` : s;
}

function usage(): void {
  console.log(`deskshell — AI 电脑管家的协议内核

用法:
  deskshell list                          列出已安装的 skill
  deskshell run <name> [options]          运行一个 skill
  deskshell run a b c --parallel [opts]   并行跑多个 skill（各自独立、共用审计日志）
  deskshell new <name>                    生成 skill 骨架
  deskshell verify [--input]              检查当前平台的驱动能力
  deskshell version                       版本信息
  deskshell doctor                        环境自检（Node/平台/权限/清单/可写性）
  deskshell story [--keep] [--fail]       三场景跑一遍并整体撤销；--fail 演示失败回滚
  deskshell journal [--root DIR] [--json] 查看审计日志（谁在什么时候改了什么）
  deskshell history [--root DIR] [--json] 任务列表：skill / 步数 / 耗时 / 状态
  deskshell show [taskId] [--root DIR]    某个任务的时间线（默认最近一次）
  deskshell undo --task <id> [--root DIR]  撤销某个任务
  deskshell undo --last [N] | --since <30m>  撤销最近 N 个（默认 1）任务 / 一段时间内的任务
  deskshell add <path> [--dir DIR] [--force]  安装外部 skill（默认 ~/.deskshell/skills）

run 选项:
  --mode preview|apply|undo   默认 preview
  --root <dir>                作用目录，默认 .demo/cli
  --window <regex>            传给 skill 的窗口匹配串
  --example <name>            使用 skill 自带的示例参数（examples/<name>.json）
  --grant <a,b>               只授予指定能力（默认全部）
  --ask                       逐项确认能力（交互终端或从标准输入读 y/n）
  --parallel                  多个 skill 并行执行；一个失败不影响其它
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
  const scan = (root: string) => {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const file = path.join(root, d.name, "skill.json");
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
          dir: path.join(root, d.name),
          caps: m.capabilities.map((x) => x.id),
          internal: m.internal === true,
          platforms: m.platforms,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  };

  // 用户目录优先：同名时用户可以覆盖内置版本
  const user = scan(USER_SKILLS);
  const builtin = scan(SKILLS).filter((s) => !user.some((u) => u.name === s.name));
  return [...user, ...builtin].sort((a, b) => a.name.localeCompare(b.name));
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


/**
 * 逐项确认能力。交互终端逐条问；非交互（管道/CI）从标准输入按行读 y/n。
 * 任一项被拒 → 返回 null，调用方整单放弃。
 */
async function askCapabilities(
  caps: Array<{ id: string; reason?: string }>,
  emit: (line: string) => void,
): Promise<CapabilityId[] | null> {
  const granted: CapabilityId[] = [];

  if (process.stdin.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const cap of caps) {
        const answer = await rl.question(`授予能力 ${cap.id}（${cap.reason ?? "未说明"}）？[y/N] `);
        if (/^y(es)?$/i.test(answer.trim())) granted.push(cap.id as CapabilityId);
      }
    } finally {
      rl.close();
    }
    return granted.length === caps.length ? granted : null;
  }

  // 非交互：把标准输入读干，按行取 y/n
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  const answers = raw.split(/\r?\n/).map((x) => x.trim());
  if (answers.filter(Boolean).length === 0) {
    emit("--ask 需要输入：交互终端逐项回答，或从标准输入按行提供 y/n");
    return null;
  }
  for (let i = 0; i < caps.length; i++) {
    if (/^y(es)?$/i.test(answers[i] ?? "")) granted.push(caps[i].id as CapabilityId);
  }
  return granted.length === caps.length ? granted : null;
}

async function runSkill(
  name: string,
  flags: Record<string, string>,
  opts: { emit?: (line: string) => void } = {},
): Promise<number> {
  const out = opts.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
  const json = flags.json === "true";
  const entry = listSkills().find((s) => s.name === name);
  if (!entry) {
    if (json) out(JSON.stringify({ ok: false, error: `skill not found: ${name}` }));
    else out(`找不到 skill: ${name}（先跑 deskshell list）`);
    return 2;
  }
  const mod = (await import(pathToFileURL(path.join(entry.dir, "index.ts")).href)) as {
    skill?: Skill;
    default?: Skill;
  };
  const skill = mod.skill ?? mod.default;
  if (!skill) {
    if (json) out(JSON.stringify({ ok: false, error: `${name} 没有导出 skill` }));
    else out(`${name} 没有导出 skill`);
    return 2;
  }

  const root = path.resolve(flags.root ?? ".demo/cli");
  const mode = (flags.mode ?? "preview") as "preview" | "apply" | "undo";
  const needsDriver = entry.caps.some((x) => x.startsWith("ui.") || x === "window.move");
  let granted = (flags.grant ? flags.grant.split(",") : entry.caps) as CapabilityId[];
  if ("ask" in flags) {
    const declared = (skill.manifest.capabilities ?? []) as Array<{ id: string; reason?: string }>;
    const approved = await askCapabilities(declared, out);
    if (!approved) {
      if (json) out(JSON.stringify({ ok: false, error: "capabilities denied" }));
      else out(c(31, "已取消：") + "有能力的授予被拒绝，任务不会执行");
      return 2;
    }
    granted = approved;
  }

  let driver;
  if (needsDriver) {
    if (process.platform === "win32") {
      const { WindowsDriver } = await import("../packages/drivers/windows/driver.ts");
      driver = new WindowsDriver();
    } else if (process.platform === "darwin") {
      const { MacDriver } = await import("../packages/drivers/macos/driver.ts");
      driver = new MacDriver();
    } else {
      if (json) out(JSON.stringify({ ok: false, error: "no driver for this platform" }));
      else out("当前平台还没有驱动实现");
      return 2;
    }
  }

  if (!json) {
    out(c(36, `${skill.manifest.name}@${skill.manifest.version}`) + `  mode=${mode}  root=${root}`);
    out(`能力: ${granted.join(", ")}`);
  }

  const input: Record<string, unknown> = { root };
  if (flags.window) input.titleRegex = flags.window;
  if (flags.example) {
    const file = path.join(entry.dir, "examples", `${flags.example}.json`);
    if (!fs.existsSync(file)) {
      const msg = `没有这个示例：examples/${flags.example}.json`;
      if (json) out(JSON.stringify({ ok: false, error: msg }));
      else out(msg);
      return 2;
    }
    const example = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    Object.assign(input, example);
    if (!json) out(`示例: examples/${flags.example}.json`);
  }

  try {
    const report = await run(
      skill,
      input,
      {
        mode,
        root,
        granted,
        journalPath: path.join(root, ".deskshell", "journal.jsonl"),
        allowIrreversible: Boolean(flags["allow-irreversible"]),
      },
      { driver },
    );

    if (json) {
      out(
        JSON.stringify({
          ok: !report.steps.some((s) => s.status === "failed"),
          skill: skill.manifest.name,
          version: skill.manifest.version,
          mode,
          root,
          granted,
          steps: report.steps,
          rolledBack: report.rolledBack,
          summary: report.summary,
        }),
      );
    } else {
      for (const s of report.steps) {
        const mark = s.status === "ok" ? c(32, "✓") : s.status === "skipped" ? "·" : c(31, "✗");
        out(`  ${mark} ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
      }
      if (report.rolledBack) out(`  ↩ 回滚 ${report.rolledBack} 步`);
      const sum = report.summary;
      if (sum) {
        const parts = [
          sum.mkdir ? `新建 ${sum.mkdir}` : "",
          sum.move ? `移动 ${sum.move}` : "",
          sum.delete ? `删除 ${sum.delete}` : "",
          sum.write ? `写入 ${sum.write}` : "",
          sum.ui ? `UI ${sum.ui}` : "",
          sum.window ? `窗口 ${sum.window}` : "",
        ].filter(Boolean);
        out(
          `  汇总：${parts.join(" · ") || "无动作"} ｜ 可撤销 ${sum.undoable}/${sum.total}` +
            ` ｜ 风险 low ${sum.risk.low} / medium ${sum.risk.medium} / high ${sum.risk.high}`,
        );
        if (sum.notUndoable > 0) out(`  ⚠ ${sum.notUndoable} 步不可撤销`);
      }
    }
    return report.steps.some((s) => s.status === "failed") ? 1 : 0;
  } catch (err) {
    if (err instanceof PolicyError) {
      if (json) out(JSON.stringify({ ok: false, error: "policy", reasons: err.reasons }));
      else out(c(31, "拒绝：") + err.reasons.join("; "));
      return 2;
    }
    throw err;
  }
}

/**
 * 并行跑多个 skill：各自独立的执行流程，共享同一份审计日志。
 * 一个 skill 失败不会影响其它；退出码取其中最严重的那个。
 */
async function runParallel(names: string[], flags: Record<string, string>): Promise<number> {
  const started = Date.now();
  const results = await Promise.all(
    names.map(async (name) => {
      const lines: string[] = [];
      const code = await runSkill(name, flags, { emit: (l) => lines.push(l) });
      return { name, code, lines };
    }),
  );

  let code = 0;
  for (const r of results) {
    console.log(c(36, `── ${r.name}`) + (r.code === 0 ? c(32, "  ok") : c(31, `  exit ${r.code}`)));
    for (const line of r.lines) console.log(line);
    console.log("");
    if (r.code !== 0) code = Math.max(code, r.code);
  }
  const failed = results.filter((r) => r.code !== 0).length;
  console.log(
    `${names.length} 个 skill 并行完成，用时 ${Date.now() - started} ms，失败 ${failed} 个`,
  );
  return code;
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
    const names = positional.slice(1);
    if (!names.length) {
      usage();
      process.exitCode = 2;
      break;
    }
    if (names.length > 1 && !("parallel" in flags)) {
      console.error("多个 skill 需要加 --parallel，例如：deskshell run a b --parallel --mode apply");
      process.exitCode = 2;
      break;
    }
    process.exitCode = "parallel" in flags ? await runParallel(names, flags) : await runSkill(names[0], flags);
    break;
  }
  case "new": {
    const name = positional[1];
    if (!name) {
      usage();
      process.exitCode = 2;
      break;
    }
    // 装好包的用户没有仓库，默认写到用户技能目录；贡献者用 --in-repo
    const inRepo = Boolean(flags["in-repo"]);
    const targetDir = inRepo ? path.join(HERE, "..", "packages", "skills") : USER_SKILLS;
    const r = spawnSync(
      process.execPath,
      [path.join(HERE, "..", "scripts", "new-skill.ts"), "--name", name, "--dir", targetDir],
      {
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
  case "history": {
    const root = path.resolve(flags.root ?? ".demo/cli");
    const file = path.join(root, ".deskshell", "journal.jsonl");
    if (!fs.existsSync(file)) {
      console.log(`没有审计日志：${file}`);
      break;
    }
    const entries = load(file);
    const tasks = new Map<string, typeof entries>();
    for (const e of entries) {
      tasks.set(e.taskId, [...(tasks.get(e.taskId) ?? []), e]);
    }
    const rows = [...tasks.entries()].map(([taskId, list]) => {
      const start = Math.min(...list.map((x) => x.ts));
      const end = Math.max(...list.map((x) => x.ts));
      const failed = list.filter((x) => x.status === "failed").length;
      const rolled = list.filter((x) => x.status === "rolled-back").length;
      const state = failed ? "failed" : rolled === list.length ? "rolled-back" : rolled ? "partial" : "applied";
      return {
        taskId,
        skill: list.find((x) => x.skill)?.skill ?? "?",
        start,
        ms: end - start,
        steps: list.length,
        state,
      };
    });

    if (flags.json === "true") {
      console.log(JSON.stringify({ file, tasks: rows }));
      break;
    }
    if (rows.length === 0) {
      console.log("还没有执行记录");
      break;
    }
    console.log(`任务数 ${rows.length}  (${file})\n`);
    console.log(`${"taskId".padEnd(22)} ${"skill".padEnd(18)} ${"步数".padStart(4)}  ${"耗时".padStart(8)}  ${"状态".padEnd(12)} 开始时间`);
    for (const r of rows) {
      console.log(
        `${r.taskId.padEnd(22)} ${r.skill.padEnd(18)} ${String(r.steps).padStart(4)}  ${`${r.ms}ms`.padStart(8)}  ${r.state.padEnd(12)} ${new Date(r.start).toLocaleString("zh-CN")}`,
      );
    }
    console.log(`\n看某一次的全部步骤：deskshell show ${rows[rows.length - 1].taskId}`);
    break;
  }
  case "show": {
    const root = path.resolve(flags.root ?? ".demo/cli");
    const file = path.join(root, ".deskshell", "journal.jsonl");
    if (!fs.existsSync(file)) {
      console.log(`没有审计日志：${file}`);
      break;
    }
    const entries = load(file);
    const wanted = positional[1];
    const taskId = wanted ?? entries[entries.length - 1]?.taskId;
    if (!taskId) {
      console.log("没有可展示的任务");
      break;
    }
    const list = entries.filter((e) => e.taskId === taskId);
    if (list.length === 0) {
      console.error(`没有这个任务：${taskId}`);
      process.exitCode = 2;
      break;
    }
    const start = Math.min(...list.map((x) => x.ts));
    const end = Math.max(...list.map((x) => x.ts));
    if (flags.json === "true") {
      console.log(JSON.stringify({ taskId, skill: list[0].skill ?? "?", start, ms: end - start, entries: list }));
      break;
    }
    console.log(`${taskId}  ${list[0].skill ?? "?"}  ${list.length} 步  ${end - start} ms`);
    console.log(`${new Date(start).toLocaleString("zh-CN")}\n`);
    list.forEach((e, i) => {
      const mark = e.status === "ok" ? c(32, "✓") : e.status === "failed" ? c(31, "✗") : "↩";
      const at = new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false });
      console.log(`${mark} ${String(i + 1).padStart(2)}. ${at}  ${e.kind.padEnd(12)} ${e.summary}`);
      if (e.detail) console.log(`      ${e.detail}`);
      if (e.undo) console.log(`      undo: ${e.undo.kind}`);
    });
    break;
  }
  case "undo": {
    const root = path.resolve(flags.root ?? ".demo/cli");
    const journalPath = path.join(root, ".deskshell", "journal.jsonl");

    /** 把 "30m / 2h / 1d" 解析成毫秒 */
    const parseSpan = (raw: string): number | null => {
      const m = /^(\d+)\s*([smhd])$/i.exec(raw.trim());
      if (!m) return null;
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      const scale = unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5;
      return n * scale;
    };

    if (!flags.task && !flags.last && !flags.since) {
      console.error("用法: deskshell undo --task <taskId> | --last <N> | --since <30m|2h|1d> [--root DIR]");
      console.error("taskId 可以从 deskshell history 的输出里拿");
      process.exitCode = 2;
      break;
    }

    if (flags.task) {
      const taskId = flags.task;
      const report = await undoTask(taskId, { mode: "undo", root, granted: [], journalPath });
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

    // --last / --since：按任务批量撤销
    if (!fs.existsSync(journalPath)) {
      console.log(`没有审计日志：${journalPath}`);
      break;
    }
    const entries = load(journalPath).filter((e) => e.status === "ok");
    const byTask = new Map<string, number>();
    for (const e of entries) byTask.set(e.taskId, Math.min(byTask.get(e.taskId) ?? Infinity, e.ts));
    const ordered = [...byTask.entries()].sort((a, b) => b[1] - a[1]).map(([taskId, ts]) => ({ taskId, ts }));

    let targets = ordered;
    if (flags.last) {
      // 只写 --last 就是"撤销最近 1 个"；--last 3 才是最近 3 个
      const n = flags.last === "true" || flags.last === "" ? 1 : Number(flags.last);
      if (!Number.isInteger(n) || n <= 0) {
        console.error("用法: deskshell undo --last [N]（不写 N 就是最近 1 个任务）");
        process.exitCode = 2;
        break;
      }
      targets = ordered.slice(0, n);
    } else if (flags.since) {
      const span = parseSpan(flags.since);
      if (span === null) {
        console.error("--since 的格式是 30m / 2h / 1d");
        process.exitCode = 2;
        break;
      }
      const cutoff = Date.now() - span;
      targets = ordered.filter((t) => t.ts >= cutoff);
    }

    if (targets.length === 0) {
      console.log("没有匹配的任务可撤销");
      break;
    }

    let totalSteps = 0;
    const results: Array<{ taskId: string; rolledBack: number; failed: number }> = [];
    for (const t of targets) {
      const report = await undoTask(t.taskId, { mode: "undo", root, granted: [], journalPath });
      const failed = report.steps.filter((x) => x.status === "failed").length;
      totalSteps += report.rolledBack;
      results.push({ taskId: t.taskId, rolledBack: report.rolledBack, failed });
      if (flags.json !== "true") {
        console.log(`${t.taskId}  ↩ ${report.rolledBack} 步${failed ? `  失败 ${failed} 步` : ""}`);
        for (const s of report.steps.filter((x) => x.status === "failed")) {
          console.log(`  ✗ ${s.actionId}${s.detail ? "  " + s.detail : ""}`);
        }
      }
    }

    if (flags.json === "true") {
      console.log(JSON.stringify({ ok: results.every((r) => r.failed === 0), tasks: results, rolledBack: totalSteps }));
    } else {
      console.log(`
共撤销 ${results.length} 个任务、${totalSteps} 步${results.some((r) => r.failed) ? "（有失败项）" : ""}`);
    }
    process.exitCode = results.some((r) => r.failed) ? 1 : 0;
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
    const destRoot = path.resolve(flags.dir ?? USER_SKILLS);
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
