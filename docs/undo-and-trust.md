<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Undo and trust

The hard part of this project is not "can it operate the computer". It is "after it operates, would anyone dare use it again". Undo is the foundation of that.

## What undo means

Undo is not "run something roughly opposite". It is **restoring the exact state before the task started**.

- move: move it back, and refuse to overwrite an existing file;
- mkdir: remove the directory, only if empty;
- write: delete the file if it did not exist; otherwise write the previous content back;
- actions with external effects (send email, call an API, hard delete): marked `undo: null` and rejected by the kernel.

## Failure rolls back

When any step fails, the kernel:

1. stops the remaining steps;
2. **undoes the failing action's own side effects** (a file written before its assertion failed must disappear);
3. rolls back the successful steps in reverse order;
4. marks them `rolled-back` in the journal;
5. returns the failure reason.

Step 2 fixed a real bug in v0.1: originally only "previously successful steps" were rolled back, so "write file, then fail an assertion" left an orphan file — and that orphan then blocked removal of its parent directory with `ENOTEMPTY`.

The guarantee: a task either completes fully, or returns to its starting point. There is no "half-changed" state.

Watch it happen:

```bash
node bin/deskshell.ts story --fail
```

```
✓ 1-write-a
✓ 2-mkdir-sub
✗ 3-write-b-assert-must-fail   post assertion failed: ...
3 steps rolled back (including the failing action's own side effects); leftovers: 0
```

## Why undo lives in the kernel

If every skill implemented its own rollback, some would forget, some would get it wrong, and some would cheat.

In the kernel:

- skill authors only declare `undo`, they don't write rollback code;
- rollback logic exists once and is shared by every skill;
- the journal already records everything needed to undo — no extra instrumentation.

## Permission boundaries

- capabilities must be declared, justified, and scoped;
- an ungranted capability rejects the whole task (not "skip that step");
- authorization is per task, not permanent.

## The journal

Every run appends JSONL:

```json
{"ts":1793201985000,"taskId":"task-1793201984999","actionId":"move:a","kind":"fs.move","summary":"move a.txt → .../docs/a.txt","status":"ok","undo":{"kind":"fs.move","from":".../docs/a.txt","to":".../a.txt"}}
```

It serves three audiences: users asking "what did it actually do", developers asking "which step broke", auditors asking "who changed what, and when".


## Batch undo

```bash
deskshell undo --task <taskId>     # one task
deskshell undo --last 3            # the 3 most recent tasks
deskshell undo --since 30m         # everything started in the last 30 minutes (30m / 2h / 1d)
```

Batch modes undo newest-first and print one line per task. If an undo fails — for example a file changed — that task stays un-rolled-back, the others still roll back, and the exit code is non-zero. Partial success is reported, never hidden.

## When the file changed since

Every `fs.write` step records the sha256 of what it wrote. Before restoring, undo compares that hash with the file on disk:

```
✗ write-note 文件在任务之后被修改，拒绝覆盖：…/note.txt（可用 deskshell undo --force 强制）
```

The refused step is **not** marked `rolled-back` in the journal — the audit trail never claims a rollback that did not happen. Restoring someone's newer content over their edit is the kind of silent data loss this guard exists to prevent.

## Long-lived journals

The journal grows by roughly 400 bytes per step (measured: 387 KB for 1000 steps). When the file passes 5 MiB it is renamed to `journal-<timestamp>.jsonl` and a fresh one starts.

- `load()` reads every rotated file plus the current one, sorted by time;
- undo rewrites only the file that contains the affected entries, so statuses stay consistent without duplicating rows;
- `DESKSHELL_JOURNAL_MAX_BYTES` overrides the threshold (tests use 600 bytes).

## Undo coverage, measured

`scripts/undo-coverage-test.ts` snapshots a directory (every path plus a sha256 per file, `.deskshell/` excluded), applies a skill, undoes it, and compares the two snapshots **byte for byte**. Current result:

```
PASS  downloads-cleanup  10 步 · 撤销 10 步 · 逐字节一致
PASS  photo-sort         13 步 · 撤销 13 步 · 逐字节一致
PASS  log-archive         5 步 · 撤销  5 步 · 逐字节一致
PASS  rename-batch        3 步 · 撤销  3 步 · 逐字节一致
PASS  first-skill         1 步 · 撤销  1 步 · 逐字节一致
SKIP  browser-tabs        needs a real browser window (GUI)
SKIP  tile-windows        needs real windows (GUI)
```

GUI skills are skipped **with a reason in the output**, never silently — a skipped test that pretends to pass is worse than no test.

## Confirming capabilities one by one

`deskshell run <skill> --ask` asks before anything runs:

```
授予能力 fs.read（读取下载目录）？[y/N] y
授予能力 fs.write（移动与写入）？[y/N] y
```

Any `n` cancels the whole task with exit code 2 and **no side effects** — no journal entry, no file touched. Piped stdin works too (one `y`/`n` per line), which is how CI tests it; empty input counts as a refusal.

## Known boundaries

- external side effects cannot be undone (an HTTP request already left); such actions are `undo: null` and rejected;
- if a file changes underneath during undo, `fs.restore` overwrites it — that needs explicit confirmation;
- cross-volume moves are not atomic on every platform; the journal is what makes retries possible.
