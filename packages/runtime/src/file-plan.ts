import { createHash } from "node:crypto";
import fs from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import type { Action, Assertion } from "../../core/src/types.ts";

export interface TreeLimits {
  maxNodes: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_TREE_LIMITS: Readonly<TreeLimits> = Object.freeze({
  maxNodes: 2_000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
});

export interface TreeNode {
  /** Relative path, with / separators; the root directory has path "". */
  path: string;
  kind: "file" | "directory";
  ino: string;
  dev: string;
  size?: number;
  hash?: string;
  mtimeNs?: string;
}

export interface TreeSnapshot {
  root: string;
  digest: string;
  /** Paths, kinds and file bytes only; identities remain in digest/nodes. */
  semanticDigest: string;
  nodes: TreeNode[];
  limits: TreeLimits;
}

export type JSONSnapshot = TreeSnapshot;

export interface PredictedNode {
  path: string;
  kind: "file" | "directory";
  size?: number;
  hash?: string;
  /** Present for an existing object, including a file moved by this plan. */
  identity?: { ino: string; dev: string; mtimeNs?: string };
}

export interface FilePlanPrediction {
  semanticDigest: string;
  nodes: PredictedNode[];
}

export class FilePlanError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "FilePlanError";
    this.code = code;
  }
}

const fail = (code: string, message: string): never => { throw new FilePlanError(code, message); };
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const order = <T extends { path: string }>(nodes: T[]): T[] => nodes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const key = (relative: string): string => process.platform === "win32" ? relative.toLowerCase() : relative;
const samePath = (a: string, b: string): boolean => key(path.resolve(a)) === key(path.resolve(b));

function record(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_FILE_PLAN", `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_FILE_PLAN", `${label} must contain plain data`);
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string" || !allowed.includes(name)) fail("INVALID_FILE_PLAN", `${label} has an unsupported property`);
    if (!("value" in Object.getOwnPropertyDescriptor(value, name)!)) fail("INVALID_FILE_PLAN", `${label} cannot contain accessors`);
  }
  return value as Record<string, unknown>;
}

function limitsOf(input: Partial<TreeLimits> = {}): TreeLimits {
  record(input, ["maxNodes", "maxTotalBytes", "maxFileBytes"], "limits");
  const limits = { ...DEFAULT_TREE_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_SNAPSHOT_LIMIT", `${name} must be a positive safe integer`);
  }
  return limits;
}

function checkedStat(file: string): BigIntStats {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink()) fail("UNSUPPORTED_FILE_TREE", `symbolic links and junctions are not supported: ${file}`);
  if (!stat.isDirectory() && !stat.isFile()) fail("UNSUPPORTED_FILE_TREE", `not an ordinary file or directory: ${file}`);
  if (stat.isFile() && stat.nlink !== 1n) fail("UNSUPPORTED_FILE_TREE", `hard-linked files are not supported: ${file}`);
  return stat;
}

function rootOf(root: string): string {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")) fail("INVALID_ROOT", "root must be an absolute directory path");
  if (process.platform === "win32" && /^\\\\[?.]\\/.test(root)) fail("INVALID_ROOT", "Windows device namespace paths are not supported");
  const absolute = path.resolve(root);
  // Reject a link in any ancestor as well as a linked root itself.
  for (let current = absolute; ; current = path.dirname(current)) {
    const stat = checkedStat(current);
    if (!stat.isDirectory()) fail("INVALID_ROOT", `root ancestry is not a directory: ${current}`);
    if (path.dirname(current) === current) break;
  }
  const real = fs.realpathSync.native(absolute);
  if (!samePath(absolute, real)) fail("INVALID_ROOT", "root must resolve to its own real directory");
  return real;
}

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function unchangedStat(before: BigIntStats, after: BigIntStats, file: string): void {
  if (identity(before) !== identity(after) || before.mode !== after.mode || before.nlink !== after.nlink
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    fail("UNSTABLE_FILE_TREE", `object changed during scan: ${file}`);
  }
}

function semanticDigest(nodes: readonly (TreeNode | PredictedNode)[]): string {
  return hash(JSON.stringify(order(nodes.map((node) => node.kind === "file"
    ? { path: node.path, kind: node.kind, size: node.size, hash: node.hash }
    : { path: node.path, kind: node.kind }))));
}

function snapshotDigest(root: string, nodes: readonly TreeNode[], limits: TreeLimits): string {
  const normalized = order(nodes.map((node) => node.kind === "file"
    ? { path: node.path, kind: node.kind, ino: node.ino, dev: node.dev, size: node.size, hash: node.hash, mtimeNs: node.mtimeNs }
    : { path: node.path, kind: node.kind, ino: node.ino, dev: node.dev }));
  return hash(JSON.stringify({ root, limits: { maxNodes: limits.maxNodes, maxTotalBytes: limits.maxTotalBytes, maxFileBytes: limits.maxFileBytes }, nodes: normalized }));
}

