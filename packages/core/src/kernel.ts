import type {
  Action,
  JournalEntry,
  RunOptions,
  RunReport,
  Skill,
  SkillContext,
  SkillInput,
  StepResult,
} from "./types.ts";
import { checkAction, checkCapabilities, maxRisk } from "./policy.ts";
import { append, load, markRolledBack } from "./journal.ts";
import { applyUndo, checkAssertion, describe, execute } from "./executor.ts";

export class PolicyError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.name = "PolicyError";
    this.reasons = reasons;
  }
}

export async function run(
  skill: Skill,
  input: SkillInput,
  opts: RunOptions,
  ctx: SkillContext = {},
): Promise<RunReport> {
  if (opts.mode === "undo") return undoLastTask(opts, ctx);

  const capDecision = checkCapabilities(skill.manifest.capabilities, opts.granted, opts.root);
  if (!capDecision.allowed) throw new PolicyError(capDecision.reasons);

  const actions = await skill.plan(input, ctx);
  const declared = skill.manifest.capabilities.map((c) => c.id);
  const violations = actions
    .map((a) => ({ action: a, decision: checkAction(a, opts.root, declared) }))
    .filter((x) => !x.decision.allowed);
  if (violations.length > 0) {
    throw new PolicyError(violations.flatMap((v) => v.decision.reasons));
  }

  if (opts.mode === "preview") {
    const steps: StepResult[] = actions.map((a) => ({
      actionId: a.id,
      status: "skipped",
      detail: `${describe(a)}  [risk=${a.risk ?? "low"}, undoable=${a.undo !== null}]`,
    }));
    return { mode: "preview", steps, journal: [], rolledBack: 0 };
  }

  const taskId = `task-${Date.now()}`;
  const steps: StepResult[] = [];
  const done: JournalEntry[] = [];
  const execCtx = { ...ctx, root: opts.root };

  for (const action of actions) {
    try {
      for (const pre of action.pre ?? []) {
        if (!(await checkAssertion(pre, execCtx))) {
          throw new Error(`前置条件不满足：${JSON.stringify(pre)}`);
        }
      }
      await execute(action, execCtx);
      for (const post of action.post ?? []) {
        if (!(await checkAssertion(post, execCtx))) {
          throw new Error(`后置断言失败：${JSON.stringify(post)}`);
        }
      }
      const entry: JournalEntry = {
        ts: Date.now(),
        taskId,
        actionId: action.id,
        kind: action.kind,
        summary: describe(action),
        status: "ok",
        undo: action.undo ?? undefined,
      };
      append(opts.journalPath, entry);
      done.push(entry);
      steps.push({ actionId: action.id, status: "ok" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ actionId: action.id, status: "failed", detail });

      // 失败也要进审计日志：否则"出过什么事"只存在于终端输出里
      append(opts.journalPath, {
        ts: Date.now(),
        taskId,
        actionId: action.id,
        kind: action.kind,
        summary: describe(action),
        status: "failed",
        detail,
        undo: action.undo ?? undefined,
      });

      // 关键：失败的动作本身可能已经产生了副作用（比如写完文件才断言失败），
      // 必须先撤掉它自己的改动，再按 LIFO 回滚之前成功的步骤。
      let selfUndone = 0;
      if (action.undo) {
        try {
          await applyUndo(action.undo, execCtx);
          selfUndone = 1;
        } catch {
          selfUndone = 0;
        }
      }

      for (const e of [...done].reverse()) {
        if (e.undo) await applyUndo(e.undo, execCtx);
        e.status = "rolled-back";
      }
      const doneKeys = new Set(done.map((e) => `${e.taskId}:${e.actionId}`));
      markRolledBack(
        opts.journalPath,
        load(opts.journalPath).map((e) =>
          doneKeys.has(`${e.taskId}:${e.actionId}`) ? { ...e, status: "rolled-back" as const } : e,
        ),
      );
      return { mode: "apply", steps, journal: done, rolledBack: done.length + selfUndone };
    }
  }

  return { mode: "apply", steps, journal: done, rolledBack: 0 };
}

async function undoLastTask(opts: RunOptions, ctx: SkillContext): Promise<RunReport> {
  const entries = load(opts.journalPath).filter((e) => e.status === "ok");
  if (entries.length === 0) return { mode: "undo", steps: [], journal: [], rolledBack: 0 };
  const lastTask = entries[entries.length - 1].taskId;
  const target = entries.filter((e) => e.taskId === lastTask);
  const steps: StepResult[] = [];
  const execCtx = { ...ctx, root: opts.root };

  for (const e of [...target].reverse()) {
    try {
      if (e.undo) await applyUndo(e.undo, execCtx);
      e.status = "rolled-back";
      steps.push({ actionId: e.actionId, status: "ok", detail: `撤销 ${e.summary}` });
    } catch (err) {
      steps.push({
        actionId: e.actionId,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  markRolledBack(opts.journalPath, load(opts.journalPath).map((e) =>
    e.taskId === lastTask ? { ...e, status: "rolled-back" as const } : e,
  ));
  return { mode: "undo", steps, journal: target, rolledBack: target.length };
}

export function summarizeRisk(actions: Action[]): string {
  return maxRisk(actions);
}

/** 撤销指定任务（按 action 逆序），用于"只撤掉刚才那一次" */
export async function undoTask(
  taskId: string,
  opts: RunOptions,
  ctx: SkillContext = {},
): Promise<RunReport> {
  const all = load(opts.journalPath);
  const target = all.filter((e) => e.taskId === taskId && e.status === "ok");
  if (target.length === 0) return { mode: "undo", steps: [], journal: [], rolledBack: 0 };

  const execCtx = { ...ctx, root: opts.root };
  const steps: StepResult[] = [];
  const rolled = new Set<string>();

  for (const e of [...target].reverse()) {
    const key = `${e.taskId}:${e.actionId}`;
    try {
      if (e.undo) await applyUndo(e.undo, execCtx);
      rolled.add(key);
      steps.push({ actionId: e.actionId, status: "ok", detail: `撤销 ${e.summary}` });
    } catch (err) {
      steps.push({
        actionId: e.actionId,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  markRolledBack(
    opts.journalPath,
    all.map((e) => (rolled.has(`${e.taskId}:${e.actionId}`) ? { ...e, status: "rolled-back" as const } : e)),
  );

  return { mode: "undo", steps, journal: target, rolledBack: rolled.size };
}

/** 撤销整个日志里的所有任务（从最新到最旧），用于"把今天做的都撤了" */
export async function undoAll(opts: RunOptions, ctx: SkillContext = {}): Promise<RunReport> {
  const all = load(opts.journalPath);
  const done = all.filter((e) => e.status === "ok");
  if (done.length === 0) return { mode: "undo", steps: [], journal: [], rolledBack: 0 };

  const execCtx = { ...ctx, root: opts.root };
  const steps: StepResult[] = [];
  const rolled = new Set<string>();

  for (const e of [...done].reverse()) {
    const key = `${e.taskId}:${e.actionId}`;
    try {
      if (e.undo) await applyUndo(e.undo, execCtx);
      rolled.add(key);
      steps.push({ actionId: e.actionId, status: "ok", detail: `撤销 ${e.summary}` });
    } catch (err) {
      steps.push({
        actionId: e.actionId,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  markRolledBack(
    opts.journalPath,
    all.map((e) =>
      rolled.has(`${e.taskId}:${e.actionId}`) ? { ...e, status: "rolled-back" as const } : e,
    ),
  );

  return { mode: "undo", steps, journal: done, rolledBack: rolled.size };
}
