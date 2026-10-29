import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "../../packages/core/src/kernel.ts";
import type { CapabilityId, Skill } from "../../packages/core/src/types.ts";

/**
 * 桌面壳的核心逻辑（与 UI 无关，方便测试）。
 *
 * 设计原则：面板只负责"显示"和"收集决定"，真正执行永远走 kernel。
 * 取消 = 什么都不做；预览 = 只读；执行 = 一次 apply。
 */

const HERE = path.resolve(import.meta.dirname, "..", "..");
const BUILTIN = path.join(HERE, "packages", "skills");
const USER = process.env.DESKSHELL_SKILLS_DIR ?? path.join(os.homedir(), ".deskshell", "skills");

export interface ShellSkill {
  name: string;
  description: string;
  dir: string;
  capabilities: Array<{ id: string; reason: string }>;
  internal: boolean;
}

export interface Match {
  skill: ShellSkill;
  score: number;
}

/** 扫描内置 + 用户目录，用户目录同名优先 */
export function listShellSkills(): ShellSkill[] {
  const scan = (root: string): ShellSkill[] => {
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        const file = path.join(root, d.name, "skill.json");
        if (!fs.existsSync(file)) return [];
        const m = JSON.parse(fs.readFileSync(file, "utf8")) as {
          name: string;
          description: string;
          internal?: boolean;
          capabilities?: Array<{ id: string; reason: string }>;
        };
        return [
          {
            name: m.name,
            description: m.description,
            dir: path.join(root, d.name),
            capabilities: m.capabilities ?? [],
            internal: m.internal === true,
          },
        ];
      });
  };
  const user = scan(USER);
  const builtin = scan(BUILTIN).filter((s) => !user.some((u) => u.name === s.name));
  return [...user, ...builtin].filter((s) => !s.internal).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 一句话 → 技能。只做本地匹配，不接模型（模型是 M08 的事）。
 * 打分：名字命中 > 描述命中；同分时名字短者优先。
 */
export function matchSkills(query: string, skills = listShellSkills()): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[\s,，。;；]+/).filter((t) => t.length >= 2);

  const scored: Match[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    const desc = skill.description.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    if (name.includes(q) || q.includes(name)) score += 60;
    for (const t of tokens) {
      if (name.includes(t)) score += 20;
      if (desc.includes(t)) score += 8;
    }
    // 中文关键词：描述里出现查询中的任意两字片段也算弱命中
    if (/[\u4e00-\u9fa5]/.test(q)) {
      for (let i = 0; i + 2 <= q.length; i++) {
        const frag = q.slice(i, i + 2);
        if (desc.includes(frag)) score += 4;
      }
    }
    if (score > 0) scored.push({ skill, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.skill.name.length - b.skill.name.length);
}

export interface PreviewResult {
  skill: string;
  capabilities: Array<{ id: string; reason: string }>;
  summary: unknown;
  steps: Array<{ actionId: string; status: string; detail?: string }>;
}

async function loadSkill(skill: ShellSkill): Promise<Skill> {
  const mod = (await import(pathToFileURL(path.join(skill.dir, "index.ts")).href)) as {
    skill?: Skill;
    default?: Skill;
  };
  const s = mod.skill ?? mod.default;
  if (!s) throw new Error(`${skill.name} 没有导出 skill`);
  return s;
}

export interface ShellOptions {
  root: string;
  granted?: CapabilityId[];
}

/** 只读预览：不产生任何副作用 */
export async function preview(skill: ShellSkill, opts: ShellOptions): Promise<PreviewResult> {
  const s = await loadSkill(skill);
  const granted = opts.granted ?? (s.manifest.capabilities.map((c) => c.id) as CapabilityId[]);
  const report = await run(
    s,
    { root: opts.root },
    { mode: "preview", root: opts.root, granted, journalPath: path.join(opts.root, ".deskshell", "journal.jsonl") },
    {},
  );
  return {
    skill: skill.name,
    capabilities: (s.manifest.capabilities ?? []).map((c) => ({ id: c.id, reason: c.reason ?? "" })),
    summary: report.summary,
    steps: report.steps,
  };
}

/** 执行：走 kernel 的 apply */
export async function apply(skill: ShellSkill, opts: ShellOptions): Promise<{ steps: number; rolledBack: number }> {
  const s = await loadSkill(skill);
  const granted = opts.granted ?? (s.manifest.capabilities.map((c) => c.id) as CapabilityId[]);
  const report = await run(
    s,
    { root: opts.root },
    { mode: "apply", root: opts.root, granted, journalPath: path.join(opts.root, ".deskshell", "journal.jsonl") },
    {},
  );
  return { steps: report.steps.length, rolledBack: report.rolledBack };
}

/**
 * 取消：显式地什么都不做。
 * 存在这个函数是为了让 UI 有一个可测试的"取消"入口，而不是"关窗就完事"。
 */
export function cancel(): { cancelled: true } {
  return { cancelled: true };
}
