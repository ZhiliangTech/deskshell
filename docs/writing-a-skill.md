<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Writing a skill

A skill is a directory: `skill.json` + `index.ts`. The only function that matters is `plan()`.

## Minimal template

```ts
import type { Action, Skill } from "../../core/src/types.ts";

export const skill: Skill = {
  manifest: {
    name: "hello-move",
    version: "0.1.0",
    description: "Move a.txt into docs/",
    entry: "./index.ts",
    capabilities: [
      { id: "fs.write", scope: "{{root}}", reason: "move a file inside the root" },
    ],
  },
  async plan({ root }) {
    return [
      {
        id: "mkdir:docs",
        kind: "fs.mkdir",
        path: `${root}/docs`,
        risk: "low",
        undo: { kind: "fs.rmdir", path: `${root}/docs` },
      },
      {
        id: "move:a",
        kind: "fs.move",
        from: `${root}/a.txt`,
        to: `${root}/docs/a.txt`,
        risk: "low",
        pre: [{ kind: "path.exists", path: `${root}/a.txt` }],
        post: [{ kind: "path.exists", path: `${root}/docs/a.txt` }],
        undo: { kind: "fs.move", from: `${root}/docs/a.txt`, to: `${root}/a.txt` },
      },
    ];
  },
};
```

## Three hard rules

**Every action needs a post-assertion.** Not "it didn't throw" — "the target state actually holds".

**Every action needs an undo.** If something can be changed, it can be reverted. Deletions should be expressed as "move into a trash folder", not `fs.delete`.

**Never touch system APIs.** No `fs.writeFileSync`, no `child_process`, no UIA inside a skill. Produce `Action`s and let the kernel execute them.

## Reading the screen

`plan(input, ctx)` receives a context with `ctx.driver`:

```ts
async plan({ root }, ctx) {
  const tree = await ctx.driver!.tree({ titleRegex: "Edge" }, 8);
  const tabs = walk(tree).filter((n) => n.controlType === "TabItem");
  // turn the observation into Actions
}
```

Observation is read-only and produces no side effects. Every mutation must come back as an `Action`.

## Platform gating

```json
{ "platforms": ["win32"] }
```

Omitting it means all platforms. Declaring it makes `deskshell list` mark the skill unavailable elsewhere — better than failing at runtime.

## Common mistakes

- **pre without post**: the failure surfaces downstream, and you can't tell which step broke.
- **`undo: null`**: the kernel rejects the action. This is intentional.
- **relative paths**: always use `path.join(input.root, ...)`, and never escape the root.
- **side effects inside `plan()`**: plan runs twice (preview + apply); any write happens twice.

## Debugging

```bash
node bin/deskshell.ts run my-skill --mode preview
```

Preview prints `risk` and `undoable` per step — the fastest self-check you have.
