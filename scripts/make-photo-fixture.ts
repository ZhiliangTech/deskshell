import fs from "node:fs";
import path from "node:path";

/** 生成确定性的照片夹具：12 张图，跨 3 个月，名字与时间固定 */
export function makePhotoFixture(root: string): number {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const plan: Array<[string, string]> = [
    ["IMG_0001.jpg", "2026-03-04T10:00:00"],
    ["IMG_0002.jpg", "2026-03-19T12:30:00"],
    ["IMG_0003.png", "2026-03-28T08:15:00"],
    ["IMG_0004.jpg", "2026-04-02T09:00:00"],
    ["IMG_0005.heic", "2026-04-11T18:45:00"],
    ["IMG_0006.webp", "2026-04-25T11:20:00"],
    ["IMG_0007.jpg", "2026-05-01T07:05:00"],
    ["IMG_0008.jpg", "2026-05-06T21:40:00"],
    ["IMG_0009.jpeg", "2026-05-17T14:10:00"],
    ["IMG_0010.gif", "2026-05-23T16:55:00"],
    ["notes.txt", "2026-05-24T10:00:00"],
    ["manual.pdf", "2026-03-02T10:00:00"],
  ];

  for (const [name, iso] of plan) {
    const file = path.join(root, name);
    fs.writeFileSync(file, `fixture:${name}`);
    const t = new Date(`${iso}Z`);
    fs.utimesSync(file, t, t);
  }
  return plan.length;
}

if (process.argv[1]?.endsWith("make-photo-fixture.ts")) {
  const target = path.resolve(process.argv[2] ?? ".demo/photo");
  const n = makePhotoFixture(target);
  console.log(`photo fixture ready: ${target} (${n} files)`);
}
