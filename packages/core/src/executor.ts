import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkUndo } from "./policy.ts";
import type {
  Action,
  Assertion,
  ExecContext,
  Rect,
  UiNode,
  UiSelector,
  UndoAction,
} from "./types.ts";

export function describe(action: Action): string {
  switch (action.kind) {
    case "fs.mkdir":
      return `mkdir ${action.path}`;
    case "fs.move":
      return `move ${path.basename(action.from)} → ${action.to}`;
    case "fs.delete":
      return `delete ${action.path}`;
    case "fs.write":
      return `write ${path.basename(action.path)} (${action.content.length} chars)`;
    case "ui.invoke":
      return `invoke ${action.window} :: ${label(action.selector)}`;
    case "ui.click":
      return `click ${action.window} :: ${label(action.selector)}`;
    case "ui.type":
      return `type into ${action.window} (${action.text.length} chars)`;
    case "window.move":
      return `move window ${action.window} → ${action.rect.x},${action.rect.y} ${action.rect.w}x${action.rect.h}`;
  }
}

function label(selector: UiSelector): string {
  return [selector.controlType, selector.name ?? selector.automationId ?? ""]
    .filter(Boolean)
    .join(" ");
}

export function matches(node: UiNode, selector: UiSelector): boolean {
  if (selector.automationId && node.automationId !== selector.automationId) return false;
  if (selector.name && node.name !== selector.name) return false;
  if (selector.controlType && node.controlType !== selector.controlType) return false;
  return true;
}

export function findNode(node: UiNode, selector: UiSelector): UiNode | undefined {
  if (matches(node, selector)) return node;
  for (const child of node.children) {
    const hit = findNode(child, selector);
    if (hit) return hit;
  }
  return undefined;
}

