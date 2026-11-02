import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Action, SkillInput } from "../../core/src/types.ts";
import type { SkillDescription } from "../../models/src/deepseek.ts";
import { assertUnchanged, captureTree } from "./file-plan.ts";
import type { TreeNode, TreeSnapshot } from "./file-plan.ts";
import type { GoalResult, JsonValue, SkillRegistration } from "./types.ts";

export const PHOTO_SKILL_ID = "photo-month-task";
export const PHOTO_SKILL_VERSION = "1";
export const PHOTO_DEFAULT_TIMEZONE = "Asia/Shanghai";
export const PHOTO_DUPLICATES_DIRECTORY = "_duplicates";
const DUPLICATE_KEEP_RULE = "utf16-filename-ascending";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".tiff", ".bmp"]);
const pathKey = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
const monthFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: PHOTO_DEFAULT_TIMEZONE, year: "numeric", month: "2-digit" });

export class PhotoTaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PhotoTaskError"; this.code = code; }
}
const fail = (code: string, message: string): never => { throw new PhotoTaskError(code, message); };

export const photoSkillDescription: SkillDescription = {
  id: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION,
  description: "把指定目录第一层的图像扩展名文件，按文件修改时间（mtime，不是 EXIF 拍摄时间）、Asia/Shanghai 时区归入 YYYY-MM 子目录。只移动和创建目录，保留其他文件、现有子目录与原始内容；不递归整理、不去重、不删除、不覆盖。只有这一固定规则满足用户目标时才提案；需要拍摄时间或去重时不能用它声称完成。",
  argsSchema: { type: "object", additionalProperties: false, required: ["dateSource", "timeZone"], properties: {
    dateSource: { type: "string", enum: ["mtime"] }, timeZone: { type: "string", enum: [PHOTO_DEFAULT_TIMEZONE] },
  } },
};

/** The trusted caller selects this description only after explicit opt-in to deduplication. */
export const photoDedupeSkillDescription: SkillDescription = {
  id: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION,
  description: "仅对指定目录第一层图像扩展名文件按完整 SHA-256、大小及完整字节比较识别相同内容。每组按区分大小写的 UTF-16 文件名字典序保留最小文件；代表按自己的文件修改时间（mtime，不是 EXIF）、Asia/Shanghai 时区归入 YYYY-MM，其余副本保留原名移到 _duplicates 待用户确认。不删除、不覆盖、不递归，也不与现有子目录或已归档文件去重。保留其他资源及每份原始字节。只有用户已选择这套去重与月份整理规则时才提案。",
  argsSchema: { type: "object", additionalProperties: false, required: ["dateSource", "timeZone", "deduplicate"], properties: {
    dateSource: { type: "string", enum: ["mtime"] }, timeZone: { type: "string", enum: [PHOTO_DEFAULT_TIMEZONE] }, deduplicate: { type: "boolean", enum: [true] },
  } },
};

function monthOf(mtimeNs: string): string {
  const ns = BigInt(mtimeNs);
  // BigInt division truncates toward zero; floor negative times to the preceding millisecond.
  const millis = ns / 1_000_000n - (ns < 0n && ns % 1_000_000n !== 0n ? 1n : 0n);
  const date = new Date(Number(millis));
  if (!Number.isFinite(date.valueOf())) fail("INVALID_PHOTO_TIME", "A photo modification time cannot be represented");
  const parts = monthFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !/^\d{4}$/.test(year) || !month || !/^(0[1-9]|1[0-2])$/.test(month)) fail("INVALID_PHOTO_TIME", "A photo modification time is outside supported years");
  return `${year}-${month}`;
}

function checkArgs(input: SkillInput): void {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !["root", "dateSource", "timeZone", "deduplicate"].includes(key) || !("value" in Object.getOwnPropertyDescriptor(input, key)!))
      || typeof input.root !== "string" || input.dateSource !== "mtime" || input.timeZone !== PHOTO_DEFAULT_TIMEZONE
      || (Object.hasOwn(input, "deduplicate") && typeof input.deduplicate !== "boolean")) {
    fail("INVALID_PHOTO_ARGUMENTS", "Photo sorting requires root, dateSource=mtime, timeZone=Asia/Shanghai, and an optional boolean deduplicate");
  }
}

