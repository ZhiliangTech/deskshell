import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listShellSkills, type ShellSkill } from "./core.ts";

/**
 * 一句话 → 带参数的计划。
 *
 * 这一层故意是**离线确定性**的：先不接模型，把"技能 + 参数"的契约固定下来。
 * 模型只是可选后端（ModelBackend），接进来时替换的是实现，不是契约。
 */

export type SlotType = "extensions" | "days" | "path" | "text" | "number";

export interface SlotSpec {
  type: SlotType;
  required?: boolean;
  hint?: string;
}

export interface IntentSpec {
  triggers: string[];
  args?: Record<string, SlotSpec>;
}

export interface IntentResult {
  skill: string;
  args: Record<string, unknown>;
  confidence: number;
  missing: string[];
  question?: string;
  reason: string;
  /** 命中的触发词，便于解释"为什么是它" */
  matched?: string;
  /** 并列候选：触发词一样长时，别假装只有一个答案 */
  candidates?: string[];
}

export interface ModelBackend {
  name: string;
  resolve(query: string, skills: ShellSkill[]): Promise<IntentResult | null>;
}

/** 从 skill.json 读 intents（core 的 ShellSkill 不带，这里单独读一次） */
export function intentsOf(skill: ShellSkill): IntentSpec | null {
  const file = path.join(skill.dir, "skill.json");
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { intents?: IntentSpec };
  return raw.intents ?? null;
}

const EXT_ALIASES: Record<string, string[]> = {
  图片: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"],
  照片: [".jpg", ".jpeg", ".png", ".heic"],
  截图: [".png", ".jpg"],
  视频: [".mp4", ".mov", ".mkv"],
  文档: [".pdf", ".doc", ".docx", ".txt", ".md"],
  压缩包: [".zip", ".rar", ".7z"],
  日志: [".log"],
};

const PATH_ALIASES: Array<[RegExp, string]> = [
  [/下载文件夹|下载目录|下载/, path.join(os.homedir(), "Downloads")],
  [/桌面/, path.join(os.homedir(), "Desktop")],
  [/图片文件夹|图片目录/, path.join(os.homedir(), "Pictures")],
  [/文档文件夹|文档目录/, path.join(os.homedir(), "Documents")],
];

const DAY_WORDS: Array<[RegExp, number]> = [
  [/一周|一个星期|7\s*天/, 7],
  [/半个月|15\s*天/, 15],
  [/一个月|30\s*天/, 30],
  [/三个月|90\s*天/, 90],
  [/半年|180\s*天/, 180],
  [/一年|365\s*天/, 365],
];

export function extractArgs(query: string, spec: IntentSpec | null): { args: Record<string, unknown>; missing: string[] } {
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  if (!spec?.args) return { args, missing };

  for (const [name, slot] of Object.entries(spec.args)) {
    let value: unknown;

    if (slot.type === "extensions") {
      const explicit = [...query.matchAll(/\.?([a-z0-9]{2,5})\b/gi)]
        .map((m) => `.${m[1].toLowerCase()}`)
        .filter((e) => /\.(jpg|jpeg|png|gif|webp|heic|mp4|mov|pdf|zip|log|txt|md|docx?)$/.test(e));
      const aliased = Object.entries(EXT_ALIASES)
        .filter(([word]) => query.includes(word))
        .flatMap(([, exts]) => exts);
      const all = [...new Set([...explicit, ...aliased])];
      if (all.length) value = all;
    } else if (slot.type === "days") {
      const m = query.match(/(\d+)\s*(天|日)/);
      if (m) value = Number(m[1]);
      else {
        const word = DAY_WORDS.find(([re]) => re.test(query));
        if (word) value = word[1];
      }
    } else if (slot.type === "path") {
      // 「从 A 到 B」：A/B 常常是裸词（src、backup），没有分隔符也没有引号
      const pair = query.match(/从\s*([A-Za-z0-9_.\-]+)\s*[^到]*?到\s*([A-Za-z0-9_.\-]+)/);
      if (pair) {
        const value2 = name === "source" ? pair[1] : name === "dest" ? pair[2] : undefined;
        if (value2 !== undefined) {
          args[name] = value2;
          continue;
        }
      }
      const quoted = query.match(/["“']([^"”']+)["”']/);
      if (quoted) value = quoted[1];
      else {
        const alias = PATH_ALIASES.find(([re]) => re.test(query));
        if (alias) value = alias[1];
        else {
          // 显式的相对路径写法：src/ 或 a\b
          const rel = query.match(/(?:^|\s)([A-Za-z0-9_.-]+[\\/][A-Za-z0-9_./\\-]*)/);
          if (rel) value = rel[1];
        }
      }
    } else if (slot.type === "text") {
      const named = query.match(/(?:前缀|命名为|叫做|名字叫)\s*[:：]?\s*([A-Za-z0-9_\u4e00-\u9fa5-]+)/);
      if (named) value = named[1];
    } else if (slot.type === "number") {
      const m = query.match(/(\d+)/);
      if (m) value = Number(m[1]);
    }

    if (value !== undefined) args[name] = value;
    else if (slot.required) missing.push(name);
  }
  return { args, missing };
}