/** Complete bounded scan. Exceeding a limit or encountering a changing/unsupported entry fails closed. */
export function captureTree(root: string, requestedLimits: Partial<TreeLimits> = {}): TreeSnapshot {
  const canonicalRoot = rootOf(root);
  const limits = limitsOf(requestedLimits);
  const rootStat = checkedStat(canonicalRoot);
  const nodes: TreeNode[] = [];
  const seen = new Set<string>();
  const scannedStats = new Map<string, BigIntStats>();
  let totalBytes = 0;

  const walk = (absolute: string, relative: string): void => {
    const stat = checkedStat(absolute);
    if (stat.dev !== rootStat.dev) fail("UNSUPPORTED_FILE_TREE", `cross-device entry: ${absolute}`);
    if (seen.has(key(relative))) fail("UNSUPPORTED_FILE_TREE", `ambiguous path: ${relative}`);
    seen.add(key(relative));
    if (seen.size > limits.maxNodes) fail("SNAPSHOT_LIMIT", `more than ${limits.maxNodes} nodes`);
    scannedStats.set(relative, stat);

    if (stat.isDirectory()) {
      nodes.push({ path: relative, kind: "directory", ino: String(stat.ino), dev: String(stat.dev) });
      const names = fs.readdirSync(absolute).sort();
      for (const name of names) walk(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      const afterNames = fs.readdirSync(absolute).sort();
      if (JSON.stringify(names) !== JSON.stringify(afterNames)) fail("UNSTABLE_FILE_TREE", `directory entries changed: ${absolute}`);
      unchangedStat(stat, checkedStat(absolute), absolute);
      return;
    }

    if (stat.size > BigInt(limits.maxFileBytes)) fail("SNAPSHOT_LIMIT", `file exceeds ${limits.maxFileBytes} bytes: ${relative}`);
    const size = Number(stat.size);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) fail("SNAPSHOT_LIMIT", `tree exceeds ${limits.maxTotalBytes} bytes`);
    const fd = fs.openSync(absolute, "r");
    let content: Buffer;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) fail("UNSUPPORTED_FILE_TREE", `file changed type or link count: ${absolute}`);
      unchangedStat(stat, opened, absolute);
      content = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = fs.readSync(fd, content, offset, size - offset, offset);
        if (!read) fail("UNSTABLE_FILE_TREE", `file shrank during scan: ${absolute}`);
        offset += read;
      }
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) fail("UNSTABLE_FILE_TREE", `file grew during scan: ${absolute}`);
      unchangedStat(stat, fs.fstatSync(fd, { bigint: true }), absolute);
      unchangedStat(stat, checkedStat(absolute), absolute);
    } finally {
      fs.closeSync(fd);
    }
    nodes.push({ path: relative, kind: "file", ino: String(stat.ino), dev: String(stat.dev), size, hash: hash(content!), mtimeNs: String(stat.mtimeNs) });
  };

  walk(canonicalRoot, "");
  // An object already scanned must not have changed while another subtree was read.
  for (const node of nodes) {
    const stat = checkedStat(path.join(canonicalRoot, node.path));
    // Directory times are scan-stability checks only; they are deliberately not
    // part of the durable digest, which models directory identity and children.
    unchangedStat(scannedStats.get(node.path)!, stat, path.join(canonicalRoot, node.path));
  }
  order(nodes);
  return { root: canonicalRoot, digest: snapshotDigest(canonicalRoot, nodes, limits), semanticDigest: semanticDigest(nodes), nodes, limits };
}

function checkSnapshot(root: string, snapshot: TreeSnapshot): string {
  const canonicalRoot = rootOf(root);
  if (!snapshot || !samePath(canonicalRoot, snapshot.root) || !Array.isArray(snapshot.nodes)) fail("INVALID_SNAPSHOT", "snapshot belongs to another root");
  const limits = limitsOf(snapshot.limits);
  if (snapshot.digest !== snapshotDigest(snapshot.root, snapshot.nodes, limits)
      || snapshot.semanticDigest !== semanticDigest(snapshot.nodes)) fail("INVALID_SNAPSHOT", "snapshot digest does not match its data");
  const rootNode = snapshot.nodes.find((node) => node.path === "");
  if (!rootNode || rootNode.kind !== "directory") fail("INVALID_SNAPSHOT", "snapshot has no root directory");
  return canonicalRoot;
}

export function assertUnchanged(root: string, snapshot: TreeSnapshot): TreeSnapshot {
  checkSnapshot(root, snapshot);
  const current = captureTree(root, snapshot.limits);
  if (current.digest !== snapshot.digest) fail("STALE_PLAN", "the task root changed after preparation");
  return current;
}

