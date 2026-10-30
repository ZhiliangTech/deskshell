# 起步包：GFI-10（20 分钟路径）

目标：让一个陌生人在 20 分钟内看到红灯变绿，而不是先读 15 页文档。

```bash
node scripts/new-skill.ts --name screenshot-dedupe
cp outreach/starter/gfi-10-screenshot-dedupe.test.ts scripts/screenshot-dedupe-test.ts
node scripts/screenshot-dedupe-test.ts     # 现在会失败——这就是起点
```

要做的只有一件事：在 `packages/skills/screenshot-dedupe/index.ts` 的 `plan()` 里，
把「内容相同的图片」找出来，保留最早的一个，其余 `fs.move` 到 `.trash/`（带 undo）。

三条硬规则（内核会拒绝，不是评审偏好）：

1. 每个 action 必须有 `post` 断言（这里：目标文件存在、源文件不存在）；
2. 每个 action 必须有 `undo`（`fs.move` 自带反向移动）；
3. `plan()` 里不许直接调系统 API——用内核提供的 action 类型。

不要做的事：不要解码图片（那需要依赖，违反零依赖）；只比字节就够了。

`node scripts/regress.ts` 全绿之后再开 PR，正文里贴上这两条命令的真实输出。