/** 规则后端：离线、确定、可解释。默认就用它。 */
export class RuleBackend implements ModelBackend {
  name = "rules";

  async resolve(query: string, skills: ShellSkill[]): Promise<IntentResult | null> {
    const q = query.trim().toLowerCase();
    if (!q) return null;

    const hits: Array<{ skill: ShellSkill; trigger: string; length: number }> = [];
    for (const skill of skills) {
      const spec = intentsOf(skill);
      const triggers = [...(spec?.triggers ?? []), skill.name];
      for (const trigger of triggers) {
        const t = trigger.toLowerCase();
        if (q.includes(t)) hits.push({ skill, trigger, length: t.length });
      }
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => b.length - a.length);
    const best = hits[0];
    const tied = hits.filter((h) => h.length === best.length && h.skill.name !== best.skill.name);

    const spec = intentsOf(best.skill);
    const { args, missing } = extractArgs(query, spec);
    const required = Object.entries(spec?.args ?? {})
      .filter(([, s]) => s.required)
      .map(([n]) => n);
    const filledRequired = required.filter((n) => n in args).length;
    const confidence = required.length === 0 ? 0.9 : 0.5 + 0.4 * (filledRequired / required.length);

    const firstMissing = missing[0];
    return {
      skill: best.skill.name,
      args,
      confidence: Number(confidence.toFixed(2)),
      missing,
      question: firstMissing ? (spec?.args?.[firstMissing]?.hint ?? `还需要提供 ${firstMissing}`) : undefined,
      reason: `命中触发词「${best.trigger}」`,
      matched: best.trigger,
      ...(tied.length ? { candidates: [...new Set(tied.map((t) => t.skill.name))] } : {}),
    };
  }
}

/**
 * 固定问答后端：给测试和多轮对话复现用。
 * 真接模型时实现同一个接口即可，契约不变。
 */
export class FixtureBackend implements ModelBackend {
  name = "fixture";
  // 注意：Node 的类型擦除不支持构造函数参数属性（constructor(private x)），
  // 这里必须显式声明字段再赋值。
  private readonly answers: Record<string, IntentResult>;

  constructor(answers: Record<string, IntentResult>) {
    this.answers = answers;
  }

  async resolve(query: string): Promise<IntentResult | null> {
    return this.answers[query.trim()] ?? null;
  }
}

export async function resolveIntent(
  query: string,
  opts: { backend?: ModelBackend; skills?: ShellSkill[] } = {},
): Promise<IntentResult | null> {
  const skills = opts.skills ?? listShellSkills();
  return (opts.backend ?? new RuleBackend()).resolve(query, skills);
}