const candidatePhoto = (node: TreeNode): boolean => node.kind === "file" && !node.path.includes("/") && IMAGE_EXT.has(path.extname(node.path).toLowerCase());

function observedBytes(snapshot: TreeSnapshot, node: TreeNode): Buffer {
  const filename = path.join(snapshot.root, node.path);
  const matches = (stat: fs.BigIntStats): boolean => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && String(stat.ino) === node.ino && String(stat.dev) === node.dev && String(stat.mtimeNs) === node.mtimeNs && Number(stat.size) === node.size;
  if (!matches(fs.lstatSync(filename, { bigint: true }))) fail("STALE_PLAN", "A duplicate candidate changed after observation");
  const handle = fs.openSync(filename, "r");
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (!matches(before)) fail("STALE_PLAN", "A duplicate candidate changed while opening");
    const content = Buffer.alloc(node.size!);
    let read = 0;
    while (read < content.length) {
      const count = fs.readSync(handle, content, read, content.length - read, read);
      if (!count) fail("STALE_PLAN", "A duplicate candidate became shorter");
      read += count;
    }
    if (fs.readSync(handle, Buffer.alloc(1), 0, 1, content.length) !== 0) fail("STALE_PLAN", "A duplicate candidate grew");
    const after = fs.fstatSync(handle, { bigint: true });
    if (!matches(after) || after.ctimeNs !== before.ctimeNs || !matches(fs.lstatSync(filename, { bigint: true }))
        || createHash("sha256").update(content).digest("hex") !== node.hash) fail("STALE_PLAN", "A duplicate candidate changed while comparing full content");
    return content;
  } finally { fs.closeSync(handle); }
}

/** Hashes only filter candidates. Equality and representative choice require complete bytes. */
function duplicateRepresentatives(snapshot: TreeSnapshot): Map<string, string> {
  const buckets = new Map<string, TreeNode[]>();
  for (const node of snapshot.nodes.filter(candidatePhoto)) {
    const key = `${node.size}:${node.hash}`;
    buckets.set(key, [...(buckets.get(key) ?? []), node]);
  }
  const duplicates = new Map<string, string>();
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const representatives: { path: string; content: Buffer }[] = [];
    for (const node of group) {
      const content = observedBytes(snapshot, node);
      const equivalent = representatives.find((candidate) => candidate.content.equals(content));
      if (equivalent) duplicates.set(node.path, equivalent.path);
      else representatives.push({ path: node.path, content });
    }
  }
  assertUnchanged(snapshot.root, snapshot);
  return duplicates;
}

type ExpectedNode = { path: string; kind: "file" | "directory"; ino?: string; dev?: string; size?: number; hash?: string; mtimeNs?: string };
export type PhotoGoal = {
  formatVersion: 1; dateSource: "mtime"; timeZone: typeof PHOTO_DEFAULT_TIMEZONE; root: string; observationDigest: string;
  expectedNodes: ExpectedNode[]; moves: { from: string; to: string }[];
  deduplicate?: boolean; duplicateDirectory?: typeof PHOTO_DUPLICATES_DIRECTORY; keepRule?: typeof DUPLICATE_KEEP_RULE;
  duplicates?: { path: string; retainedPath: string }[];
};

