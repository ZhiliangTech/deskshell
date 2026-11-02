import fs from "node:fs";
import path from "node:path";
import type {
  Action,
  Assertion,
  CapabilityId,
  CapabilityRequest,
  Risk,
  UndoAction,
} from "./types.ts";

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** 权限检查：skill 声明的能力必须被用户授予，且 fs 类能力要落在 root 之内 */
export function checkCapabilities(
  caps: CapabilityRequest[],
  granted: CapabilityId[],
  root: string,
): PolicyDecision {
  const reasons: string[] = [];
  for (const cap of caps) {
    if (!granted.includes(cap.id)) {
      reasons.push(`未授予能力 ${cap.id}（${cap.reason}）`);
    }
    const scope = cap.scope?.replace("{{root}}", root);
    if (scope && cap.id.startsWith("fs.") && !isInside(root, scope)) {
      reasons.push(`能力 ${cap.id} 的作用域 ${scope} 超出 root`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Windows 设备命名空间前缀（`\\?\` / `\\.\`）与 NUL 不是正常路径：
 * 它们能绕过字符串化比较，只应该被拒绝，不该被"解析后放行"。
 */
const DEVICE_PREFIX = /^\\\\(?:\?|\.)\\/;

function isDevicePath(p: string): boolean {
  return typeof p !== "string" || p.includes("\0") || DEVICE_PREFIX.test(p);
}

/** realpath 在长路径上会返回 `\\?\C:\…`，比较前先还原成普通形态 */
function stripDevicePrefix(p: string): string {
  if (p.startsWith("\\\\?\\")) {
    const rest = p.slice(4);
    return rest.startsWith("UNC\\") ? `\\\\${rest.slice(4)}` : rest;
  }
  if (p.startsWith("\\\\.\\")) return p.slice(4);
  return p;
}

/** 解析真实路径；不存在时沿最近的存在祖先解析，避免"目标还不存在"就跳过检查 */
function realOrSelf(p: string): string {
  try {
    return stripDevicePrefix(fs.realpathSync.native(p));
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realOrSelf(parent), path.basename(p));
  }
}

/**
 * 符号链接逃逸检查。
 * - followFinal=false：只看父目录真实路径（用于 move 的源，避免"搬走一个快捷方式"被误拒）
 * - followFinal=true ：目标自身存在时解析它（防止写到 root 内一个指向外部的软链接）
 */
export function isInsideReal(root: string, target: string, followFinal = true): boolean {
  if (isDevicePath(target) || isDevicePath(root)) return false;
  const realRoot = realOrSelf(root);
  if (followFinal && fs.existsSync(target)) {
    return isInside(realRoot, realOrSelf(target));
  }
  return isInside(realRoot, realOrSelf(path.dirname(target)));
}

/** 动作／撤销动作真正碰到的路径。撤销那一半过去从来没被检查过。 */
function undoPaths(undo: UndoAction): Array<{ path: string; followFinal: boolean }> {
  switch (undo.kind) {
    case "fs.move":
      return [
        { path: undo.from, followFinal: false },
        { path: undo.to, followFinal: true },
      ];
    case "fs.rmdir":
    case "fs.restore":
      return [{ path: undo.path, followFinal: true }];
    default:
      return [];
  }
}

function assertionPaths(assertion: Assertion): string[] {
  switch (assertion.kind) {
    case "path.exists":
    case "path.absent":
      return [assertion.path];
    case "file.count":
      return [assertion.dir];
    default:
      return [];
  }
}

function pathProblems(
  root: string,
  target: string,
  opts: { followFinal: boolean; label: string; resolveLinks?: boolean },
): string[] {
  if (isDevicePath(target)) return [`${opts.label}无效（设备命名空间或 NUL）：${target}`];
  if (!isInside(root, target)) return [`${opts.label}越界：${target}`];
  if (opts.resolveLinks !== false && !isInsideReal(root, target, opts.followFinal)) {
    return [`${opts.label}经符号链接逃逸：${target}`];
  }
  const base = path.basename(target);
  if (/[ .]$/.test(base) && base !== "." && base !== "..") {
    return [`${opts.label}以点或空格结尾，不同工具会解析成不同文件名：${target}`];
  }
  return [];
}

/**
 * 撤销动作的路径必须和动作路径受同一套约束（导出给执行层做第二道检查）。
 *
 * 计划阶段的 `resolveLinks: false`：这一批动作自己就可能把 junction 挪走/建出来，
 * 拿"检查这一刻的拓扑"去否定一个合法的撤销计划会误伤；真正执行撤销时（applyUndo）
 * 用默认值再解析一次真实路径。
 */
export function checkUndo(
  undo: UndoAction | null | undefined,
  root: string,
  opts: { resolveLinks?: boolean } = {},
): string[] {
  if (!undo) return [];
  return undoPaths(undo).flatMap((entry) =>
    pathProblems(root, entry.path, {
      followFinal: entry.followFinal,
      label: "撤销路径",
      resolveLinks: opts.resolveLinks,
    }),
  );
}

/**
 * 撤销动作是不是"占位"（没有真实还原语义）。
 *
 * 只认字面量 `noop` 是不够的：`{kind:"NoOp"}`、`{}`、`{kind:0}`、`{kind:"bogus"}`
 * 都曾绕过"硬删必须可还原"的闸门（未知 kind 在执行层的 switch 里直接落空，
 * 于是撤销"成功"了但文件早就没了）。现在的规则：
 *   1. undo 缺失、kind 不是已知白名单 → 占位；
 *   2. 文件变更上写 `noop` → 占位（UI 动作的 noop 仍保留兼容）；
 *   3. 声称能还原、但形状对不上（delete 用 fs.rmdir、delete 的 restore 没有正文、
 *      write 覆盖已有文件却只给 content:null）→ 一样算占位。
 */
const DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set(["fs.delete", "fs.move", "fs.write"]);

const UNDO_KINDS: ReadonlySet<string> = new Set([
  "fs.move",
  "fs.rmdir",
  "fs.restore",
  "ui.value",
  "window.move",
  "noop",
]);

export function undoIsPlaceholder(action: Action): boolean {
  const undo = action.undo;
  if (!undo) return true;
  const kind = (undo as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !UNDO_KINDS.has(kind)) return true;
  if (kind === "noop") return DESTRUCTIVE_KINDS.has(action.kind);
  return !undoRestoresEffect(action, undo);
}

/** undo 是否真的能撤回这个动作的效果；证明不了的一律按不可逆处理 */
function undoRestoresEffect(action: Action, undo: UndoAction): boolean {
  switch (action.kind) {
    case "fs.delete": {
      // 删除只能靠"带原文的 restore"还原；目录树 restore 不回来
      if (undo.kind !== "fs.restore" || undo.path !== action.path) return false;
      if (typeof undo.content !== "string") return false;
      try {
        return !fs.existsSync(action.path) || fs.lstatSync(action.path).isFile();
      } catch {
        return false;
      }
    }
    case "fs.move":
      return undo.kind === "fs.move" && undo.from === action.to && undo.to === action.from;
    case "fs.write": {
      if (undo.kind !== "fs.restore" || undo.path !== action.path) return false;
      // content 有正文 = 能还原原内容；content:null 只能还原"写之前不存在"的文件，
      // 覆盖已有文件时那是删除，会让用户原来的内容消失。
      return typeof undo.content === "string" || !fs.existsSync(action.path);
    }
    case "fs.mkdir":
      return undo.kind === "fs.rmdir" && undo.path === action.path;
    default:
      // ui.* / window.move：能不能撤由驱动能力判断，这里不做猜测
      return true;
  }
}

/** 动作 → 必需能力：skill 声明的能力必须覆盖它产出的动作 */
export const ACTION_CAPABILITY: Record<string, CapabilityId> = {
  "fs.mkdir": "fs.write",
  "fs.move": "fs.write",
  "fs.delete": "fs.write",
  "fs.write": "fs.write",
  "ui.invoke": "ui.input",
  "ui.click": "ui.input",
  "ui.type": "ui.input",
  "window.move": "ui.input",
};

/** 窗口匹配：作用域写成正则就按正则，否则按子串（大小写不敏感） */
function windowMatches(window: string, scope: string): boolean {
  try {
    return new RegExp(scope, "i").test(window);
  } catch {
    return window.toLowerCase().includes(scope.toLowerCase());
  }
}

function isRootItself(root: string, target: string): boolean {
  return path.relative(path.resolve(root), path.resolve(target)) === "";
}

/** 动作检查：未知类型、路径逃逸、根自身、硬链接、不可撤销、越权、窗口越界 */
export function checkAction(
  action: Action,
  root: string,
  declared: CapabilityId[] = [],
  caps: CapabilityRequest[] = [],
): PolicyDecision {
  const reasons: string[] = [];
  const touched: string[] = [];
  const sources: string[] = [];

  const known = Object.hasOwn(ACTION_CAPABILITY, action.kind);
  if (!known) reasons.push(`未知动作类型：${String((action as { kind?: unknown }).kind)}`);

  switch (action.kind) {
    case "fs.move":
      sources.push(action.from);
      touched.push(action.to);
      break;
    case "fs.mkdir":
    case "fs.delete":
    case "fs.write":
      touched.push(action.path);
      break;
    default: {
      // ui.* 不涉及文件路径，但要检查窗口是否落在声明的能力作用域内
      const window = (action as { window?: string }).window;
      const uiScopes = caps.filter((c) => c.id.startsWith("ui.") && c.scope).map((c) => c.scope!);
      if (window && uiScopes.length > 0 && !uiScopes.some((sc) => windowMatches(window, sc))) {
        reasons.push(`窗口 "${window}" 不在声明的能力作用域内（${uiScopes.join(" / ")}）`);
      }
      break;
    }
  }

  for (const p of sources) {
    if (isRootItself(root, p)) reasons.push(`拒绝作用于任务根自身：${p}`);
    else reasons.push(...pathProblems(root, p, { followFinal: false, label: "路径" }));
  }
  for (const p of touched) {
    if (isRootItself(root, p)) reasons.push(`拒绝作用于任务根自身：${p}`);
    else reasons.push(...pathProblems(root, p, { followFinal: true, label: "路径" }));
  }

  // 写穿硬链接等于改 root 外那个文件：NTFS 硬链接不是 reparse point，双层路径检查都放行
  if (action.kind === "fs.write") {
    try {
      const stat = fs.lstatSync(action.path);
      if (stat.isFile() && stat.nlink > 1) {
        reasons.push(`写入目标有硬链接（nlink=${stat.nlink}），会改到 root 外的同一份内容：${action.path}`);
      }
    } catch {
      // 目标还不存在：正常的新建
    }
  }

  reasons.push(...checkUndo(action.undo, root, { resolveLinks: false }));

  for (const assertion of [...(action.pre ?? []), ...(action.post ?? [])]) {
    for (const p of assertionPaths(assertion)) {
      // 断言可以指向 root 本身（"这个目录里现在有几个文件"），它不是破坏性动作
      if (isRootItself(root, p)) continue;
      reasons.push(...pathProblems(root, p, { followFinal: false, label: "断言路径" }));
    }
  }

  if (action.kind === "fs.delete" && undoIsPlaceholder(action)) {
    reasons.push(`不可撤销的删除被拒绝：${action.path}`);
  }

  const need = ACTION_CAPABILITY[action.kind];
  if (need && !declared.includes(need)) {
    reasons.push(`动作 ${action.kind} 需要能力 ${need}，但 skill 未声明`);
  }

  return { allowed: reasons.length === 0, reasons };
}

export function maxRisk(actions: Action[]): Risk {
  let out: Risk = "low";
  for (const a of actions) {
    const r = a.risk ?? "low";
    if (RISK_ORDER[r] > RISK_ORDER[out]) out = r;
  }
  return out;
}

export function isInside(root: string, target: string): boolean {
  if (isDevicePath(root) || isDevicePath(target)) return false;
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
