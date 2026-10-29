import fs from "node:fs";
import path from "node:path";
import type { Action, CapabilityId, CapabilityRequest, Risk } from "./types.ts";

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

/** 解析真实路径；不存在时沿最近的存在祖先解析，避免"目标还不存在"就跳过检查 */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
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
  const realRoot = realOrSelf(root);
  if (followFinal && fs.existsSync(target)) {
    return isInside(realRoot, realOrSelf(target));
  }
  return isInside(realRoot, realOrSelf(path.dirname(target)));
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

/** 动作检查：路径逃逸、不可撤销的高危动作、越权动作、窗口越界 */
export function checkAction(
  action: Action,
  root: string,
  declared: CapabilityId[] = [],
  caps: CapabilityRequest[] = [],
): PolicyDecision {
  const reasons: string[] = [];
  const touched: string[] = [];
  const sources: string[] = [];

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
    if (!isInside(root, p)) reasons.push(`路径越界：${p}`);
    else if (!isInsideReal(root, p, false)) reasons.push(`路径经符号链接逃逸：${p}`);
  }
  for (const p of touched) {
    if (!isInside(root, p)) {
      reasons.push(`路径越界：${p}`);
    } else if (!isInsideReal(root, p)) {
      reasons.push(`路径经符号链接逃逸：${p}`);
    }
  }
  if (action.kind === "fs.delete" && action.undo === null) {
    reasons.push(`不可撤销的删除被拒绝：${action.path}`);
  }

  const need = ACTION_CAPABILITY[action.kind];
  if (need && declared.length > 0 && !declared.includes(need)) {
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
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