/** Trusted expectation built from a complete bounded observation, independently of skill actions. */
export function createPhotoGoal(root: string, options: { deduplicate?: boolean } = {}): PhotoGoal {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Reflect.ownKeys(options).some((key) => key !== "deduplicate" || !("value" in Object.getOwnPropertyDescriptor(options, key)!))
      || (Object.hasOwn(options, "deduplicate") && typeof options.deduplicate !== "boolean")) fail("INVALID_PHOTO_ARGUMENTS", "Goal options accept only a boolean deduplicate");
  const snapshot = captureTree(path.resolve(root));
  const duplicates = options.deduplicate === true ? duplicateRepresentatives(snapshot) : new Map<string, string>();
  const originals = new Map(snapshot.nodes.map((node) => [pathKey(node.path), node]));
  const expectedNodes: ExpectedNode[] = [];
  const moves: PhotoGoal["moves"] = [];
  const addedDirectories = new Set<string>();
  for (const node of snapshot.nodes) {
    const expected: ExpectedNode = { ...node };
    if (candidatePhoto(node)) {
      const directoryName = duplicates.has(node.path) ? PHOTO_DUPLICATES_DIRECTORY : monthOf(node.mtimeNs!);
      const destination = `${directoryName}/${node.path}`;
      if (originals.has(pathKey(destination))) fail("PHOTO_DESTINATION_EXISTS", "A destination photo already exists; resolve the conflict before preparing");
      const directory = originals.get(pathKey(directoryName));
      if (directory && directory.kind !== "directory") fail("PHOTO_DESTINATION_EXISTS", "An output directory name is already occupied by a file");
      if (!directory) addedDirectories.add(directoryName);
      expected.path = destination;
      moves.push({ from: node.path, to: destination });
    }
    expectedNodes.push(expected);
  }
  if (!moves.length) fail("NO_PHOTOS", "No supported image-extension files exist at the selected root level");
  for (const month of addedDirectories) expectedNodes.push({ path: month, kind: "directory" });
  expectedNodes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { formatVersion: 1, dateSource: "mtime", timeZone: PHOTO_DEFAULT_TIMEZONE, root: snapshot.root, observationDigest: snapshot.digest, expectedNodes, moves,
    ...(options.deduplicate === true ? { deduplicate: true, duplicateDirectory: PHOTO_DUPLICATES_DIRECTORY, keepRule: DUPLICATE_KEEP_RULE, duplicates: [...duplicates].map(([filename, retainedPath]) => ({ path: filename, retainedPath })) } : {}),
  };
}

function verifyPhotoGoal(root: string, criteria: JsonValue): GoalResult {
  // Criteria is host-owned. Validate its envelope anyway; never interpret paths as read instructions.
  const goal = criteria as PhotoGoal | null;
  if (!goal || goal.formatVersion !== 1 || goal.dateSource !== "mtime" || goal.timeZone !== PHOTO_DEFAULT_TIMEZONE
      || typeof goal.root !== "string" || pathKey(path.resolve(root)) !== pathKey(goal.root)
      || (goal.deduplicate !== undefined && typeof goal.deduplicate !== "boolean")
      || (goal.deduplicate === true && (goal.duplicateDirectory !== PHOTO_DUPLICATES_DIRECTORY || goal.keepRule !== DUPLICATE_KEEP_RULE || !Array.isArray(goal.duplicates)))
      || !Array.isArray(goal.expectedNodes) || !Array.isArray(goal.moves) || !goal.moves.length) {
    return { satisfied: false, detail: "Invalid trusted photo goal" };
  }
  try {
    const actual = captureTree(path.resolve(root));
    if (actual.nodes.length !== goal.expectedNodes.length) return { satisfied: false, detail: "The final file set does not match the approved goal" };
    const byPath = new Map(actual.nodes.map((node) => [pathKey(node.path), node]));
    const seen = new Set<string>();
    for (const expected of goal.expectedNodes) {
      if (!expected || typeof expected.path !== "string" || !["file", "directory"].includes(expected.kind) || seen.has(pathKey(expected.path))) return { satisfied: false, detail: "Invalid expected photo resources" };
      seen.add(pathKey(expected.path));
      const current = byPath.get(pathKey(expected.path));
      if (!current || current.kind !== expected.kind) return { satisfied: false, detail: "An expected file or directory is missing" };
      if (expected.ino !== undefined && (current.ino !== expected.ino || current.dev !== expected.dev)) return { satisfied: false, detail: "An original resource was replaced" };
      if (expected.kind === "file" && (current.hash !== expected.hash || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs)) return { satisfied: false, detail: "Original file content or modification time changed" };
    }
    return { satisfied: true, detail: goal.deduplicate === true
      ? "Exact duplicate copies retained in _duplicates; selected representatives sorted by their own mtime month; original bytes, resource identities, and file modification times preserved"
      : "All root-level photos moved to their mtime month; original bytes, resource identities, and file modification times preserved" };
  } catch { return { satisfied: false, detail: "The final photo tree could not be independently verified" }; }
}

