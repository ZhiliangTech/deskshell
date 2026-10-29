import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, undoTask } from "../packages/core/src/kernel.ts";
import { load } from "../packages/core/src/journal.ts";
import { makePhotoFixture } from "./make-photo-fixture.ts";
import type { CapabilityId, Skill } from "../packages/core/src/types.ts";

/**
 * 撤销覆盖率的证明：对每个公开 skill，apply 之后再 undo，
 * 目录必须回到 **逐字节一致** 的状态（不算 .deskshell 日志目录）。
 *
 * 需要 GUI 的 skill 明确标 skipped 并给出理由，不静默略过。
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T00:00:00Z").getTime();
const base = path.resolve(".demo/undo-coverage");

interface Case {
  name: string;
  fixture: (root: string) => void;
  input?: Record<string, unknown>;
  skip?: string;
}

const files = (root: string, list: Array<[string, string?]>): void => {
  for (const [name, content] of list) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
  }
};

const CASES: Case[] = [
  {
    name: "downloads-cleanup",
    fixture: (root) => {
      files(root, [
        ["a.txt", "a"],
        ["b.jpg", "b"],
        ["c.jpg", "c"],
        ["d.zip", "d"],
        ["notes-copy.txt", "n"],
        ["notes.txt", "n"],
      ]);
    },
  },
  {
    name: "photo-sort",
    fixture: (root) => makePhotoFixture(root),
  },
  {
    name: "log-archive",
    fixture: (root) => {
      for (const [name, age] of [
        ["old-a.log", 60],
        ["old-b.log", 45],
        ["fresh.log", 2],
      ] as Array<[string, number]>) {
        const f = path.join(root, name);
        fs.writeFileSync(f, name);
        const t = new Date(NOW - age * DAY);
        fs.utimesSync(f, t, t);
      }
    },
    input: { now: NOW },
  },
  {
    name: "rename-batch",
    fixture: (root) => {
      files(root, [
        ["IMG_9.jpg", "9"],
        ["IMG_10.jpg", "10"],
        ["IMG_2.jpg", "2"],
        ["keep.png", "k"],
      ]);
    },
    input: { pattern: "IMG_*.jpg", prefix: "trip", pad: 3 },
  },
  {
    name: "first-skill",
    fixture: (root) => {
      files(root, [
        ["a.md", "a"],
        ["b.ts", "b"],
        ["c.ts", "c"],
      ]);
    },
  },
  {
    name: "browser-tabs",
    fixture: () => undefined,
    skip: "需要真实浏览器窗口（GUI）",
  },
  {
    name: "tile-windows",
    fixture: () => undefined,
    skip: "需要真实窗口（GUI）",
  },
];

interface Snapshot {
  [rel: string]: string;
}

function snapshot(root: string): Snapshot {
  const out: Snapshot = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (rel === ".deskshell" || rel.startsWith(".deskshell/")) continue;
      if (entry.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(abs);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(abs);
        out[rel] = `${buf.length}:${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`;
      }
    }
  };
  walk(root);
  return out;
}

const diff = (a: Snapshot, b: Snapshot): string[] => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) if (a[k] !== b[k]) out.push(`${k} (${a[k] ?? "缺失"} → ${b[k] ?? "缺失"})`);
  return out;
};

const results: string[] = [];
let pass = 0;
let skip = 0;
let fail = 0;

fs.rmSync(base, { recursive: true, force: true });

for (const c of CASES) {
  if (c.skip) {
    results.push(`SKIP  ${c.name.padEnd(18)} ${c.skip}`);
    skip++;
    continue;
  }
  const root = path.join(base, c.name);
  fs.mkdirSync(root, { recursive: true });
  c.fixture(root);

  const mod = (await import(pathToFileURL(path.resolve(`packages/skills/${c.name}/index.ts`)).href)) as {
    skill: Skill;
  };
  const skill = mod.skill;
  const granted = skill.manifest.capabilities.map((x) => x.id) as CapabilityId[];
  const journal = path.join(root, ".deskshell", "journal.jsonl");

  const before = snapshot(root);
  const applied = await run(skill, { root, ...(c.input ?? {}) }, { mode: "apply", root, granted, journalPath: journal }, {});
  const afterApply = snapshot(root);
  const taskId = load(journal).find((e) => e.status === "ok")?.taskId;
  const undone = taskId
    ? await undoTask(taskId, { mode: "undo", root, granted, journalPath: journal }, {})
    : { rolledBack: 0, steps: [] };
  const afterUndo = snapshot(root);

  const applyChanged = diff(before, afterApply).length > 0;
  const undoDiff = diff(before, afterUndo);
  const ok =
    applyChanged &&
    applied.steps.every((s) => s.status === "ok") &&
    undone.rolledBack === applied.steps.length &&
    undoDiff.length === 0;

  if (ok) pass++;
  else fail++;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(18)} ${applied.steps.length} 步 · 撤销 ${"rolledBack" in undone ? undone.rolledBack : 0} 步` +
      (undoDiff.length ? ` · 残留差异 ${undoDiff.slice(0, 3).join("; ")}` : " · 逐字节一致"),
  );
}

console.log(results.join("\n"));
console.log(`${pass}/${pass + fail} passed，${skip} skipped`);
if (fail > 0) process.exitCode = 1;
