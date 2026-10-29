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

规模验证——同一台机器上 5000 个文件：

```
文件数            5000
plan              167 ms  (5002 步)
apply             3770 ms (0.8 ms/步)
undo              3436 ms (回滚 5002 步)
日志体积          2071 KB (424 B/步)
堆增长            25 MB
```

成本是线性的：1000 与 5000 文件下都是每步 0.7–0.8 ms，日志每步大约 400 字节。

## 6. 按内容去重

```bash
node bin/deskshell.ts run dedupe-folders --root .\photos --mode preview
```

按 sha256（前 8 MiB + 文件大小）分组，**保留最早的那一份**，之后的重复项全部移进 `.trash/`。撤销会把它们全放回去——`.trash` 是真移动，不是删除。

## 7. 截图按日期归档

```bash
node bin/deskshell.ts run screenshot-organize --root .\Pictures\Screenshots --mode apply
```

`Screenshot 2026-03-04 at 10.11.12.png` → `2026/03/20260304-1011-Screenshot ....png`。只处理文件名里含 `screenshot` / `截图` / `snipaste` 的图片，其它文件不动。

## 8. 镜像目录

```bash
node bin/deskshell.ts run sync-mirror --root .uild --mode preview     # src -> mirror
```

缺失或变更的文本文件写过去，目标里多余的文件移进 `.trash`，二进制文件按设计跳过（`fs.write` 只带文本）。撤销会把每个文件的旧内容还回去。

## 自己写一个

```bash
node scripts/new-skill.ts --name my-skill
node bin/deskshell.ts run my-skill --mode preview
```

然后读 [写一个 skill](writing-a-skill.html)。三条硬规则——post 断言、undo、不碰系统 API——正是这些配方能被安全重跑的原因。