export function createPhotoRegistration(): SkillRegistration {
  return {
    skill: {
      manifest: { name: PHOTO_SKILL_ID, version: PHOTO_SKILL_VERSION, description: "按修改月份整理根层照片；显式选择去重时将完整内容相同的额外副本移到待确认目录，保留全部原始文件。", entry: "photo-task.ts", capabilities: [
        { id: "fs.read", scope: "{{root}}", reason: "Read bounded file metadata and verify original content" },
        { id: "fs.write", scope: "{{root}}", reason: "Create missing month or duplicate-review directories and move root-level photos" },
      ] },
      async plan(input): Promise<Action[]> {
        checkArgs(input);
        const observation = captureTree(path.resolve(input.root));
        const duplicates = input.deduplicate === true ? duplicateRepresentatives(observation) : new Map<string, string>();
        const paths = new Map(observation.nodes.map((node) => [pathKey(node.path), node]));
        const groups = new Map<string, string[]>();
        for (const file of observation.nodes) {
          if (!candidatePhoto(file)) continue;
          const month = duplicates.has(file.path) ? PHOTO_DUPLICATES_DIRECTORY : monthOf(file.mtimeNs!);
          if (paths.has(pathKey(`${month}/${file.path}`))) fail("PHOTO_DESTINATION_EXISTS", "A destination photo already exists; no overwrite is supported");
          const parent = paths.get(pathKey(month));
          if (parent && parent.kind !== "directory") fail("PHOTO_DESTINATION_EXISTS", "A month name is already occupied by a file");
          groups.set(month, [...(groups.get(month) ?? []), file.path]);
        }
        if (!groups.size) fail("NO_PHOTOS", "No supported root-level photos to sort");
        const actions: Action[] = [];
        for (const month of [...groups.keys()].sort()) {
          const directory = path.join(observation.root, month);
          if (!paths.has(pathKey(month))) actions.push({ id: `month:${month}`, kind: "fs.mkdir", path: directory, risk: "low", undo: { kind: "fs.rmdir", path: directory } });
          for (const filename of groups.get(month)!.sort()) {
            const from = path.join(observation.root, filename); const to = path.join(directory, filename);
            actions.push({ id: `photo:${filename}`, kind: "fs.move", from, to, risk: "low", undo: { kind: "fs.move", from: to, to: from } });
          }
        }
        return actions;
      },
    },
    revision: () => {
      const hash = createHash("sha256");
      for (const file of [import.meta.filename, path.join(import.meta.dirname, "file-plan.ts")]) hash.update(fs.readFileSync(file));
      return hash.digest("hex");
    },
    validator: { id: "photo-original-tree", version: "1", verify: ({ root, criteria }) => verifyPhotoGoal(root, criteria) },
  };
}

/** Synthetic bytes named as photos exercise file operations; this does not test image decoding. */
export function createPhotoFixture(parent = os.tmpdir(), options: { duplicate?: boolean } = {}): { fixture: string; root: string; stateDir: string } {
  const fixture = fs.mkdtempSync(path.join(path.resolve(parent), "deskshell-photo-task-"));
  const root = path.join(fixture, "photos"); fs.mkdirSync(root);
  const write = (relative: string, content: string, date: string): void => {
    const file = path.join(root, relative); fs.writeFileSync(file, content, { flag: "wx" });
    const stamp = new Date(date); fs.utimesSync(file, stamp, stamp);
  };
  fs.mkdirSync(path.join(root, "2026-09"));
  fs.mkdirSync(path.join(root, "keep"));
  write("august.JPG", "Synthetic photo fixture A\n", "2026-08-15T00:00:00Z");
  write("boundary.png", "Synthetic photo fixture B\n", "2026-08-31T16:00:00Z");
  write("october.heic", "Synthetic photo fixture C\n", "2026-10-02T00:00:00Z");
  write("notes.txt", "Keep this non-photo file untouched.\n", "2026-07-01T00:00:00Z");
  write("2026-09/earlier.jpg", "Keep this already grouped photo.\n", "2026-09-03T00:00:00Z");
  write("keep/nested.jpg", "Do not recursively sort subdirectories.\n", "2026-06-03T00:00:00Z");
  if (options.duplicate === true) write("z-duplicate.png", "Synthetic photo fixture A\n", "2026-10-07T00:00:00Z");
  return { fixture, root, stateDir: path.join(fixture, "state") };
}
