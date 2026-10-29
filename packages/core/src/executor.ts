import fs from "node:fs";
import path from "node:path";
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

export async function execute(action: Action, ctx: ExecContext): Promise<void> {
  switch (action.kind) {
    case "fs.mkdir":
      fs.mkdirSync(action.path, { recursive: true });
      return;
    case "fs.move": {
      fs.mkdirSync(path.dirname(action.to), { recursive: true });
      if (fs.existsSync(action.to)) {
        throw new Error(`目标已存在，拒绝覆盖：${action.to}`);
      }
      fs.renameSync(action.from, action.to);
      return;
    }
    case "fs.delete":
      fs.rmSync(action.path, { recursive: true, force: true });
      return;
    case "fs.write": {
      fs.mkdirSync(path.dirname(action.path), { recursive: true });
      fs.writeFileSync(action.path, action.content, "utf8");
      return;
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
  }
}

export async function applyUndo(undo: UndoAction, ctx: ExecContext): Promise<void> {
  switch (undo.kind) {
    case "fs.move": {
      fs.mkdirSync(path.dirname(undo.to), { recursive: true });
      if (fs.existsSync(undo.to)) fs.rmSync(undo.to, { force: true });
      fs.renameSync(undo.from, undo.to);
      return;
    }
    case "fs.rmdir": {
      if (fs.existsSync(undo.path)) fs.rmdirSync(undo.path);
      return;
    }
    case "fs.restore": {
      if (undo.content === null) {
        if (fs.existsSync(undo.path)) fs.rmSync(undo.path, { force: true });
      } else {
        fs.mkdirSync(path.dirname(undo.path), { recursive: true });
        fs.writeFileSync(undo.path, undo.content, "utf8");
      }
      return;
    }
    case "window.move": {
      if (!ctx.driver?.moveWindow) throw new Error("当前驱动不支持窗口几何操作");
      await ctx.driver.moveWindow({ titleRegex: undo.window }, undo.rect);
      return;
    }
    case "noop":
      return;
  }
}
