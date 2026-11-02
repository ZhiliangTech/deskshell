import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../packages/core/src/executor.ts";
import type { Action } from "../packages/core/src/types.ts";
import {
  afterFileAction,
  assertFilePlanResult,
  assertUnchanged,
  captureTree,
  compileFilePlan,
  predictFilePlan,
} from "../packages/runtime/src/file-plan.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-file-plan-test-"));
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const fixture = (name: string): string => {
  const root = path.join(base, name);
  fs.mkdirSync(root);
  return root;
};
const write = (root: string, name = "new.txt", content = "new"): Action => ({
  id: `write:${name}`, kind: "fs.write", path: path.join(root, name), content,
});
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
};

try {
  await check("mkdir/move/write predictions match every step and the complete tree", async () => {
    const root = fixture("normal");
    fs.writeFileSync(path.join(root, "old.txt"), "old");
    const before = captureTree(root);
    assert.equal(assertUnchanged(root, before).digest, before.digest);
    const actions: Action[] = [
      { id: "mkdir", kind: "fs.mkdir", path: path.join(root, "folder"), undo: { kind: "noop" } },
      { id: "move", kind: "fs.move", from: path.join(root, "old.txt"), to: path.join(root, "folder", "old.txt") },
      write(root, "new.txt", "hello 🌳"),
    ];
    const compiled = compileFilePlan(actions, root, before);
    assert.equal(compiled[0].undo?.kind, "fs.rmdir");
    assert.equal(compiled[1].undo?.kind, "fs.move");
    assert.equal(compiled[2].undo?.kind, "fs.restore");
    assert.ok(compiled.every((action) => action.pre!.length > 0 && action.post!.length > 0));
    let current = before;
    for (const action of compiled) {
      await execute(action, { root });
      current = afterFileAction(root, current, action);
    }
    assert.equal(assertFilePlanResult(root, before, compiled).semanticDigest, predictFilePlan(compiled, root, before).semanticDigest);
    assert.equal(current.semanticDigest, captureTree(root).semanticDigest);
    assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "hello 🌳");
  });

  await check("snapshot node/file/total limits reject instead of truncating", () => {
    const root = fixture("limits");
    fs.writeFileSync(path.join(root, "a.txt"), "abc");
    fs.writeFileSync(path.join(root, "b.txt"), "def");
    assert.throws(() => captureTree(root, { maxNodes: 2 }), /SNAPSHOT_LIMIT/);
    assert.throws(() => captureTree(root, { maxFileBytes: 2 }), /SNAPSHOT_LIMIT/);
    assert.throws(() => captureTree(root, { maxTotalBytes: 5 }), /SNAPSHOT_LIMIT/);
    assert.throws(() => captureTree(root, { maxNodes: 0 }), /INVALID_SNAPSHOT_LIMIT/);
    const before = captureTree(root, { maxTotalBytes: 7 });
    assert.throws(() => compileFilePlan([write(root, "c.txt", "12")], root, before), /SNAPSHOT_LIMIT/);
  });

  await check("symbolic links/junctions are rejected inside roots and in root ancestry", () => {
    const root = fixture("links");
    const target = fixture("link-target");
    fs.mkdirSync(path.join(target, "child"));
    const link = path.join(root, "jump");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => captureTree(root), /UNSUPPORTED_FILE_TREE/);
    assert.throws(() => captureTree(link), /UNSUPPORTED_FILE_TREE/);
    assert.throws(() => captureTree(path.join(link, "child")), /UNSUPPORTED_FILE_TREE/);
  });

  await check("hard links are rejected", () => {
    const root = fixture("hard-links");
    const original = path.join(root, "original.txt");
    fs.writeFileSync(original, "content");
    fs.linkSync(original, path.join(root, "alias.txt"));
    assert.throws(() => captureTree(root), /hard-linked/);
  });

  await check("out-of-root undo is rejected even though the compiler generates undo", () => {
    const root = fixture("undo-scope");
    const before = captureTree(root);
    const outside = path.join(base, "outside.txt");
    assert.throws(() => compileFilePlan([{ ...write(root), undo: { kind: "fs.restore", path: outside, content: null } }], root, before), /PATH_OUTSIDE_ROOT/);
    assert.throws(() => compileFilePlan([{ ...write(root), undo: { kind: "fs.move", from: path.join(root, "new.txt"), to: outside } }], root, before), /PATH_OUTSIDE_ROOT/);
    assert.equal(captureTree(root).digest, before.digest);
  });

  await check("pre/post paths remain in root and UI assertions are unsupported", () => {
    const root = fixture("assertion-scope");
    const before = captureTree(root);
    assert.throws(() => compileFilePlan([{ ...write(root), pre: [{ kind: "path.exists", path: base }] }], root, before), /PATH_OUTSIDE_ROOT/);
    assert.throws(() => compileFilePlan([{ ...write(root), post: [{ kind: "file.count", dir: base, equals: 0 }] }], root, before), /PATH_OUTSIDE_ROOT/);
    assert.throws(() => compileFilePlan([{ ...write(root), post: [{ kind: "window.exists", window: "Notepad" }] }], root, before), /INVALID_FILE_PLAN/);
  });

  await check("implicit parents and mkdir of an existing directory are rejected", () => {
    const root = fixture("directories");
    fs.mkdirSync(path.join(root, "existing"));
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    const before = captureTree(root);
    assert.throws(() => compileFilePlan([{ id: "mkdir", kind: "fs.mkdir", path: path.join(root, "missing", "child") }], root, before), /parent directory/);
    assert.throws(() => compileFilePlan([write(root, path.join("missing", "child.txt"))], root, before), /parent directory/);
    assert.throws(() => compileFilePlan([{ id: "move", kind: "fs.move", from: path.join(root, "a.txt"), to: path.join(root, "missing", "a.txt") }], root, before), /parent directory/);
    assert.throws(() => compileFilePlan([{ id: "mkdir", kind: "fs.mkdir", path: path.join(root, "existing") }], root, before), /already exists/);
  });

  await check("writes and moves cannot overwrite existing or earlier-created paths", () => {
    const root = fixture("overwrite");
    fs.writeFileSync(path.join(root, "old.txt"), "old");
    fs.writeFileSync(path.join(root, "other.txt"), "other");
    const before = captureTree(root);
    assert.throws(() => compileFilePlan([write(root, "old.txt")], root, before), /already exists/);
    assert.throws(() => compileFilePlan([{ id: "move", kind: "fs.move", from: path.join(root, "other.txt"), to: path.join(root, "old.txt") }], root, before), /already exists/);
    assert.throws(() => compileFilePlan([write(root), { ...write(root), id: "second-write" }], root, before), /already exists/);
    assert.equal(captureTree(root).digest, before.digest);
  });

  await check("directory moves are rejected", () => {
    const root = fixture("directory-move");
    fs.mkdirSync(path.join(root, "folder"));
    const before = captureTree(root);
    assert.throws(() => compileFilePlan([{ id: "move", kind: "fs.move", from: path.join(root, "folder"), to: path.join(root, "renamed") }], root, before), /ordinary file/);
  });

  await check("file edits and added paths make a prepared snapshot stale", () => {
    const root = fixture("stale");
    fs.writeFileSync(path.join(root, "keep.txt"), "before");
    const before = captureTree(root);
    fs.writeFileSync(path.join(root, "keep.txt"), "after");
    assert.throws(() => assertUnchanged(root, before), /STALE_PLAN/);
    const edited = captureTree(root);
    fs.mkdirSync(path.join(root, "new-directory"));
    assert.throws(() => assertUnchanged(root, edited), /STALE_PLAN/);
  });

  await check("result verification detects an unrelated file change", async () => {
    const root = fixture("unrelated");
    fs.writeFileSync(path.join(root, "keep.txt"), "keep");
    const before = captureTree(root);
    const actions = compileFilePlan([write(root)], root, before);
    await execute(actions[0], { root });
    fs.writeFileSync(path.join(root, "keep.txt"), "external edit");
    assert.throws(() => assertFilePlanResult(root, before, actions), /FILE_PLAN_RESULT_MISMATCH/);
  });

  await check("same-content object replacement is detected beyond semantic hashes", () => {
    const root = fixture("identity");
    const target = path.join(root, "keep.txt");
    fs.writeFileSync(target, "same bytes");
    const before = captureTree(root);
    const replacement = path.join(base, "replacement.txt");
    fs.writeFileSync(replacement, "same bytes");
    fs.unlinkSync(target);
    fs.renameSync(replacement, target);
    assert.equal(captureTree(root).semanticDigest, before.semanticDigest);
    assert.throws(() => assertFilePlanResult(root, before, []), /existing object was replaced or modified/);
    assert.throws(() => assertUnchanged(root, before), /STALE_PLAN/);
  });

  await check("unsupported attributes, operations and duplicate IDs are rejected", () => {
    const root = fixture("schema");
    const before = captureTree(root);
    assert.throws(() => compileFilePlan([{ ...write(root), createdDirs: [root] }], root, before), /unsupported property/);
    assert.throws(() => compileFilePlan([{ id: "delete", kind: "fs.delete", path: path.join(root, "a.txt"), undo: { kind: "noop" } }], root, before), /only fs.mkdir/);
    assert.throws(() => compileFilePlan([write(root), { ...write(root, "second.txt"), id: "write:new.txt" }], root, before), /unique/);
    if (process.platform === "win32") {
      assert.throws(() => compileFilePlan([write(root, "new.txt:stream")], root, before), /ambiguous Windows path/);
      assert.throws(() => compileFilePlan([write(root, "CON.txt")], root, before), /ambiguous Windows path/);
    }
  });

  await check("relative roots and tampered snapshot data are rejected", () => {
    const root = fixture("snapshot-data");
    assert.throws(() => captureTree("."), /INVALID_ROOT/);
    const before = captureTree(root);
    const corrupted = structuredClone(before);
    corrupted.nodes[0].ino = "forged";
    assert.throws(() => compileFilePlan([], root, corrupted), /INVALID_SNAPSHOT/);
    const other = fixture("other-root");
    assert.throws(() => assertUnchanged(other, before), /INVALID_SNAPSHOT/);
  });
} finally {
  const checked = path.resolve(base);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, checked);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)
      || path.dirname(checked) !== temporaryRoot || !path.basename(checked).startsWith("deskshell-file-plan-test-")) {
    throw new Error("Refusing cleanup outside the unique file-plan test fixture");
  }
  fs.rmSync(checked, { recursive: true, force: true });
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
const passed = results.filter((result) => result.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