function relativePath(root: string, value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) fail("INVALID_FILE_PLAN", "every resource path must be absolute");
  if (process.platform === "win32" && /^\\\\[?.]\\/.test(value)) fail("INVALID_FILE_PLAN", "Windows device namespace paths are not supported");
  const relative = path.relative(root, path.resolve(value));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) fail("PATH_OUTSIDE_ROOT", value);
  const parts = relative ? relative.split(path.sep) : [];
  if (process.platform === "win32" && parts.some((part) => /[:<>"|?*]/.test(part) || /[ .]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    fail("INVALID_FILE_PLAN", `ambiguous Windows path: ${value}`);
  }
  return parts.join("/");
}

function assertions(value: unknown, root: string, label: string): Assertion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_FILE_PLAN", `${label} must be an array`);
  return value.map((item) => {
    const a = record(item, ["kind", "path", "dir", "equals"], label);
    if (a.kind === "path.exists" || a.kind === "path.absent") {
      record(a, ["kind", "path"], label);
      return { kind: a.kind, path: path.join(root, relativePath(root, a.path)) };
    }
    if (a.kind === "file.count") {
      record(a, ["kind", "dir", "equals"], label);
      if (!Number.isSafeInteger(a.equals) || (a.equals as number) < 0) fail("INVALID_FILE_PLAN", `${label} count must be a nonnegative integer`);
      return { kind: "file.count", dir: path.join(root, relativePath(root, a.dir)), equals: a.equals as number };
    }
    return fail("INVALID_FILE_PLAN", `${label} supports only file assertions`);
  });
}

/** Validate even discarded skill-provided undo data so an out-of-scope request is never silently accepted. */
function checkProvidedUndo(value: unknown, root: string): void {
  if (value === undefined || value === null) return;
  const undo = record(value, ["kind", "path", "from", "to", "content"], "undo");
  if (undo.kind === "fs.move") {
    record(undo, ["kind", "from", "to"], "undo");
    relativePath(root, undo.from);
    relativePath(root, undo.to);
  } else if (undo.kind === "fs.rmdir" || undo.kind === "fs.restore") {
    record(undo, undo.kind === "fs.rmdir" ? ["kind", "path"] : ["kind", "path", "content"], "undo");
    relativePath(root, undo.path);
    if (undo.kind === "fs.restore" && undo.content !== null && typeof undo.content !== "string") fail("INVALID_FILE_PLAN", "undo content must be text or null");
  } else if (undo.kind === "noop") {
    record(undo, ["kind"], "undo");
  } else fail("INVALID_FILE_PLAN", "unsupported undo kind");
}

