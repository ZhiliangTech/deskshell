<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# 实战配方

五个今天就能跑的场景，每条都带真实命令和它产出的证据。

## 1. 整理下载文件夹（并且能收回来）

```bash
node scripts/make-fixture.ts
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
```

预览列 20 步；执行后 13 个文件进 6 个分类目录、3 个重复文件进 `.trash`；撤销后 13 个文件全部回到原位。

## 2. 照片按 `YYYY-MM` 归档

```bash
node scripts/make-photo-fixture.ts .demo/photo
node bin/deskshell.ts run photo-sort --root .demo/photo --mode apply
node bin/deskshell.ts run photo-sort --root .demo/photo --mode undo
```

12 文件夹具实测：12 个文件 → 3 个月份目录（`2026-03`、`2026-04`、`2026-05`）→ 撤销后 12 个文件回来、月份目录清零。非图片文件全程不动。

## 3. 归档 30 天前的日志

```bash
node bin/deskshell.ts run log-archive --root .demo/logs --mode preview
node bin/deskshell.ts run log-archive --root .demo/logs --mode apply
```

文件进 `archive/YYYY-MM/`。**不删除任何东西**——归档就是移动，撤销就是移回去。从代码里调用时可以传 `now` 与 `maxAgeDays`。

## 4. 批量改名，绝不覆盖

```bash
node bin/deskshell.ts run rename-batch --root .demo/photos --mode preview
```

`IMG_9.jpg, IMG_10.jpg, IMG_2.jpg` 会变成 `trip-001.jpg … trip-003.jpg`——按序、补零、保留扩展名。

真正有意思的是失败路径：如果 `trip-002.jpg` 已存在，这一步的 `path.absent` 前置断言失败，整个任务停下，之前改好的名字全部回滚。**改名永远不会悄悄覆盖**，失败的批次让目录保持原样。

## 5. 一千个文件要花多久

```bash
node scripts/bench.ts 1000
```

本机实测（Windows，Node 24.21.0）：

```
文件数            1000
plan              44 ms   (1002 步)
apply             737 ms  (0.7 ms/步)
undo              727 ms  (回滚 1002 步)
日志体积          387 KB  (396 B/步)
堆增长            7 MB
```

两个关键数字：**每步 0.7 ms**，审计日志每步不到 400 字节——所以就算几千个动作，账本也不贵。

## 自己写一个

```bash
node scripts/new-skill.ts --name my-skill
node bin/deskshell.ts run my-skill --mode preview
```

然后读 [写一个 skill](writing-a-skill.html)。三条硬规则——post 断言、undo、不碰系统 API——正是这些配方能被安全重跑的原因。
