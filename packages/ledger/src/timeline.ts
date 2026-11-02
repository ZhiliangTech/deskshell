import type { LoadedEntry } from "../../core/src/journal.ts";

/**
 * 时间轴：把账本按"对象"归组，而不是按任务。
 *
 * 任务列表回答"我跑过什么"，时间轴回答"这个东西经历了什么"——后者才是
 * "电脑有历史"这个主张的最小可见形态。
 */
export interface TimelineItem {
  at: number;
  taskId: string;
  actionId: string;
  kind: string;
  skill?: string;
  status: "ok" | "rolled-back" | "failed";
  summary: string;
  detail?: string;
  /** 现在还能不能撤回：状态是 ok 且记录了真实撤销动作 */
  revertible: boolean;
}

export interface ObjectHistory {
  object: string;
  items: TimelineItem[];
}

export interface TimelineOptions {
  /** 只看某个对象（相对 root 的路径，或 UI 动作的窗口名） */
  object?: string;
  /** 起始时间戳（毫秒），更早的记录不显示 */
  sinceMs?: number;
}

export const UNLABELED = "(未标注对象)";

export function buildTimeline(entries: readonly LoadedEntry[], opts: TimelineOptions = {}): ObjectHistory[] {
  const groups = new Map<string, TimelineItem[]>();
  for (const e of entries) {
    const object = e.object ?? UNLABELED;
    if (opts.object !== undefined && object !== opts.object) continue;
    if (opts.sinceMs !== undefined && e.ts < opts.sinceMs) continue;
    const item: TimelineItem = {
      at: e.ts,
      taskId: e.taskId,
      actionId: e.actionId,
      kind: e.kind,
      ...(e.skill ? { skill: e.skill } : {}),
      status: e.status,
      summary: e.summary,
      ...(e.detail ? { detail: e.detail } : {}),
      revertible: e.status === "ok" && e.undo !== undefined && e.undo.kind !== "noop",
    };
    const list = groups.get(object);
    if (list) list.push(item);
    else groups.set(object, [item]);
  }
  return [...groups.entries()]
    .map(([object, items]) => ({ object, items: items.sort((a, b) => b.at - a.at) }))
    .sort((a, b) => (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0));
}

/** 支持 30m / 24h / 7d，也接受纯毫秒数 */
export function parseSince(spec: string, now = Date.now()): number {
  const m = /^(\d+)([mhd])$/.exec(spec.trim());
  if (!m) {
    const ms = Number(spec);
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`无法解析的时间范围：${spec}`);
    return now - ms;
  }
  const amount = Number(m[1]);
  const unit = m[2];
  const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return now - amount * factor;
}
