<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# FAQ

## Is this an agent?

No. There is no model in the kernel. deskshell is the part that executes actions safely — preview, verify, undo, audit. A model can sit above it and produce plans; the kernel does not care where the plan came from.

## Why not just let an agent drive the mouse directly?

Because nobody can audit it. With deskshell every action has a declared capability, a post-assertion, and an undo. When something goes wrong you can say exactly which step failed and put the machine back.

## Does it work without Node 22.18+?

No. The CLI runs TypeScript directly, and type stripping is only unflagged from Node 22.18 (or 23.6). `engines` says exactly that.

## What happens when a step fails?

The run stops. The failing action's own side effects are undone (only if it actually executed), then every completed step rolls back in reverse. The journal records the failure with its reason. There is no half-changed state.

## Can a skill delete my files?

`fs.delete` exists, but an action with `undo: null` is rejected by the kernel. Deletion is normally expressed as "move into `.trash`", which is undoable. If a skill asks for `fs.write` and you grant it, it can move your files — that is the point of the tool.

## Can a skill escape the folder I gave it?

It should not. Paths are checked twice: lexically (`..` is rejected) and by real path (a symlink or junction inside the root that points outside is rejected). There is a contract test named `symlink.escape` that creates a junction to an outside directory and asserts the write is refused.

## Is the recorder a macro recorder?

No. It samples focus, clicks, and new windows, then emits a skill draft with inferred assertions. Click assertions are left empty on purpose — only a human knows what "that click worked" means.

## Why is `deskshell` published as `@ciceroyang/deskshell`?

Because npmjs.com is unreachable from some networks (the website returns 403 while the registry API works), so the public unscoped package cannot be published yet. GitHub Packages works today. When the npm token becomes available, `deskshell` will be published unscoped as well.

## Does undo work across restarts?

Yes. Undo reads the JSONL journal on disk, not memory. `deskshell undo --task <id>` is idempotent: running it twice rolls back nothing the second time.

## What is not covered yet?

- No Linux driver (AT-SPI2) yet.
- macOS: coordinate clicks are implemented and verified, but dragging and right-click menus are not.
- Recorder polls at 300 ms and captures left clicks only.
- External side effects (HTTP calls, sent mail) cannot be undone; such actions must be marked and are rejected by default.

## How do I verify claims in the docs?

Every capability in [STATUS.md](https://github.com/ciceroyang/deskshell/blob/main/STATUS.md) is paired with a command and its real output, and `node scripts/regress.ts` runs 24 checks including contract, snapshot, benchmark and the three new skills.
