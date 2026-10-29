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

/** 动作 → 必需能力：skill 声明的能力必须覆盖它产出的动作 */
const ACTION_CAPABILITY: Record<string, CapabilityId> = {
  "fs.mkdir": "fs.write",
  "fs.move": "fs.write",
  "fs.delete": "fs.write",
  "fs.write": "fs.write",
  "ui.invoke": "ui.input",
  "ui.click": "ui.input",
  "ui.type": "ui.input",
  "window.move": "ui.input",
};

/** 动作检查：路径逃逸、不可撤销的高危动作、越权动作直接拒绝 */
export function checkAction(
  action: Action,
  root: string,
  declared: CapabilityId[] = [],
): PolicyDecision {
  const reasons: string[] = [];
  const touched: string[] = [];

  switch (action.kind) {
    case "fs.move":
      touched.push(action.from, action.to);
      break;
    case "fs.mkdir":
    case "fs.delete":
    case "fs.write":
      touched.push(action.path);
      break;
    default:
      // ui.* 由驱动层负责作用域，这里不做路径校验
      break;
  }

  for (const p of touched) {
    if (!isInside(root, p)) reasons.push(`路径越界：${p}`);
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
