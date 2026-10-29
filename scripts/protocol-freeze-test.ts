import fs from "node:fs";
import path from "node:path";
import {
  ACTION_KINDS,
  ACTION_REQUIRED,
  ASSERTION_KINDS,
  CAPABILITY_IDS,
  INVARIANTS,
  PROTOCOL_VERSION,
  UNDO_KINDS,
} from "../packages/core/src/protocol.ts";
import { ACTION_CAPABILITY } from "../packages/core/src/policy.ts";
import { validateManifest } from "../packages/core/src/manifest.ts";

/**
 * 协议冻结测试：spec/protocol-v0.json 是契约，运行时常量是实现。
 * 两边任何一边偷偷改了，这里就红——包括"只加了一个 kind 却忘了升版本"。
 */
const specPath = path.resolve("spec/protocol-v0.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
  protocol: string;
  actionKinds: string[];
  actionRequired: Record<string, string[]>;
  actionCommon: string[];
  assertionKinds: string[];
  undoKinds: string[];
  capabilityIds: string[];
  journalFields: string[];
  journalStatus: string[];
  manifestRequired: string[];
  invariants: string[];
};

const checks: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};
const eq = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

check("协议版本一致", PROTOCOL_VERSION === spec.protocol, `${PROTOCOL_VERSION} vs ${spec.protocol}`);
check("动作种类与冻结清单一致", eq(ACTION_KINDS, spec.actionKinds), ACTION_KINDS.join(","));
check("断言种类与冻结清单一致", eq(ASSERTION_KINDS, spec.assertionKinds));
check("撤销种类与冻结清单一致", eq(UNDO_KINDS, spec.undoKinds));
check("能力清单与冻结清单一致", eq(CAPABILITY_IDS, spec.capabilityIds));

// 每个动作的必填字段
for (const kind of ACTION_KINDS) {
  const local = ACTION_REQUIRED[kind];
  const frozen = spec.actionRequired[kind];
  check(`${kind} 必填字段一致`, eq(local, frozen ?? []), `${local.join(",")} vs ${(frozen ?? []).join(",")}`);
}

// 每个动作都要有能力映射，且不能映射到不存在的能力
const mapKinds = Object.keys(ACTION_CAPABILITY).sort();
check("每个动作都有能力映射", eq(mapKinds, spec.actionKinds), mapKinds.join(","));
const badCaps = Object.entries(ACTION_CAPABILITY).filter(([, cap]) => !CAPABILITY_IDS.includes(cap));
check("能力映射没有未知能力", badCaps.length === 0, JSON.stringify(badCaps));

// 不变式必须一条不少
check("不变式清单未被删改", eq(INVARIANTS, spec.invariants), INVARIANTS.join(" / "));

// 清单校验：缺必填字段必须报错
for (const field of spec.manifestRequired) {
  const base: Record<string, unknown> = {
    name: "x",
    version: "0.1.0",
    description: "d",
    entry: "./index.ts",
    capabilities: [{ id: "fs.read", reason: "r" }],
  };
  delete base[field];
  const result = validateManifest(base);
  check(`manifest 缺 ${field} 被拒绝`, !result.ok);
}

// 协议版本字段语义：0 或缺失可用，其它拒绝或标记
const withProtocol = (p: string | undefined): Record<string, unknown> => ({
  name: "x",
  version: "0.1.0",
  description: "d",
  entry: "./index.ts",
  capabilities: [{ id: "fs.read", reason: "r" }],
  ...(p === undefined ? {} : { protocol: p }),
});
check("protocol 缺失视为 v0", validateManifest(withProtocol(undefined)).ok);
check("protocol=0 接受", validateManifest(withProtocol("0")).ok);
const wrong = validateManifest(withProtocol("1"));
check("protocol=1 被拒绝或标记", !wrong.ok || wrong.problems.some((p) => /protocol/i.test(p.field + p.message)));

console.log(checks.join("\n"));
console.log(`${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} passed`);
