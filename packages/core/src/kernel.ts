import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Action,
  ActionSummary,
  ExecContext,
  JournalEntry,
  RunOptions,
  RunReport,
  Skill,
  SkillContext,
  SkillInput,
  SkillManifest,
  StepResult,
  UndoAction,
} from "./types.ts";
import { checkAction, checkCapabilities, maxRisk, undoIsPlaceholder } from "./policy.ts";
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


/**
 * 不可逆动作的硬闸：没有显式确认就整单拒绝，**在动手之前**拒绝。
 * 放过去就没有退路了，所以这里不做"尽量"。
 *
 * 判定顺序（任何一条成立就算不可逆）：
 *   1. skill 自己标了 irreversible；
 *   2. undo 是占位（缺失 / null / 文件变更上的 noop）；
 *   3. undo 依赖的能力当前驱动没有（没有 setValue 就没有 ui.type 的撤销）。
 */
function isIrreversible(action: Action, ctx: SkillContext = {}): boolean {
  if (action.irreversible === true) return true;
  if (undoIsPlaceholder(action)) return true;
  const undo = action.undo;
  if (undo?.kind === "ui.value" && !ctx.driver?.setValue) return true;
  if (undo?.kind === "window.move" && !ctx.driver?.moveWindow) return true;
  return false;
}

function assertIrreversibleConfirmed(
  actions: readonly Action[],
  reversible: readonly boolean[],
  opts: RunOptions,
): void {
  const irreversible = actions.filter((_, index) => !reversible[index]);
  if (irreversible.length === 0 || opts.allowIrreversible) return;
  throw new Error(
    `这一步不可逆，需要显式确认：${irreversible.map((a) => a.id).join(", ")}` +
      "（确认：deskshell run … --allow-irreversible；MCP 传 allowIrreversible: true）",
  );
}

/** 宿主控制不属于 Action v0；任务 ID 的唯一认领由宿主负责。 */
export interface ExecutionControl {
  taskId?: string;
  /** 仅在 apply 的动作边界检查；不强行中断正在执行的效果或恢复。 */
  signal?: AbortSignal;
  /** 默认保持 v0 自动补偿；宿主可关闭并保留现场，交给自己的恢复协议。 */
  rollbackOnFailure?: boolean;
  /** 前置断言通过后、效果发生前；抛错会作为该步失败记账。 */
  beforeAction?: (action: Action, index: number) => void | Promise<void>;
  /** 成功效果完成且记账后；抛错原样上抛，不将已完成效果重新标成失败。 */
  afterAction?: (action: Action, index: number) => void | Promise<void>;
}

export const ACTION_CANCELLED_DETAIL = "Execution cancelled before action";

function assertCapabilities(manifest: SkillManifest, opts: RunOptions): void {
  const decision = checkCapabilities(manifest.capabilities, opts.granted, opts.root);
  if (!decision.allowed) throw new PolicyError(decision.reasons);
}

export async function run(
  skill: Skill,
  input: SkillInput,
  opts: RunOptions,
  ctx: SkillContext = {},
  control: ExecutionControl = {},
): Promise<RunReport> {
  if (opts.mode === "undo") return undoLastTask(opts, ctx);

  assertCapabilities(skill.manifest, opts);
  const actions = await skill.plan(input, ctx);
  return executeActions(skill.manifest, actions, opts, ctx, control);
}

/**
 * 执行宿主已经保存的动作，不调用 skill.plan。复制纯数据输入，避免调用者在 await
 * 期间改写正在执行的批次；计划摘要、审批和跨调用幂等仍由宿主保证。
 * 取消保留已完成的效果，并用下一步的 skipped 标记返回；不会自动宣称已恢复。
 */
export async function runActions(
  manifest: SkillManifest,
  actions: readonly Action[],
  opts: RunOptions,
  ctx: SkillContext = {},
  control: ExecutionControl = {},
): Promise<RunReport> {
  if (control.taskId !== undefined && (typeof control.taskId !== "string" || control.taskId.trim() === "")) {
    throw new Error("taskId must be a non-empty string");
  }
  if (opts.mode === "undo") return undoLastTask(opts, ctx);

  const manifestCopy = structuredClone(manifest);
  const optsCopy = { ...opts, granted: [...opts.granted] };
  assertCapabilities(manifestCopy, optsCopy);
  return executeActions(manifestCopy, structuredClone(actions), optsCopy, ctx, { ...control });
}

