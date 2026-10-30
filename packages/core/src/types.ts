/**
 * deskshell core protocol (v0)
 * 只有类型与常量：生态里的所有 skill / 驱动 / UI 都实现这套协议。
 */

export type CapabilityId =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "ui.read"
  | "ui.input"
  | "process.exec"
  | "net.http";

export interface CapabilityRequest {
  id: CapabilityId;
  /** 作用域：文件能力是路径根，UI 能力是应用标识 */
  scope?: string;
  /** 给用户看的授权理由，必须是人话 */
  reason: string;
}

export type Risk = "low" | "medium" | "high";

export type Assertion =
  | { kind: "path.exists"; path: string }
  | { kind: "path.absent"; path: string }
  | { kind: "file.count"; dir: string; equals: number }
  | { kind: "ui.value"; window: string; selector: UiSelector; equals: string }
  | { kind: "window.rect"; window: string; rect: Rect; tolerance?: number }
  | { kind: "window.exists"; window: string; timeoutMs?: number }
  | { kind: "ui.exists"; window: string; selector: UiSelector };

export type UndoAction =
  | { kind: "fs.move"; from: string; to: string }
  | { kind: "fs.rmdir"; path: string }
  | { kind: "fs.restore"; path: string; content: string | null }
  | { kind: "window.move"; window: string; rect: Rect }
  | { kind: "noop" };

interface ActionBase {
  id: string;
  risk?: Risk;
  pre?: Assertion[];
  post?: Assertion[];
  /** 撤销这一步的办法；null 表示不可撤销，内核会要求用户显式确认 */
  undo?: UndoAction | null;
}

export interface MkdirAction extends ActionBase {
  kind: "fs.mkdir";
  path: string;
}

export interface MoveAction extends ActionBase {
  kind: "fs.move";
  from: string;
  to: string;
}

export interface DeleteAction extends ActionBase {
  kind: "fs.delete";
  path: string;
}

export interface WriteAction extends ActionBase {
  kind: "fs.write";
  path: string;
  content: string;
}

export interface UiInvokeAction extends ActionBase {
  kind: "ui.invoke";
  window: string;
  selector: UiSelector;
}

export interface UiTypeAction extends ActionBase {
  kind: "ui.type";
  window: string;
  selector: UiSelector;
  text: string;
}

export interface UiClickAction extends ActionBase {
  kind: "ui.click";
  window: string;
  selector: UiSelector;
}

export interface WindowMoveAction extends ActionBase {
  kind: "window.move";
  window: string;
  rect: Rect;
}

export type Action =
  | MkdirAction
  | MoveAction
  | DeleteAction
  | WriteAction
  | UiInvokeAction
  | UiTypeAction
  | UiClickAction
  | WindowMoveAction;

export interface StepResult {
  actionId: string;
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

export interface JournalEntry {
  ts: number;
  taskId: string;
  /** 产出这条记录的 skill 名，便于 history 按 skill 归组 */
  skill?: string;
  actionId: string;
  kind: string;
  summary: string;
  status: "ok" | "rolled-back" | "failed";
  detail?: string;
  /** fs.write 成功后写入内容的 sha256，撤销前用来判断文件有没有被别人改过 */
  hash?: string;
  undo?: UndoAction;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  capabilities: CapabilityRequest[];
}

export interface SkillInput {
  root: string;
  [key: string]: unknown;
}

export interface WindowInfo {
  name: string;
  className: string;
  pid: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiNode {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  enabled: boolean;
  value: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  children: UiNode[];
  windowPid?: number;
}

export interface WindowRef {
  titleRegex?: string;
  pid?: number;
}

export interface UiSelector {
  automationId?: string;
  name?: string;
  controlType?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 驱动契约：内核只依赖这个接口，Windows/macOS/Linux 各实现一份 */
export interface UiDriver {
  windows(): Promise<WindowInfo[]>;
  tree(ref: WindowRef, depth?: number): Promise<UiNode>;
  invoke(ref: WindowRef, selector: UiSelector): Promise<void>;
  click(ref: WindowRef, selector: UiSelector): Promise<void>;
  type(ref: WindowRef, selector: UiSelector, text: string): Promise<void>;
  keys(ref: WindowRef, combo: string): Promise<void>;
  /** 可选能力：不是每个平台都支持窗口几何操作 */
  bounds?(ref: WindowRef): Promise<Rect>;
  moveWindow?(ref: WindowRef, rect: Rect): Promise<void>;
}

export interface SkillContext {
  driver?: UiDriver;
}

export interface ExecContext extends SkillContext {
  root: string;
}

export interface Skill {
  manifest: SkillManifest;
  plan(input: SkillInput, ctx: SkillContext): Promise<Action[]>;
}

export interface RunOptions {
  mode: "preview" | "apply" | "undo";
  root: string;
  granted: CapabilityId[];
  journalPath: string;
}

/** 预览汇总：不执行，只看这批动作会改动什么 */
export interface ActionSummary {
  total: number;
  mkdir: number;
  move: number;
  delete: number;
  write: number;
  ui: number;
  window: number;
  undoable: number;
  notUndoable: number;
  risk: { low: number; medium: number; high: number };
}

export interface RunReport {
  mode: RunOptions["mode"];
  /** 本次运行的任务 id：审计、撤销、对外展示都用它 */
  taskId?: string;
  steps: StepResult[];
  journal: JournalEntry[];
  rolledBack: number;
  /** 仅在 preview 模式下填充 */
  summary?: ActionSummary;
}