function simulate(actions: readonly Action[], root: string, snapshot: TreeSnapshot): { actions: Action[]; prediction: FilePlanPrediction } {
  const canonicalRoot = checkSnapshot(root, snapshot);
  if (!Array.isArray(actions) || actions.length > snapshot.limits.maxNodes) fail("INVALID_FILE_PLAN", "invalid or oversized action list");
  const state = new Map<string, PredictedNode>(snapshot.nodes.map((node) => [key(node.path), {
    path: node.path, kind: node.kind,
    ...(node.kind === "file" ? { size: node.size, hash: node.hash } : {}),
    identity: { ino: node.ino, dev: node.dev, ...(node.kind === "file" ? { mtimeNs: node.mtimeNs } : {}) },
  }]));
  const ids = new Set<string>();
  const compiled: Action[] = [];
  let totalBytes = snapshot.nodes.reduce((sum, node) => sum + (node.size ?? 0), 0);
  const full = (relative: string): string => path.join(canonicalRoot, relative);
  const newTarget = (value: unknown): string => {
    const relative = relativePath(canonicalRoot, value);
    if (!relative || state.has(key(relative))) fail("FILE_PLAN_CONFLICT", `target already exists: ${String(value)}`);
    const parentRelative = path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative);
    const parent = state.get(key(parentRelative));
    if (!parent || parent.kind !== "directory") fail("FILE_PLAN_CONFLICT", `parent directory must already exist: ${String(value)}`);
    return parent.path ? `${parent.path}/${path.posix.basename(relative)}` : path.posix.basename(relative);
  };

  for (const value of actions) {
    const action = record(value, ["id", "kind", "risk", "pre", "post", "undo", "path", "from", "to", "content"], "action");
    if (typeof action.id !== "string" || !action.id.trim() || ids.has(action.id)) fail("INVALID_FILE_PLAN", "action IDs must be nonempty and unique");
    ids.add(action.id);
    if (action.risk !== undefined && !["low", "medium", "high"].includes(action.risk as string)) fail("INVALID_FILE_PLAN", "unsupported risk");
    const common = ["id", "kind", "risk", "pre", "post", "undo"];
    const extraPre = assertions(action.pre, canonicalRoot, "pre");
    const extraPost = assertions(action.post, canonicalRoot, "post");
    checkProvidedUndo(action.undo, canonicalRoot);
    const base = { id: action.id, ...(action.risk === undefined ? {} : { risk: action.risk as "low" | "medium" | "high" }) };

    if (action.kind === "fs.mkdir") {
      record(action, [...common, "path"], "mkdir");
      const target = newTarget(action.path);
      compiled.push({ ...base, kind: "fs.mkdir", path: full(target),
        pre: [{ kind: "path.absent", path: full(target) }, { kind: "path.exists", path: path.dirname(full(target)) }, ...extraPre],
        post: [{ kind: "path.exists", path: full(target) }, ...extraPost],
        undo: { kind: "fs.rmdir", path: full(target) } });
      state.set(key(target), { path: target, kind: "directory" });
    } else if (action.kind === "fs.move") {
      record(action, [...common, "from", "to"], "move");
      const sourceRelative = relativePath(canonicalRoot, action.from);
      const source = state.get(key(sourceRelative));
      if (!source || source.kind !== "file") fail("FILE_PLAN_CONFLICT", `move source must be an ordinary file: ${String(action.from)}`);
      const target = newTarget(action.to);
      compiled.push({ ...base, kind: "fs.move", from: full(source.path), to: full(target),
        pre: [{ kind: "path.exists", path: full(source.path) }, { kind: "path.absent", path: full(target) }, { kind: "path.exists", path: path.dirname(full(target)) }, ...extraPre],
        post: [{ kind: "path.absent", path: full(source.path) }, { kind: "path.exists", path: full(target) }, ...extraPost],
        undo: { kind: "fs.move", from: full(target), to: full(source.path) } });
      state.delete(key(sourceRelative));
      state.set(key(target), { ...source, path: target });
    } else if (action.kind === "fs.write") {
      record(action, [...common, "path", "content"], "write");
      if (typeof action.content !== "string") fail("INVALID_FILE_PLAN", "write content must be text");
      const target = newTarget(action.path);
      const size = Buffer.byteLength(action.content, "utf8");
      totalBytes += size;
      if (size > snapshot.limits.maxFileBytes || totalBytes > snapshot.limits.maxTotalBytes) fail("SNAPSHOT_LIMIT", "predicted write exceeds snapshot limits");
      compiled.push({ ...base, kind: "fs.write", path: full(target), content: action.content,
        pre: [{ kind: "path.absent", path: full(target) }, { kind: "path.exists", path: path.dirname(full(target)) }, ...extraPre],
        post: [{ kind: "path.exists", path: full(target) }, ...extraPost],
        undo: { kind: "fs.restore", path: full(target), content: null } });
      state.set(key(target), { path: target, kind: "file", size, hash: hash(action.content) });
    } else fail("INVALID_FILE_PLAN", "only fs.mkdir, fs.move and create-only fs.write are supported");
    if (state.size > snapshot.limits.maxNodes) fail("SNAPSHOT_LIMIT", "predicted tree exceeds node limit");
  }
  const nodes = order([...state.values()]);
  return { actions: compiled, prediction: { semanticDigest: semanticDigest(nodes), nodes } };
}

export function compileFilePlan(actions: readonly Action[], root: string, snapshot: TreeSnapshot): Action[] {
  return simulate(actions, root, snapshot).actions;
}

export function predictFilePlan(actions: readonly Action[], root: string, snapshot: TreeSnapshot): FilePlanPrediction {
  return simulate(actions, root, snapshot).prediction;
}

/** Verify all paths/bytes and retained object identities, not merely path.exists postconditions. */
export function assertFilePlanResult(root: string, before: TreeSnapshot, actions: readonly Action[]): TreeSnapshot {
  const expected = predictFilePlan(actions, root, before);
  const actual = captureTree(root, before.limits);
  if (actual.semanticDigest !== expected.semanticDigest) fail("FILE_PLAN_RESULT_MISMATCH", "result paths or file bytes differ from the approved effects");
  const current = new Map(actual.nodes.map((node) => [key(node.path), node]));
  for (const node of expected.nodes) {
    if (!node.identity) continue;
    const observed = current.get(key(node.path))!;
    if (observed.ino !== node.identity.ino || observed.dev !== node.identity.dev
        || (node.kind === "file" && observed.mtimeNs !== node.identity.mtimeNs)) {
      fail("FILE_PLAN_RESULT_MISMATCH", `an existing object was replaced or modified: ${node.path}`);
    }
  }
  return actual;
}

export function afterFileAction(root: string, before: TreeSnapshot, action: Action): TreeSnapshot {
  return assertFilePlanResult(root, before, [action]);
}