/**
 * 这条记录触及的对象：文件类用相对 root 的路径，UI 类用窗口名。
 * 时间轴按它归组——没有这个字段，"同一个对象的历史"就只能靠解析人话摘要。
 */
function objectOf(action: Action, root: string): string | undefined {
  const rel = (p: string): string => {
    const r = path.relative(root, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : p;
  };
  switch (action.kind) {
    case "fs.mkdir":
    case "fs.delete":
    case "fs.write":
      return rel(action.path);
    case "fs.move":
      return rel(action.to);
    case "ui.click":
    case "ui.invoke":
    case "ui.type":
    case "window.move":
      return action.window;
    default:
      return undefined;
  }
}

async function executeActions(
  manifest: SkillManifest,
  actions: readonly Action[],
  opts: RunOptions,
  ctx: SkillContext,
  control: ExecutionControl,
): Promise<RunReport> {
  const declared = manifest.capabilities.map((c) => c.id);
  const violations = actions
    .map((a) => ({ action: a, decision: checkAction(a, opts.root, declared, manifest.capabilities) }))
    .filter((x) => !x.decision.allowed);
  if (violations.length > 0) {
    throw new PolicyError(violations.flatMap((v) => v.decision.reasons));
  }

  // 每一步"能不能撤"在动手之前就定下来。
  // 执行之后再判定会看到被自己改过的文件系统（例如 fs.write 覆盖已有文件：写之前
  // 目标不存在=可撤，写完再问就成了"覆盖"，同一动作得出一致结论才谈得上审计）。
  const reversible = actions.map((action) => !isIrreversible(action, ctx));
  const undoOf = (action: Action, index: number): UndoAction | undefined =>
    reversible[index] ? action.undo ?? undefined : undefined;

  if (opts.mode === "apply") assertIrreversibleConfirmed(actions, reversible, opts);

  if (opts.mode === "preview") {
    const steps: StepResult[] = actions.map((a, index) => ({
      actionId: a.id,
      status: "skipped",
      detail: `${describe(a)}  [risk=${a.risk ?? "low"}, undoable=${reversible[index]}]`,
    }));
    const summary: ActionSummary = {
      total: actions.length,
      mkdir: 0,
      move: 0,
      delete: 0,
      write: 0,
      ui: 0,
      window: 0,
      undoable: 0,
      notUndoable: 0,
      irreversible: 0,
      risk: { low: 0, medium: 0, high: 0 },
    };
    for (const [index, a] of actions.entries()) {
      if (a.kind === "fs.mkdir") summary.mkdir++;
      else if (a.kind === "fs.move") summary.move++;
      else if (a.kind === "fs.delete") summary.delete++;
      else if (a.kind === "fs.write") summary.write++;
      else if (a.kind === "window.move") summary.window++;
      else summary.ui++;
      if (!reversible[index]) {
        summary.irreversible++;
        summary.notUndoable++;
      } else summary.undoable++;
      summary.risk[a.risk ?? "low"]++;
    }
    return { mode: "preview", steps, journal: [], rolledBack: 0, summary };
  }

  // 并发运行时两个任务可能在同一毫秒启动，只用时间戳会撞 id，
  // 撞了之后日志里的 taskId 就分不开谁是谁（并行撤销也会串）。
  const taskId = control.taskId ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const steps: StepResult[] = [];
  const done: JournalEntry[] = [];
  const execCtx = { ...ctx, root: opts.root };
  const cancelledBefore = (action: Action): RunReport => {
    steps.push({ actionId: action.id, status: "skipped", detail: ACTION_CANCELLED_DETAIL });
    return { mode: "apply", taskId, steps, journal: done, rolledBack: 0 };
  };

  for (const [index, action] of actions.entries()) {
    if (control.signal?.aborted) return cancelledBefore(action);
    let phase: "pre" | "exec" | "post" = "pre";
    // 声明在 try 外：catch 里的"自撤"要用它带来的 createdDirs。
    // 放在 try 内会被作用域隔开，catch 引用就 ReferenceError，而那个 catch 又会把错误吞掉，
    // 结果就是"自撤静默失效、目录里留下半成品"——这个坑真的踩过一次。
    let execResult: Awaited<ReturnType<typeof execute>>;
    try {
      for (const pre of action.pre ?? []) {
        if (!(await checkAssertion(pre, execCtx))) {
          throw new Error(`前置条件不满足：${JSON.stringify(pre)}`);
        }
      }
      // 前置观察也可能等待驱动；取消已经到达时，不再启动这一步的写入。
      if (control.signal?.aborted) return cancelledBefore(action);
      // 宿主钩子先跑完，再做逐动作策略复查：钩子是 await，复查之后再 await 一次
      // 就留下"检查的是目录、写的是 junction"的窗口（实测能把文件写出 root）。
      if (control.beforeAction) await control.beforeAction(structuredClone(action), index);
      // 逐动作复查策略：批次开始时查过一次，但那之后前面的动作可能已经改了目录拓扑
      // （例如把 root 内的 junction 挪走、再往它原来的位置写），只在批次开头查会漏。
      const decision = checkAction(action, opts.root, declared, manifest.capabilities);
      if (!decision.allowed) throw new PolicyError(decision.reasons);
      if (control.signal?.aborted) return cancelledBefore(action);
      phase = "exec";
      execResult = await execute(action, execCtx);
      phase = "post";
      for (const post of action.post ?? []) {
        if (!(await checkAssertion(post, execCtx))) {
          throw new Error(`后置断言失败：${JSON.stringify(post)}`);
        }
      }
      // 效果哈希：撤销时据此判断"目标位上还是不是我们留下的东西"，被别人改过就拒绝覆盖。
      // 执行器已经算过的（move 的源、delete 前的原件）直接用，fs.write 在这里补一次。
      const hash =
        execResult && "hash" in execResult && execResult.hash
          ? execResult.hash
          : action.kind === "fs.write" && fs.existsSync(action.path)
            ? createHash("sha256").update(fs.readFileSync(action.path)).digest("hex")
            : undefined;
      const entry: JournalEntry = {
        ts: Date.now(),
        taskId,
        skill: manifest.name,
        actionId: action.id,
        kind: action.kind,
        object: objectOf(action, opts.root),
        summary: describe(action),
        status: "ok",
        hash,
        undo: undoOf(action, index),
        ...(execResult && "createdDirs" in execResult && execResult.createdDirs?.length
          ? { createdDirs: execResult.createdDirs }
          : {}),
      };
      append(opts.journalPath, entry);
      done.push(entry);
      steps.push({ actionId: action.id, status: "ok" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const failedStep: StepResult = { actionId: action.id, status: "failed", detail };
      steps.push(failedStep);
      const rollbackFailures: string[] = [];

      // 先记录执行失败，避免恢复过程卡住或中断时丢失原始审计记录。
      append(opts.journalPath, {
        ts: Date.now(),
        taskId,
        skill: manifest.name,
        actionId: action.id,
        kind: action.kind,
        object: objectOf(action, opts.root),
        summary: describe(action),
        status: "failed",
        detail,
        undo: undoOf(action, index),
      });

      if (control.rollbackOnFailure === false) {
        return { mode: "apply", taskId, steps, journal: done, rolledBack: 0 };
      }

      // 关键：失败的动作本身可能已经产生了副作用（比如写完文件才断言失败），
      // 必须先撤掉它自己的改动，再按 LIFO 回滚之前成功的步骤。
      let selfUndone = 0;
      // 前置条件失败意味着"一行都没执行"，此时自撤反而会破坏现场：
      // move 的 undo 是 move(to→from)，会把本来就在 to 上的文件搬走甚至覆盖 from。
      const undo = undoOf(action, index);
      if (undo && phase !== "pre" && selfUndoSafe(undo)) {
        try {
          await applyUndo(undo, execCtx, {
            createdDirs: execResult && "createdDirs" in execResult ? execResult.createdDirs : undefined,
            expectedHash: execResult && "hash" in execResult ? execResult.hash : undefined,
          });
          selfUndone = 1;
        } catch (undoError) {
          rollbackFailures.push(`自撤失败 ${action.id}：${undoError instanceof Error ? undoError.message : String(undoError)}`);
        }
      } else if (!undo && phase !== "pre") {
        rollbackFailures.push(`动作 ${action.id} 不可撤销：未记录撤销动作`);
      }

      const rolled = new Set<string>();
      for (const e of [...done].reverse()) {
        try {
          await undoEntry(e, execCtx);
          e.status = "rolled-back";
          rolled.add(`${e.taskId}:${e.actionId}`);
        } catch (undoError) {
          const undoDetail = `回滚失败 ${e.actionId}：${undoError instanceof Error ? undoError.message : String(undoError)}`;
          rollbackFailures.push(undoDetail);
          const step = steps.find((s) => s.actionId === e.actionId);
          if (step) {
            step.status = "failed";
            step.detail = undoDetail;
          }
        }
      }

      // 报告中说明恢复失败；日志中未撤销的成功动作仍保留 ok，方便重试。
      failedStep.detail = [detail, ...rollbackFailures].join("；");
      // 账本自己出问题时不能把原始失败顶掉：调用方至少要拿到"哪一步失败、回了多少"。
      try {
        markRolledBack(
          opts.journalPath,
          load(opts.journalPath).map((e) =>
            rolled.has(`${e.taskId}:${e.actionId}`) ? { ...e, status: "rolled-back" as const } : e,
          ),
        );
      } catch (journalError) {
        failedStep.detail = [
          failedStep.detail,
          `审计日志回写失败：${journalError instanceof Error ? journalError.message : String(journalError)}`,
        ].join("；");
      }
      return { mode: "apply", taskId, steps, journal: done, rolledBack: rolled.size + selfUndone };
    }
    // 宿主观察刷新失败意味着宿主状态待核查；不能因此重复记录或撤销已记账的效果。
    if (control.afterAction) await control.afterAction(structuredClone(action), index);
  }

  return { mode: "apply", taskId, steps, journal: done, rolledBack: 0 };
}


/** 自撤前确认"这个动作确实生效了"，避免 undo 作用在别人的数据上 */
function selfUndoSafe(undo: UndoAction): boolean {
  switch (undo.kind) {
    case "fs.move":
      return fs.existsSync(undo.from) && !fs.existsSync(undo.to);
    case "fs.rmdir":
      return fs.existsSync(undo.path);
    case "fs.restore":
      // 删除成功后目标位本来就不存在 —— 旧逻辑在这里返回 false，于是"删掉文件再断言失败"
      // 永远不自撤，文件悄无声息地消失。归属判断交给 applyUndo 的指纹闸。
      return true;
    case "window.move":
    case "noop":
      return true;
    default:
      return true;
  }
}

async function undoEntry(entry: JournalEntry & { createdDirs?: string[] }, ctx: ExecContext): Promise<void> {
  if (!entry.undo) throw new Error(`动作 ${entry.actionId} 不可撤销：未记录撤销动作`);
  await applyUndo(entry.undo, ctx, { expectedHash: entry.hash, createdDirs: entry.createdDirs });
}

async function undoLastTask(opts: RunOptions, ctx: SkillContext): Promise<RunReport> {
  const entries = load(opts.journalPath).filter((e) => e.status === "ok");
  if (entries.length === 0) return { mode: "undo", steps: [], journal: [], rolledBack: 0 };
  const lastTask = entries[entries.length - 1].taskId;
  const target = entries.filter((e) => e.taskId === lastTask);
  const steps: StepResult[] = [];
  const rolled = new Set<string>();
  const execCtx = { ...ctx, root: opts.root };

  for (const e of [...target].reverse()) {
    try {
      await undoEntry(e, execCtx);
      rolled.add(`${e.taskId}:${e.actionId}`);
      e.status = "rolled-back";
      steps.push({ actionId: e.actionId, status: "ok", detail: `撤销 ${e.summary}` });
    } catch (err) {
      // 撤销失败时不能把这条标成 rolled-back，否则日志会撒谎
      steps.push({
        actionId: e.actionId,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  markRolledBack(
    opts.journalPath,
    load(opts.journalPath).map((e) =>
      rolled.has(`${e.taskId}:${e.actionId}`) ? { ...e, status: "rolled-back" as const } : e,
    ),
  );
  return { mode: "undo", taskId: lastTask, steps, journal: target, rolledBack: rolled.size };
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
      await undoEntry(e, execCtx);
      e.status = "rolled-back";
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
      await undoEntry(e, execCtx);
      e.status = "rolled-back";
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
