<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Protocol v0

Five types. Everything else — skills, drivers, UI — is built around them.

## 1. Capability

```ts
interface CapabilityRequest {
  id: "fs.read" | "fs.write" | "fs.delete" | "ui.read" | "ui.input" | "process.exec" | "net.http";
  scope?: string;   // a path root for fs.*, an app identifier for ui.*
  reason: string;   // plain language, shown to the user as-is
}
```

Rules:

- Every declared capability must be granted, or the whole task is rejected;
- `fs.*` scopes must resolve inside the task root;
- An action must be covered by a declared capability: `ui.click` requires `ui.input`, file actions require `fs.write`.

## 2. Action

```ts
type Action =
  | { kind: "fs.mkdir"; path: string }
  | { kind: "fs.move"; from: string; to: string }
  | { kind: "fs.delete"; path: string }
  | { kind: "fs.write"; path: string; content: string }
  | { kind: "ui.invoke"; window: string; selector: UiSelector }
  | { kind: "ui.click"; window: string; selector: UiSelector }
  | { kind: "ui.type"; window: string; selector: UiSelector; text: string }
  | { kind: "window.move"; window: string; rect: Rect };
```

Every action also carries:

```ts
{
  id: string;                // stable identifier, used in the journal
  risk?: "low" | "medium" | "high";
  pre?: Assertion[];         // must hold before execution
  post?: Assertion[];        // must hold after; enforced by the kernel
  undo?: UndoAction | null;  // null = not undoable → rejected
}
```

## 3. Assertion

```ts
type Assertion =
  | { kind: "path.exists"; path: string }
  | { kind: "path.absent"; path: string }
  | { kind: "file.count"; dir: string; equals: number }
  | { kind: "ui.value"; window: string; selector: UiSelector; equals: string }
  | { kind: "window.rect"; window: string; rect: Rect; tolerance?: number }
  | { kind: "window.exists"; window: string; timeoutMs?: number }
  | { kind: "ui.exists"; window: string; selector: UiSelector };
```

Assertions are the antidote to "I think it worked". File assertions are checked synchronously; UI assertions call the driver, so the kernel awaits them in order and stops on the first failure.

## 4. UndoAction

```ts
type UndoAction =
  | { kind: "fs.move"; from: string; to: string }
  | { kind: "fs.rmdir"; path: string }
  | { kind: "fs.restore"; path: string; content: string | null }
  | { kind: "window.move"; window: string; rect: Rect }
  | { kind: "noop" };
```

`fs.restore` with `content: null` means "this file was created by the task; undoing means deleting it".

## 5. Journal

```ts
interface JournalEntry {
  ts: number;
  taskId: string;
  actionId: string;
  kind: string;
  summary: string;                                    // human-readable
  status: "ok" | "rolled-back" | "failed";
  detail?: string;                                    // failure reason
  undo?: UndoAction;
}
```

JSONL, one object per line, at `<root>/.deskshell/journal.jsonl`.

Conventions:

- append-only; the only rewrite is marking entries `rolled-back` after an undo;
- `taskId` groups one `run()`; ordering across tasks is by the smallest `ts`;
- failures are recorded too (`status: "failed"` + `detail`) — "what happened" must not live only in terminal output;
- entries without `undo` are skipped during undo rather than treated as errors;
- undoing the same task twice is idempotent: the second attempt finds no `ok` entries and returns 0 steps.

## Manifest

```json
{
  "name": "downloads-cleanup",
  "version": "0.1.0",
  "description": "Sort a downloads folder by file type",
  "entry": "./index.ts",
  "internal": false,
  "platforms": ["win32", "darwin"],
  "capabilities": [{ "id": "fs.write", "scope": "{{root}}", "reason": "move files" }]
}
```

- `name` must match `^[a-z0-9][a-z0-9-]*$`;
- `internal: true` hides a skill from `deskshell list` (test fixtures);
- `platforms` defaults to all; declaring it marks the skill unavailable elsewhere;
- full JSON Schema: `schema/skill.schema.json`; `deskshell add` validates against the same rules.

## Kernel flow

```
check capabilities → plan → check every action (scope / undoability)
      → preview: print only
      → apply:   execute → post-assertion → journal
                 on failure: undo the failing action, then roll back done steps in reverse
      → undo:    read journal → replay undos → mark rolled-back
```

## Invariants

1. No action may escape the task root.
2. Every action must be undoable, unless the user explicitly confirms otherwise.
3. Any failure rolls the task back to its starting state.
4. The kernel has no model dependency; models only live inside skills.
5. An action must be covered by a declared capability — declarations are enforced, not decorative.
