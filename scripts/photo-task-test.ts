import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskHost } from "../packages/runtime/src/host.ts";
import { captureTree, FilePlanError } from "../packages/runtime/src/file-plan.ts";
import { createPhotoFixture, createPhotoGoal, createPhotoRegistration, PHOTO_DEFAULT_TIMEZONE, PHOTO_DUPLICATES_DIRECTORY, PHOTO_SKILL_ID, PhotoTaskError, photoDedupeSkillDescription, photoSkillDescription } from "../packages/runtime/src/photo-task.ts";
import type { PhotoGoal } from "../packages/runtime/src/photo-task.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deskshell-photo-check-"));
const registration = createPhotoRegistration();
const args = { dateSource: "mtime", timeZone: PHOTO_DEFAULT_TIMEZONE };
let passed = 0;
const test = async (name: string, run: () => unknown | Promise<unknown>): Promise<void> => { await run(); console.log(`PASS ${name}`); passed++; };
const errorCode = (code: string) => (error: unknown): boolean => error instanceof PhotoTaskError && error.code === code;
const verify = (root: string, goal: PhotoGoal) => registration.validator.verify({ root, criteria: goal, actions: [] });
function setup() {
  const fixture = createPhotoFixture(temp);
  const goal = createPhotoGoal(fixture.root);
  const host = createTaskHost({ dataDir: fixture.stateDir, allowedRoots: [fixture.root], granted: ["fs.read", "fs.write"], skills: [registration] });
  return { ...fixture, goal, host };
}
async function execute(fixture: ReturnType<typeof setup>) {
  const plan = await fixture.host.tasks.prepare({ skillId: PHOTO_SKILL_ID, root: fixture.root, args, goal: { intent: "按修改时间和上海时区整理照片，保留其他文件", criteria: fixture.goal } });
  const approval = fixture.host.approvals.approve(plan.planId, plan.digest);
  const result = await fixture.host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: approval.approvalId, idempotencyKey: "photo-test" });
  assert.equal(result.status, "succeeded");
  return { plan, result };
}
function bare(name: string) { const root = path.join(temp, name); fs.mkdirSync(root); return root; }
function photo(root: string, name: string, stamp = "2026-08-15T00:00:00Z") {
  const file = path.join(root, name); fs.writeFileSync(file, `Synthetic ${name}`, { flag: "wx" });
  const date = new Date(stamp); fs.utimesSync(file, date, date);
}
function matchingPhoto(root: string, name: string, content: string | Buffer, stamp: string): void {
  const filename = path.join(root, name); fs.writeFileSync(filename, content, { flag: "wx" });
  const date = new Date(stamp); fs.utimesSync(filename, date, date);
}
async function executeGoal(root: string, goal: PhotoGoal) {
  const host = createTaskHost({ dataDir: fs.mkdtempSync(path.join(temp, "state-")), allowedRoots: [root], granted: ["fs.read", "fs.write"], skills: [registration] });
  try {
    const plan = await host.tasks.prepare({ skillId: PHOTO_SKILL_ID, root, args: { ...args, ...(goal.deduplicate === true ? { deduplicate: true } : {}) }, goal: { intent: "Sort photos and retain exact duplicates for review when explicitly selected", criteria: goal } });
    const approval = host.approvals.approve(plan.planId, plan.digest);
    const result = await host.tasks.execute({ planId: plan.planId, digest: plan.digest, approvalReceiptId: approval.approvalId, idempotencyKey: "dedupe-test" });
    assert.equal(result.status, "succeeded"); assert.equal(result.goal?.satisfied, true);
    return { plan, result };
  } finally { host.close(); }
}

