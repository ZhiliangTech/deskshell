<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Protocol v0

Five types. Everything else — skills, drivers, UI — is built around them.

### `irreversible`

Some actions cannot be undone — a pressed button stays pressed. Rather than pretending, an action can say so:

```ts
{ id: "submit", kind: "ui.invoke", window: "Form", selector: { name: "OK" }, irreversible: true }
```

The kernel then:

1. counts it in `preview.summary.irreversible`;
2. **refuses the whole run** before touching anything, unless the caller confirms with `--allow-irreversible` (CLI) or `allowIrreversible: true` (MCP).

Omitting `undo` or setting it to `null` has the same confirmation requirement. An explicit `irreversible: true` takes precedence even if an `undo` is supplied: that action is not recorded as undoable. `fs.delete` is stricter and always rejects a missing or null `undo`; confirmation does not bypass that policy.

This is a hard gate, not a warning: the point of an audit trail is that the one action you cannot take back was explicitly approved first.

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
- An action must be covered by a declared capability: `ui.click` requires `ui.input`, file actions require `fs.write`. An empty capability list grants no exemption.

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
  post?: Assertion[];        // supplied assertions must hold after execution
  undo?: UndoAction | null;  // absent/null = not undoable → confirmation required
  irreversible?: boolean;   // explicitly non-undoable, even if undo is supplied
}
```

Protocol v0 keeps `post` and `undo` optional for compatibility. Authors should provide a meaningful `post` for every action; the kernel checks supplied assertions but does not require a nonempty list. Missing `undo` is handled by the confirmation policy above.

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

`fs.restore` with `content: null` means "this file was created by the task; undoing means deleting it". It also removes empty parent directories created by that write, preserving pre-existing directories and directories containing other files.

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
- entries without `undo` produce a failed undo step, remain un-rolled-back, and do not contribute to `rolledBack`;
- after every step of a task has been successfully undone, repeating undo returns 0 steps; failed or non-undoable entries remain visible on later attempts.

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
3. On failure, the kernel attempts to restore the starting state, continues past individual undo failures, and reports incomplete recovery. Only successful undos are marked `rolled-back`; confirmed irreversible actions cannot be restored.
4. The kernel has no model dependency; models only live inside skills.
5. An action must be covered by a declared capability — declarations are enforced, not decorative.
