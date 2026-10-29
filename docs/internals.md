<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Internals

How the pieces actually fit together, and which rules are enforced where. Written for people who will extend this, not just run it.

## The whole flow

```
skill.plan(input, ctx) → Action[]          pure description, no side effects
        ↓
checkCapabilities(caps, granted, root)     every declared capability must be granted
        ↓
checkAction(action, root, ids, caps)       per action: path escapes, ui scope, undoability
        ↓
preview  ─ print and stop
apply    ─ for each action: pre-assertions → execute → post-assertions → journal
undo     ─ read journal → replay undos in reverse → mark rolled-back
```

Everything above is synchronous filesystem work plus driver calls. There is no scheduler, no retry loop, and no model.

## What the policy layer checks

| Check | Where | What it prevents |
| --- | --- | --- |
| Capability granted | `checkCapabilities` | running with permissions the user never gave |
| `fs.*` scope inside root | `checkCapabilities` | a skill claiming `C:\` as its scope |
| Action covered by a declared capability | `checkAction` | declaring `ui.read` and then clicking |
| Path inside root (lexical) | `checkAction` → `isInside` | `..` traversal, absolute paths |
| Path inside root (real) | `checkAction` → `isInsideReal` | a junction or symlink inside the root pointing outside |
| Window inside declared scope | `checkAction` | declaring "Notepad" and driving "Calculator" |
| Action undoable | `checkAction` | `fs.delete` with `undo: null` |

The real-path check resolves the nearest existing ancestor, so a target that does not exist yet is still checked through its parent. For `fs.move` sources it only checks the parent — moving a shortcut itself is legitimate.

## Failure semantics

When an action fails, the kernel:

1. records the failure in the journal (`status: "failed"` + `detail`);
2. un-does the failing action's own effect, but **only if execution actually started** and the effect is verifiably present (`selfUndoSafe`) — this avoids the classic "pre-assertion failed, then undo moved someone else's file away" bug;
3. rolls back every completed step in reverse order;
4. marks exactly the steps that were successfully undone as `rolled-back`.

If an undo itself fails (for example the file changed), that step stays un-rolled-back in the journal. The journal never claims a rollback that did not happen.

## The journal is the source of truth

`<root>/.deskshell/journal.jsonl`, one JSON object per line:

```json
{"ts":1793281142815,"taskId":"task-1793281142815","skill":"photo-sort","actionId":"move:IMG_0001.jpg",
 "kind":"fs.move","summary":"move IMG_0001.jpg → …/2026-03/IMG_0001.jpg","status":"ok",
 "undo":{"kind":"fs.move","from":"…/2026-03/IMG_0001.jpg","to":"…/IMG_0001.jpg"}}
```

- `taskId` groups one `run()` invocation;
- `skill` makes `deskshell history` readable;
- `hash` appears on `fs.write` steps: the sha256 of what was written. Undo refuses to overwrite a file whose current hash differs, so a human edit after the fact is never silently destroyed.
- `status` is `ok`, `failed`, or `rolled-back`.

`deskshell history` summarises tasks; `deskshell show <taskId>` prints the timeline of one.

## Parallel runs

`deskshell run a b c --parallel` executes the skills concurrently in one process. Each skill keeps its own plan and context; they share the journal. Journal writes are synchronous, so appends cannot interleave in a way that loses lines, and `markRolledBack` does its read-modify-write in a single tick.

One skill failing exits non-zero for the CLI but does **not** stop the others — verified by a test that runs a deliberately failing skill next to `photo-sort`.

## Where skills live

1. `packages/skills/` — built in, ships with the package;
2. `~/.deskshell/skills/` (or `$DESKSHELL_SKILLS_DIR`) — installed via `deskshell add`.

The user directory wins on name collisions, and it survives upgrades because it is outside the package.

## Extension points

- **A new skill** — one directory, `skill.json` + `index.ts`, `plan()` only.
- **A new driver** — implement `UiDriver`, pass the 13 contract tests; the kernel stays unchanged.
- **A model** — sits above `plan()`. It may produce actions through the same policy checks; nothing in the kernel imports a model.

## What is deliberately missing

No scheduler, no queue, no daemon, no database, no plugin sandbox. Every one of those would be a new failure surface before the basics are proven. The journal plus the undo stack is enough to run, explain, and reverse a task — that is the whole promise.
