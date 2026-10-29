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

## Known boundaries

- external side effects cannot be undone (an HTTP request already left); such actions are `undo: null` and rejected;
- if a file changes underneath during undo, `fs.restore` overwrites it — that needs explicit confirmation;
- cross-volume moves are not atomic on every platform; the journal is what makes retries possible.