export async function checkAssertion(a: Assertion, ctx: ExecContext): Promise<boolean> {
  switch (a.kind) {
    case "path.exists":
      return fs.existsSync(a.path);
    case "path.absent":
      return !fs.existsSync(a.path);
    case "file.count": {
      if (!fs.existsSync(a.dir)) return false;
      const n = fs.readdirSync(a.dir, { withFileTypes: true }).filter((d) => d.isFile()).length;
      return n === a.equals;
    }
    case "ui.value": {
      if (!ctx.driver) return false;
      const tree = await ctx.driver.tree({ titleRegex: a.window }, 8);
      const node = findNode(tree, a.selector);
      return node?.value === a.equals;
    }
    case "window.rect": {
      if (!ctx.driver?.bounds) return false;
      const actual = await ctx.driver.bounds({ titleRegex: a.window });
      const tol = a.tolerance ?? 8;
      return (
        Math.abs(actual.x - a.rect.x) <= tol &&
        Math.abs(actual.y - a.rect.y) <= tol &&
        Math.abs(actual.w - a.rect.w) <= tol &&
        Math.abs(actual.h - a.rect.h) <= tol
      );
    }
    case "window.exists": {
      if (!ctx.driver) return false;
      const deadline = Date.now() + (a.timeoutMs ?? 0);
      const re = new RegExp(a.window, "i");
      for (;;) {
        const wins = await ctx.driver.windows();
        if (wins.some((w) => re.test(w.name))) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    case "ui.exists": {
      if (!ctx.driver) return false;
      const tree = await ctx.driver.tree({ titleRegex: a.window }, 8);
      return findNode(tree, a.selector) !== undefined;
    }
  }
}


/**
 * 列出"为了让 path 可写而不得不新建"的目录（由浅到深）。
 * 这些目录是这一步的副作用，撤销时要一并清掉，否则目录里会留下空壳。
 */
export function implicitDirs(target: string): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(target);
  while (!fs.existsSync(dir)) {
    dirs.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** 撤销时按"由深到浅"删掉空目录；非空就留着（里面有别人的东西） */
export function removeImplicitDirs(dirs: string[] | undefined): void {
  if (!dirs?.length) return;
  for (const dir of [...dirs].reverse()) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* 删不掉就算了，不能因为清理空目录而让撤销失败 */
    }
  }
}

export interface ExecResult {
  /** 这一步顺手新建的目录（撤销时删掉） */
  createdDirs?: string[];
  /** 这一步留下的内容指纹（撤销前用来判断目标位有没有被别人改过） */
  hash?: string;
}

/** 只对普通文件取指纹；目录、超大文件、读不了的文件都返回 undefined */
function fileHash(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return undefined;
    return sha256(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

export async function execute(action: Action, ctx: ExecContext): Promise<ExecResult | void> {
  switch (action.kind) {
    case "fs.mkdir": {
      const createdDirs = implicitDirs(action.path);
      fs.mkdirSync(action.path, { recursive: true });
      // 末尾那个目录由 fs.rmdir 的 undo 负责；父级是顺带建的，撤销时要一起清掉
      return { createdDirs };
    }
    case "fs.move": {
      const createdDirs = implicitDirs(action.to);
      // rename 之前取指纹：撤销时据此确认"目标位上还是我们搬过来的那一份"
      const hash = fileHash(action.from);
      fs.mkdirSync(path.dirname(action.to), { recursive: true });
      if (fs.existsSync(action.to)) {
        throw new Error(`目标已存在，拒绝覆盖：${action.to}`);
      }
      fs.renameSync(action.from, action.to);
      return { createdDirs, hash };
    }
    case "fs.delete": {
      // 删之前记下内容指纹：撤销（fs.restore）据此判断同名文件是不是我们删掉的那份
      const hash = fileHash(action.path);
      fs.rmSync(action.path, { recursive: true, force: true });
      return { hash };
    }
    case "fs.write": {
      const createdDirs = implicitDirs(action.path);
      fs.mkdirSync(path.dirname(action.path), { recursive: true });
      fs.writeFileSync(action.path, action.content, "utf8");
      return { createdDirs, hash: fileHash(action.path) };
    }
    case "ui.invoke": {
      if (!ctx.driver) throw new Error("ui.invoke 需要 UI 驱动");
      await ctx.driver.invoke({ titleRegex: action.window }, action.selector);
      return;
    }
    case "ui.click": {
      if (!ctx.driver) throw new Error("ui.click 需要 UI 驱动");
      await ctx.driver.click({ titleRegex: action.window }, action.selector);
      return;
    }
    case "ui.type": {
      if (!ctx.driver) throw new Error("ui.type 需要 UI 驱动");
      await ctx.driver.type({ titleRegex: action.window }, action.selector, action.text);
      return;
    }
    case "window.move": {
      if (!ctx.driver?.moveWindow) throw new Error("当前驱动不支持窗口几何操作");
      await ctx.driver.moveWindow({ titleRegex: action.window }, action.rect);
      return;
    }
    default:
      // 未知 kind 不执行，但也绝不能记一条"成功"：审计里那条 ok 是假的
      throw new Error(`未知动作类型，拒绝执行：${String((action as { kind?: unknown }).kind)}`);
  }
}

/** 撤销时的额外校验：文件被外部改过就拒绝覆盖，避免把别人刚写的内容冲掉 */
export interface UndoGuard {
  /** 任务写入时文件的 sha256 */
  expectedHash?: string;
  /** 执行那一步时顺手新建的目录，撤销后要删掉 */
  createdDirs?: string[];
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

export async function applyUndo(
  undo: UndoAction,
  ctx: ExecContext,
  guard: UndoGuard = {},
): Promise<void> {
  // 第二道闸：策略层已经查过动作自带的 undo，但这里还要挡住"日志里被写进来的"
  // 撤销动作（伪造的轮转文件、旧版日志、宿主自己拼的条目）。
  const problems = checkUndo(undo, ctx.root);
  if (problems.length > 0) throw new Error(problems.join("；"));

  switch (undo.kind) {
    case "fs.move": {
      fs.mkdirSync(path.dirname(undo.to), { recursive: true });
      if (fs.existsSync(undo.to)) {
        // 目标位还有东西：只有"还是我们搬过来的那一份"才能删，否则是别人的新文件。
        // 旧日志没有 hash，无法证明归属，宁可报告冲突也不静默覆盖。
        const current = fileHash(undo.to);
        if (!guard.expectedHash || current !== guard.expectedHash) {
          throw new Error(
            `撤销目标位已有别的文件，拒绝覆盖：${undo.to}（任务记录里的内容指纹与实际不符）`,
          );
        }
        fs.rmSync(undo.to, { force: true });
      }
      fs.renameSync(undo.from, undo.to);
      removeImplicitDirs(guard.createdDirs);
      return;
    }
    case "fs.rmdir": {
      if (fs.existsSync(undo.path)) fs.rmdirSync(undo.path);
      removeImplicitDirs(guard.createdDirs);
      return;
    }
    case "fs.restore": {
      const exists = fs.existsSync(undo.path);
      if (exists) {
        // 目标位已经有文件：只有"还是我们留下的那一份"才能动，否则是别人的新内容。
        // 没有指纹（旧日志、超过 64 MiB、读不回来）就证明不了归属，宁可报冲突。
        const current = fileHash(undo.path);
        if (!guard.expectedHash || current !== guard.expectedHash) {
          throw new Error(
            `文件在任务之后被修改或无法证明归属，拒绝覆盖：${undo.path}（任务记录里的内容指纹与实际不符）`,
          );
        }
      }
      if (undo.content === null) {
        if (exists) fs.rmSync(undo.path, { force: true });
      } else {
        fs.mkdirSync(path.dirname(undo.path), { recursive: true });
        fs.writeFileSync(undo.path, undo.content, "utf8");
      }
      removeImplicitDirs(guard.createdDirs);
      return;
    }
    case "window.move": {
      if (!ctx.driver?.moveWindow) throw new Error("当前驱动不支持窗口几何操作");
      await ctx.driver.moveWindow({ titleRegex: undo.window }, undo.rect);
      return;
    }
    case "ui.value": {
      if (!ctx.driver?.setValue) {
        throw new Error(
          "当前驱动不支持 setValue，无法撤销 ui.type：这个动作在没有 setValue 的平台上不可撤销",
        );
      }
      await ctx.driver.setValue({ titleRegex: undo.window }, undo.selector, undo.value);
      return;
    }
    case "noop":
      return;
    default:
      // 以前这里没有 default：未知 kind 静默 return，撤销"成功"、文件却早没了
      throw new Error(`未知撤销类型，拒绝当作已撤销：${String((undo as { kind?: unknown }).kind)}`);
  }
}
