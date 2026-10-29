<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Recipes

Five things you can do today, each with the commands that actually work and the evidence each one produces.

## 1. Clean up a downloads folder (and take it back)

```bash
node scripts/make-fixture.ts
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
```

Preview lists 20 steps; apply moves 13 files into six folders and three duplicates into `.trash`; undo puts all 13 back.

## 2. Sort photos into `YYYY-MM` by month

```bash
node scripts/make-photo-fixture.ts .demo/photo
node bin/deskshell.ts run photo-sort --root .demo/photo --mode apply
node bin/deskshell.ts run photo-sort --root .demo/photo --mode undo
```

Measured on the 12-file fixture: 12 files → 3 month folders (`2026-03`, `2026-04`, `2026-05`) → undo restores 12 files and removes all month folders. Non-image files are never touched.

## 3. Archive logs older than 30 days

```bash
node bin/deskshell.ts run log-archive --root .demo/logs --mode preview
node bin/deskshell.ts run log-archive --root .demo/logs --mode apply
```

Files land in `archive/YYYY-MM/`. Nothing is deleted — archiving is a move, so undo is a move back. The skill accepts `--now` and `--max-age-days` when you drive it from code.

## 4. Rename a batch without ever overwriting

```bash
node bin/deskshell.ts run rename-batch --root .demo/photos --mode preview
```

`IMG_9.jpg, IMG_10.jpg, IMG_2.jpg` become `trip-001.jpg … trip-003.jpg` — sorted, zero-padded, extension preserved.

The interesting part is the failure case: if `trip-002.jpg` already exists, the step fails its `path.absent` pre-assertion, the run stops, and the earlier renames roll back. **Renaming never silently overwrites**, and a failed batch leaves the folder exactly as it was.

## 5. See what 1000 files cost

```bash
node scripts/bench.ts 1000
```

Measured on this Windows machine (Node 24.21.0):

```
files             1000
plan              44 ms   (1002 steps)
apply             737 ms  (0.7 ms/step)
undo              727 ms  (rolled back 1002 steps)
journal           387 KB  (396 B/step)
heap growth       7 MB
```

The numbers that matter: **0.7 ms per step**, and the journal costs under 400 bytes per step — so an audit trail stays cheap even at thousands of actions.

Scaling check — 5000 files, same machine:

```
files             5000
plan              167 ms  (5002 steps)
apply             3770 ms (0.8 ms/step)
undo              3436 ms (rolled back 5002 steps)
journal           2071 KB (424 B/step)
heap growth       25 MB
```

Cost stays linear: 0.7–0.8 ms per step at both 1000 and 5000 files, and the journal grows by roughly 400 bytes per step.

## 6. Deduplicate by content

```bash
node bin/deskshell.ts run dedupe-folders --root .\photos --mode preview
```

Files are grouped by sha256 (first 8 MiB + size), the **oldest copy is kept**, every later duplicate moves into `.trash/`. Undo puts them all back — `.trash` is a real move, not a delete.

## 7. File screenshots by date

```bash
node bin/deskshell.ts run screenshot-organize --root .\Pictures\Screenshots --mode apply
```

`Screenshot 2026-03-04 at 10.11.12.png` becomes `2026/03/20260304-1011-Screenshot ....png`. Only files whose name contains `screenshot` / `截图` / `snipaste` are touched; other images stay put.

## 8. Mirror a folder

```bash
node bin/deskshell.ts run sync-mirror --root .uild --mode preview     # src -> mirror
```

Missing or changed text files are written, extras in the destination move into `.trash`, binary files are skipped by design (`fs.write` carries text). Undo restores every file's previous content.

## Writing your own

```bash
node scripts/new-skill.ts --name my-skill
node bin/deskshell.ts run my-skill --mode preview
```

Then read [Writing a skill](writing-a-skill.html). The three rules — post-assertion, undo, no system calls — are what make these recipes safe to run twice.
