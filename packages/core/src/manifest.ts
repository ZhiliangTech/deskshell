import type { CapabilityId } from "./types.ts";

const CAPABILITIES: CapabilityId[] = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "ui.read",
  "ui.input",
  "process.exec",
  "net.http",
];

const PLATFORMS = ["win32", "darwin", "linux"] as const;

export interface ManifestProblem {
  field: string;
  message: string;
}

export interface ManifestCheck {
  ok: boolean;
  problems: ManifestProblem[];
}

/**
 * skill.json 的最小校验：不引第三方 schema 库，只守"内核真正依赖的字段"。
 * 编辑器侧的完整 schema 在 schema/skill.schema.json。
 */
export function validateManifest(raw: unknown): ManifestCheck {
  const problems: ManifestProblem[] = [];
  const m = raw as Record<string, unknown> | null;

  if (!m || typeof m !== "object") {
    return { ok: false, problems: [{ field: "/", message: "必须是对象" }] };
  }

  const str = (field: string): void => {
    if (typeof m[field] !== "string" || (m[field] as string).trim() === "") {
      problems.push({ field, message: "必须是非空字符串" });
    }
  };

  // 协议版本：缺省视为 v0；写了别的值就拒绝，避免"以为自己在跑 v1"
  if (m.protocol !== undefined) {
    if (typeof m.protocol !== "string") {
      problems.push({ field: "protocol", message: "必须是字符串" });
    } else if (m.protocol !== "0") {
      problems.push({ field: "protocol", message: `暂只支持协议 0，收到 ${m.protocol}` });
    }
  }

  str("name");
  str("version");
  str("description");
  str("entry");

  if (!Array.isArray(m.capabilities)) {
    problems.push({ field: "capabilities", message: "必须是数组" });
  } else {
    (m.capabilities as Array<Record<string, unknown>>).forEach((c, i) => {
      if (!c || typeof c !== "object") {
        problems.push({ field: `capabilities[${i}]`, message: "必须是对象" });
        return;
      }
      if (!CAPABILITIES.includes(c.id as CapabilityId)) {
        problems.push({ field: `capabilities[${i}].id`, message: `未知能力：${String(c.id)}` });
      }
      if (typeof c.reason !== "string" || (c.reason as string).trim() === "") {
        problems.push({ field: `capabilities[${i}].reason`, message: "必须写人话理由" });
      }
      if (c.id && String(c.id).startsWith("fs.") && c.scope !== undefined && typeof c.scope !== "string") {
        problems.push({ field: `capabilities[${i}].scope`, message: "必须是字符串" });
      }
    });
  }

  if (m.platforms !== undefined) {
    if (!Array.isArray(m.platforms)) {
      problems.push({ field: "platforms", message: "必须是数组" });
    } else {
      (m.platforms as unknown[]).forEach((p, i) => {
        if (!PLATFORMS.includes(p as (typeof PLATFORMS)[number])) {
          problems.push({ field: `platforms[${i}]`, message: `未知平台：${String(p)}` });
        }
      });
    }
  }

  if (m.internal !== undefined && typeof m.internal !== "boolean") {
    problems.push({ field: "internal", message: "必须是布尔值" });
  }

  return { ok: problems.length === 0, problems };
}
