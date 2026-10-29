<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Roadmap

Split by "does this need a decision from the owner". Everything above is shipped; everything below waits.

## Shipped (0.1.0)

| Capability | Status |
| --- | --- |
| Protocol v0 (capability / action / assertion / undo / journal) | done |
| Kernel: preview, apply, assertions, rollback, audit | done |
| Windows UIA driver | done, verified |
| macOS Swift AX bridge | done, verified on hardware |
| Mock driver + 11 contract tests | done |
| 4 usable skills | done |
| Recorder (focus / click / window-open) + draft generator | done |
| 9 CLI commands | done |
| Docs site (EN + zh-CN) + JSON Schema | done |
| 22-check regression suite | done |

## Next (no decision needed)

**Protocol**
- interactive capability consent in the terminal (y/n per capability, instead of `--grant`)
- per-action dry-run diffs ("these 312 files would become this")
- a timeline view of the undo stack (roll back to a point in time)

**Drivers**
- Linux AT-SPI2 driver
- coordinate mapping across multiple displays and DPI scaling

**Recorder**
- UIA event hooks instead of polling
- drag, right-click menus, wheel
- infer `window.rect` assertions from recordings (geometry changes are another "the click worked" signal)

**Engineering**
- `deskshell run --parallel` (independent journals per skill)
- random fault injection on top of `--fail-at`, to shake out flakiness
- search in the docs site

## Needs a decision

| Item | What you need to decide |
| --- | --- |
| Public repository | which account/org, repository name, when to publish |
| Cross-platform investment | fund the Swift AX work and a Linux driver, or stay Windows-first |
| Product scope | keep building tools, or start the desktop shell (global hotkey + overlay) |
| Safety policy | where the "block dangerous actions" line sits; network egress allowlist? |
| Model integration | ship an optional "natural language → plan" plugin (kernel stays dependency-free) |
| Packaging | publish to npm / Homebrew, or keep "clone and run" |
