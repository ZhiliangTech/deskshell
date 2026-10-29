<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Quick start

## Requirements

- Node.js 22+ (verified on Node 24 and 26)
- File-based skills: any platform
- UI-based skills: Windows (UIA) or macOS (AX bridge); on macOS build the bridge first:
  `packages/drivers/macos/build.sh` and grant Terminal accessibility permission.

## 30 seconds: file scenario

```bash
node bin/deskshell.ts doctor
node scripts/make-fixture.ts
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
```

Expected: the preview lists 20 steps; apply moves 13 files into six folders and three duplicates into `.trash`; undo restores all 13 files.

`run` defaults to **preview**. Nothing happens without `--mode apply`.

## 30 seconds: real UI scenario (Windows)

```bash
node apps/cli-demo/ui.ts --root .demo/archive --window Edge --mode preview
node apps/cli-demo/ui.ts --root .demo/archive --window Edge --mode apply
node apps/cli-demo/ui.ts --root .demo/archive --mode undo
```

It reads the tab strip of an Edge window, writes a `tabs-*.md` index, and deleting that file is the undo.

## Watch a failure roll back

```bash
node bin/deskshell.ts story --fail
```

The third step is rigged to fail its assertion. The kernel undoes the failing action's own side effects, then rolls back the two successful steps in reverse, then records the failure in the journal.

## Machine-readable output

```bash
node bin/deskshell.ts run downloads-cleanup --json --mode preview --root .demo/downloads
```

One line of JSON. Exit codes: `0` success, `1` a step failed, `2` policy rejection or bad arguments.

## Permission denial

```bash
node bin/deskshell.ts run downloads-cleanup --mode apply --grant fs.read
```

```
拒绝：未授予能力 fs.write（…）
```

Least privilege is the default: an ungranted capability blocks the whole task before anything runs.
