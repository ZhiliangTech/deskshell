import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { MockDriver } from "../packages/drivers/mock/driver.ts";
import { makePhotoFixture } from "./make-photo-fixture.ts";
import type { Skill } from "../packages/core/src/types.ts";

const root = path.resolve(".demo/snapshot");
const snapDir = path.resolve("snapshots");
const update = process.env.UPDATE_SNAPSHOTS === "1";

// 固定夹具：文件场景依赖它
fs.rmSync(root, { recursive: true, force: true });
execFileSync(process.execPath, ["scripts/make-fixture.ts", path.join(root, "downloads")], {
  stdio: "ignore",
});
makePhotoFixture(path.join(root, "photos"));

// 归一化根路径，并把分隔符统一成 /：否则 Windows 与 Linux 生成的快照无法互相比较
const norm = (v: unknown): unknown => {
  const json = JSON.stringify(v)
    .split(JSON.stringify(root).slice(1, -1))
    .join("<root>")
    .replace(/\\\\/g, "/");
  return JSON.parse(json);
};

const cases: Array<{ name: string; file: string; input: Record<string, unknown>; driver?: MockDriver }> = [
  {
    name: "tile-windows",
    file: "packages/skills/tile-windows/index.ts",
    input: { root, limit: 2, area: { x: 0, y: 0, w: 1440, h: 900 } },
    driver: new MockDriver(),
  },
  {
    name: "photo-sort",
    file: "packages/skills/photo-sort/index.ts",
    input: { root: path.join(root, "photos") },
  },
  {
    name: "downloads-cleanup",
    file: "packages/skills/downloads-cleanup/index.ts",
    input: { root: path.join(root, "downloads") },
  },
];

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
fs.mkdirSync(snapDir, { recursive: true });

for (const c of cases) {
  const mod = (await import(pathToFileURL(path.resolve(c.file)).href)) as { skill?: Skill; default?: Skill };
  const skill = mod.skill ?? mod.default;
  if (!skill) {
    results.push({ name: c.name, ok: false, detail: "缺少 skill 导出" });
    continue;
  }
  const plan = norm(await skill.plan(c.input, { driver: c.driver }));
  const snapshotFile = path.join(snapDir, `${c.name}.json`);

  if (update || !fs.existsSync(snapshotFile)) {
    fs.writeFileSync(snapshotFile, JSON.stringify(plan, null, 2) + "\n", "utf8");
    results.push({ name: c.name, ok: true, detail: `已写入快照（${plan.length} 步）` });
    continue;
  }

  const expected = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  const same = JSON.stringify(plan) === JSON.stringify(expected);
  results.push({
    name: c.name,
    ok: same,
    detail: same ? `${plan.length} 步，与快照一致` : "计划与快照不一致（内核行为变了？确认后 UPDATE_SNAPSHOTS=1 更新）",
  });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(20)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} snapshots ${update ? "written" : "match"}`);
process.exitCode = failed ? 1 : 0;
