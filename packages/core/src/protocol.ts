/**
 * 协议 v0 的运行时常量清单。
 *
 * 类型定义在 types.ts（编译期），这里给出运行时可断言的清单：
 * 冻结测试会把这些常量和 spec/protocol-v0.json 对齐，任何一边悄悄改都会失败。
 */
export const PROTOCOL_VERSION = "0";

export const ACTION_KINDS = [
  "fs.mkdir",
  "fs.move",
  "fs.delete",
  "fs.write",
  "ui.invoke",
  "ui.click",
  "ui.type",
  "window.move",
] as const;

export const ASSERTION_KINDS = [
  "path.exists",
  "path.absent",
  "file.count",
  "ui.value",
  "window.rect",
  "window.exists",
  "ui.exists",
] as const;

export const UNDO_KINDS = ["fs.move", "fs.rmdir", "fs.restore", "window.move", "noop"] as const;

export const CAPABILITY_IDS = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "ui.read",
  "ui.input",
  "process.exec",
  "net.http",
] as const;

/** 动作必填字段（不含 id / pre / post / undo 这些公共字段） */
export const ACTION_REQUIRED: Record<(typeof ACTION_KINDS)[number], string[]> = {
  "fs.mkdir": ["path"],
  "fs.move": ["from", "to"],
  "fs.delete": ["path"],
  "fs.write": ["path", "content"],
  "ui.invoke": ["window", "selector"],
  "ui.click": ["window", "selector"],
  "ui.type": ["window", "selector", "text"],
  "window.move": ["window", "rect"],
};

/** 不变式：写进 spec 的不只是类型，还有这些必须一直成立的性质 */
export const INVARIANTS = [
  "任何动作都不得逃出 task root（词法 + 真实路径双重检查）",
  "除显式确认外，每个动作都必须可撤销",
  "任何失败都必须把任务回滚到起始状态",
  "内核不得依赖任何模型",
  "每个动作都必须被 skill 声明的能力覆盖",
] as const;