try {
  await test("preview is read-only and a complete approved task preserves unrelated resources", async () => {
    const f = setup();
    try {
      const before = captureTree(f.root);
      const preview = await f.host.tasks.prepare({ skillId: PHOTO_SKILL_ID, root: f.root, args, goal: { intent: "sort by modification month", criteria: f.goal } });
      assert.equal(captureTree(f.root).digest, before.digest);
      assert.equal(preview.actions.filter((action) => action.kind === "fs.move").length, 3);
      assert.equal(preview.actions.filter((action) => action.kind === "fs.mkdir").length, 2);
      assert.equal(preview.actions.some((action) => action.kind === "fs.mkdir" && action.path === path.join(f.root, "2026-09")), false);
      const { result } = await execute(f);
      assert.equal(result.goal?.satisfied, true);
      assert.equal(fs.existsSync(path.join(f.root, "august.JPG")), false);
      assert.equal(fs.readFileSync(path.join(f.root, "2026-08/august.JPG"), "utf8"), "Synthetic photo fixture A\n");
      assert.equal(fs.readFileSync(path.join(f.root, "notes.txt"), "utf8"), "Keep this non-photo file untouched.\n");
      assert.equal(fs.readFileSync(path.join(f.root, "keep/nested.jpg"), "utf8"), "Do not recursively sort subdirectories.\n");
      assert.equal(fs.readFileSync(path.join(f.root, "2026-09/earlier.jpg"), "utf8"), "Keep this already grouped photo.\n");
    } finally { f.host.close(); }
  });
  await test("existing destination photo refuses both goal and plan without overwriting", async () => {
    const f = createPhotoFixture(temp); fs.mkdirSync(path.join(f.root, "2026-08"));
    fs.writeFileSync(path.join(f.root, "2026-08/august.JPG"), "human existing photo", { flag: "wx" });
    const before = captureTree(f.root).digest;
    assert.throws(() => createPhotoGoal(f.root), errorCode("PHOTO_DESTINATION_EXISTS"));
    await assert.rejects(registration.skill.plan({ root: f.root, ...args }, {}), errorCode("PHOTO_DESTINATION_EXISTS"));
    assert.equal(captureTree(f.root).digest, before);
  });
  await test("a regular file occupying a month directory is refused", async () => {
    const root = bare("month-file"); photo(root, "one.jpg"); fs.writeFileSync(path.join(root, "2026-08"), "keep");
    const before = captureTree(root).digest;
    assert.throws(() => createPhotoGoal(root), errorCode("PHOTO_DESTINATION_EXISTS"));
    await assert.rejects(registration.skill.plan({ root, ...args }, {}), errorCode("PHOTO_DESTINATION_EXISTS"));
    assert.equal(captureTree(root).digest, before);
  });
  await test("no root-level photos is an explicit non-success even with nested photos", async () => {
    const root = bare("no-photos"); fs.mkdirSync(path.join(root, "nested")); photo(path.join(root, "nested"), "hidden.jpg");
    fs.writeFileSync(path.join(root, "text.txt"), "keep");
    assert.throws(() => createPhotoGoal(root), errorCode("NO_PHOTOS"));
    await assert.rejects(registration.skill.plan({ root, ...args }, {}), errorCode("NO_PHOTOS"));
  });
  await test("arguments cannot change date source, timezone, or add behavior", async () => {
    const f = createPhotoFixture(temp); const before = captureTree(f.root).digest;
    for (const invalid of [{ dateSource: "exif", timeZone: PHOTO_DEFAULT_TIMEZONE }, { dateSource: "mtime", timeZone: "UTC" }, { ...args, delete: true }, {}, { ...args, extraRoot: temp }]) {
      await assert.rejects(registration.skill.plan({ root: f.root, ...invalid }, {}), errorCode("INVALID_PHOTO_ARGUMENTS"));
    }
    assert.equal(captureTree(f.root).digest, before);
  });
  await test("month boundaries use Shanghai time regardless of the machine timezone", async () => {
    const root = bare("timezone"); photo(root, "before.jpg", "2026-08-31T15:59:59Z"); photo(root, "after.PNG", "2026-08-31T16:00:00Z");
    const goal = createPhotoGoal(root);
    assert.deepEqual(goal.moves, [{ from: "after.PNG", to: "2026-09/after.PNG" }, { from: "before.jpg", to: "2026-08/before.jpg" }]);
    const actions = await registration.skill.plan({ root, ...args }, {});
    const destinations = actions.filter((action) => action.kind === "fs.move").map((action) => path.relative(root, action.to).replaceAll(path.sep, "/")).sort();
    assert.deepEqual(destinations, ["2026-08/before.jpg", "2026-09/after.PNG"]);
  });
  await test("independent verifier rejects an unexecuted task and ignores claimed action success", async () => {
    const f = setup();
    try { assert.equal((await verify(f.root, f.goal)).satisfied, false); }
    finally { f.host.close(); }
  });
  await test("independent verifier detects a missing moved photo", async () => {
    const f = setup();
    try { await execute(f); fs.unlinkSync(path.join(f.root, "2026-08/august.JPG")); assert.equal((await verify(f.root, f.goal)).satisfied, false); }
    finally { f.host.close(); }
  });
  await test("independent verifier detects changed photo bytes", async () => {
    const f = setup();
    try { await execute(f); fs.writeFileSync(path.join(f.root, "2026-08/august.JPG"), "corrupted"); assert.equal((await verify(f.root, f.goal)).satisfied, false); }
    finally { f.host.close(); }
  });
  await test("independent verifier detects changes to unrelated original files", async () => {
    const f = setup();
    try { await execute(f); fs.writeFileSync(path.join(f.root, "keep/nested.jpg"), "unrelated modification"); assert.equal((await verify(f.root, f.goal)).satisfied, false); }
    finally { f.host.close(); }
  });
  await test("independent verifier detects unexpected extra resources", async () => {
    const f = setup();
    try { await execute(f); fs.writeFileSync(path.join(f.root, "unexpected.txt"), "extra"); assert.equal((await verify(f.root, f.goal)).satisfied, false); }
    finally { f.host.close(); }
  });
  await test("independent verifier detects changed original modification time", async () => {
    const f = setup();
    try { await execute(f); const stamp = new Date("2026-12-01T00:00:00Z"); fs.utimesSync(path.join(f.root, "2026-08/august.JPG"), stamp, stamp); assert.equal((await verify(f.root, f.goal)).satisfied, false); }
    finally { f.host.close(); }
  });
  await test("independent verifier detects same-content resource replacement", async () => {
    const f = setup();
    try {
      await execute(f); const target = path.join(f.root, "2026-08/august.JPG"); const stat = fs.statSync(target); const bytes = fs.readFileSync(target);
      fs.renameSync(target, path.join(f.fixture, "retained-original")); fs.writeFileSync(target, bytes, { flag: "wx" }); fs.utimesSync(target, stat.atime, stat.mtime);
      assert.equal((await verify(f.root, f.goal)).satisfied, false);
    } finally { f.host.close(); }
  });
  await test("malformed goal or a goal for another root cannot report success", async () => {
    const f = setup();
    try {
      await execute(f);
      assert.equal((await registration.validator.verify({ root: f.root, criteria: null, actions: [] })).satisfied, false);
      assert.equal((await verify(f.root, { ...f.goal, root: temp })).satisfied, false);
      assert.equal((await verify(f.root, { ...f.goal, expectedNodes: [f.goal.expectedNodes[0], f.goal.expectedNodes[0]] })).satisfied, false);
    } finally { f.host.close(); }
  });
  await test("legacy sorting keeps identical photos in their own months without opting into deduplication", async () => {
    const f = createPhotoFixture(temp, { duplicate: true }); const goal = createPhotoGoal(f.root);
    assert.equal(goal.deduplicate, undefined);
    await executeGoal(f.root, goal);
    assert.equal(fs.existsSync(path.join(f.root, PHOTO_DUPLICATES_DIRECTORY)), false);
    assert.equal(fs.existsSync(path.join(f.root, "2026-08/august.JPG")), true);
    assert.equal(fs.existsSync(path.join(f.root, "2026-10/z-duplicate.png")), true);
  });
  await test("explicit exact deduplication retains all original copies and untouched resources", async () => {
    const f = createPhotoFixture(temp, { duplicate: true }); const before = captureTree(f.root);
    const goal = createPhotoGoal(f.root, { deduplicate: true });
    assert.equal(captureTree(f.root).digest, before.digest);
    assert.equal(goal.deduplicate, true); assert.equal(goal.duplicateDirectory, "_duplicates");
    assert.deepEqual(goal.duplicates, [{ path: "z-duplicate.png", retainedPath: "august.JPG" }]);
    const { plan } = await executeGoal(f.root, goal);
    assert.equal(plan.actions.filter((action) => action.kind === "fs.move").length, 4);
    assert.equal(plan.actions.filter((action) => action.kind === "fs.mkdir").length, 3);
    const after = captureTree(f.root);
    assert.equal(after.nodes.filter((node) => node.kind === "file").length, before.nodes.filter((node) => node.kind === "file").length);
    assert.equal(fs.readFileSync(path.join(f.root, "_duplicates/z-duplicate.png"), "utf8"), "Synthetic photo fixture A\n");
    assert.equal(fs.readFileSync(path.join(f.root, "keep/nested.jpg"), "utf8"), "Do not recursively sort subdirectories.\n");
    assert.equal(fs.readFileSync(path.join(f.root, "notes.txt"), "utf8"), "Keep this non-photo file untouched.\n");
  });
  await test("retained representative uses case-sensitive UTF-16 filename order and its own timestamp", async () => {
    const root = bare("dedupe-order");
    matchingPhoto(root, "a-old.jpg", "identical", "2026-07-01T00:00:00Z");
    matchingPhoto(root, "B-kept.PNG", "identical", "2026-08-31T16:00:00Z");
    matchingPhoto(root, "z-later.heic", "identical", "2026-10-01T00:00:00Z");
    const goal = createPhotoGoal(root, { deduplicate: true });
    assert.deepEqual(goal.duplicates, [{ path: "a-old.jpg", retainedPath: "B-kept.PNG" }, { path: "z-later.heic", retainedPath: "B-kept.PNG" }]);
    await executeGoal(root, goal);
    assert.equal(fs.existsSync(path.join(root, "2026-09/B-kept.PNG")), true);
    assert.equal(fs.existsSync(path.join(root, "_duplicates/a-old.jpg")), true);
    assert.equal(fs.existsSync(path.join(root, "_duplicates/z-later.heic")), true);
    assert.equal(fs.existsSync(path.join(root, "2026-07")), false);
  });
  await test("large files with matching prefixes but different suffixes are never treated as duplicates", async () => {
    const root = bare("dedupe-full-content");
    const first = Buffer.alloc(9 * 1024 * 1024, 65); first[first.length - 1] = 1;
    const different = Buffer.from(first); different[different.length - 1] = 2;
    matchingPhoto(root, "a-large.jpg", first, "2026-08-01T00:00:00Z");
    matchingPhoto(root, "b-same-prefix.jpg", different, "2026-08-02T00:00:00Z");
    matchingPhoto(root, "c-identical.png", first, "2026-08-03T00:00:00Z");
    const goal = createPhotoGoal(root, { deduplicate: true });
    assert.deepEqual(goal.duplicates, [{ path: "c-identical.png", retainedPath: "a-large.jpg" }]);
    await executeGoal(root, goal);
    assert.equal(fs.readFileSync(path.join(root, "2026-08/b-same-prefix.jpg")).at(-1), 2);
    assert.equal(fs.readFileSync(path.join(root, "_duplicates/c-identical.png")).equals(first), true);
  });
  await test("existing duplicate review directory is reused while preserving its entries", async () => {
    const f = createPhotoFixture(temp, { duplicate: true }); fs.mkdirSync(path.join(f.root, "_duplicates"));
    fs.writeFileSync(path.join(f.root, "_duplicates/previous.jpg"), "earlier review copy", { flag: "wx" });
    const goal = createPhotoGoal(f.root, { deduplicate: true }); const { plan } = await executeGoal(f.root, goal);
    assert.equal(plan.actions.some((action) => action.kind === "fs.mkdir" && action.path === path.join(f.root, "_duplicates")), false);
    assert.equal(fs.readFileSync(path.join(f.root, "_duplicates/previous.jpg"), "utf8"), "earlier review copy");
  });
  await test("duplicate destination conflicts fail without overwriting or partially planning", async () => {
    const f = createPhotoFixture(temp, { duplicate: true }); fs.mkdirSync(path.join(f.root, "_duplicates"));
    fs.writeFileSync(path.join(f.root, "_duplicates/z-duplicate.png"), "human copy", { flag: "wx" });
    const before = captureTree(f.root).digest;
    assert.throws(() => createPhotoGoal(f.root, { deduplicate: true }), errorCode("PHOTO_DESTINATION_EXISTS"));
    await assert.rejects(registration.skill.plan({ root: f.root, ...args, deduplicate: true }, {}), errorCode("PHOTO_DESTINATION_EXISTS"));
    assert.equal(captureTree(f.root).digest, before);
  });
  await test("a regular file occupying the duplicate review directory is refused", async () => {
    const f = createPhotoFixture(temp, { duplicate: true }); fs.writeFileSync(path.join(f.root, "_duplicates"), "human file", { flag: "wx" });
    assert.throws(() => createPhotoGoal(f.root, { deduplicate: true }), errorCode("PHOTO_DESTINATION_EXISTS"));
    await assert.rejects(registration.skill.plan({ root: f.root, ...args, deduplicate: true }, {}), errorCode("PHOTO_DESTINATION_EXISTS"));
    assert.equal(fs.readFileSync(path.join(f.root, "_duplicates"), "utf8"), "human file");
  });
  await test("existing archived and nested photos do not participate in deduplication", async () => {
    const root = bare("dedupe-root-only"); fs.mkdirSync(path.join(root, "2026-08")); fs.mkdirSync(path.join(root, "nested"));
    matchingPhoto(root, "root.jpg", "same bytes", "2026-09-01T00:00:00Z");
    matchingPhoto(path.join(root, "2026-08"), "older.jpg", "same bytes", "2026-08-01T00:00:00Z");
    matchingPhoto(path.join(root, "nested"), "deep.jpg", "same bytes", "2026-07-01T00:00:00Z");
    const goal = createPhotoGoal(root, { deduplicate: true }); assert.deepEqual(goal.duplicates, []);
    await executeGoal(root, goal);
    assert.equal(fs.existsSync(path.join(root, "_duplicates")), false);
    assert.equal(fs.readFileSync(path.join(root, "2026-08/older.jpg"), "utf8"), "same bytes");
    assert.equal(fs.readFileSync(path.join(root, "nested/deep.jpg"), "utf8"), "same bytes");
  });
  await test("simple model contract cannot request deduplication and dedupe contract requires opt-in", async () => {
    assert.equal(Object.hasOwn(photoSkillDescription.argsSchema.properties!, "deduplicate"), false);
    assert.deepEqual(photoDedupeSkillDescription.argsSchema.required, ["dateSource", "timeZone", "deduplicate"]);
    assert.deepEqual(photoDedupeSkillDescription.argsSchema.properties!.deduplicate.enum, [true]);
    const f = createPhotoFixture(temp, { duplicate: true });
    for (const value of ["true", 1, null, undefined]) await assert.rejects(registration.skill.plan({ root: f.root, ...args, deduplicate: value }, {}), errorCode("INVALID_PHOTO_ARGUMENTS"));
    assert.throws(() => createPhotoGoal(f.root, { deduplicate: "true" } as never), errorCode("INVALID_PHOTO_ARGUMENTS"));
    const plain = await registration.skill.plan({ root: f.root, ...args }, {});
    assert.deepEqual(await registration.skill.plan({ root: f.root, ...args, deduplicate: false }, {}), plain);
  });
  await test("duplicate review content or identity changes invalidate independent goal verification", async () => {
    const f = createPhotoFixture(temp, { duplicate: true }); const goal = createPhotoGoal(f.root, { deduplicate: true });
    await executeGoal(f.root, goal);
    const duplicate = path.join(f.root, "_duplicates/z-duplicate.png"); fs.writeFileSync(duplicate, "human changed duplicate");
    assert.equal((await verify(f.root, goal)).satisfied, false);
  });
  await test("deduplication still enforces the complete snapshot file size limit", async () => {
    const root = bare("dedupe-limit"); matchingPhoto(root, "large.jpg", Buffer.alloc(16 * 1024 * 1024 + 1), "2026-08-01T00:00:00Z");
    assert.throws(() => createPhotoGoal(root, { deduplicate: true }), (error) => error instanceof FilePlanError && error.code === "SNAPSHOT_LIMIT");
    await assert.rejects(registration.skill.plan({ root, ...args, deduplicate: true }, {}), (error) => error instanceof FilePlanError && error.code === "SNAPSHOT_LIMIT");
  });
  await test("a candidate changing between the snapshot and full-byte comparison is refused", () => {
    const root = bare("dedupe-state-drift");
    matchingPhoto(root, "a.jpg", "matching bytes", "2026-08-01T00:00:00Z");
    matchingPhoto(root, "b.jpg", "matching bytes", "2026-08-02T00:00:00Z");
    const target = path.join(root, "a.jpg"); const originalOpen = fs.openSync;
    let opens = 0;
    fs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(file) === target && flags === "r" && ++opens === 2) fs.writeFileSync(target, "changed after observation");
      return originalOpen(file, flags, mode);
    }) as typeof fs.openSync;
    try { assert.throws(() => createPhotoGoal(root, { deduplicate: true }), errorCode("STALE_PLAN")); }
    finally { fs.openSync = originalOpen; }
    assert.equal(fs.existsSync(path.join(root, "_duplicates")), false);
    assert.equal(fs.readFileSync(path.join(root, "b.jpg"), "utf8"), "matching bytes");
  });
  console.log(`Photo task checks passed: ${passed}`);
} finally {
  // Only remove the unique test directory whose absolute parent and name were fixed above.
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith("deskshell-photo-check-")) throw new Error("Unsafe test cleanup path");
  fs.rmSync(temp, { recursive: true, force: true });
}
