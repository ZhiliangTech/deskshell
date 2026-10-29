# CHANGELOG

This project follows semantic versioning. During `0.x`, breaking changes are listed here with migration notes.

## 0.2.0 — 2026-10-29

The "make it a real project" release: bilingual docs, brand, packaging, and macOS click parity.

### Added

- **Docs site is now bilingual**, English first: `docs/*.md` (10 pages, including a generated Skills catalog) and `docs/zh-CN/*.md`. Every page carries a language switch; `site/index.html` redirects to `/en/`.
- **Generated Skills page** — built from `packages/skills/*/skill.json` (name, version, description, capabilities with reasons, platforms). Internal test fixtures are hidden but counted.
- **Sidebar search** on the docs site — 18 lines of vanilla JS, no dependencies.
- **macOS coordinate clicks** — `MacDriver.clickAt(x, y)` posts CGEvent mouse events; `click()` now falls back to clicking the element's centre when AXPress is refused. Verified on hardware: Calculator `7 × 8 = 56` via coordinate clicks, plus a fallback case where AXPress is rejected and the synthetic click still lands on centre.
- **Packaging** — `files` allowlist, `repository`/`homepage`/`bugs`, `publishConfig.access: public`, and `bin/deskshell.mjs`, a launcher that works around Node's refusal to strip types under `node_modules`. `npm pack`: 47 files, 46 kB.
- **Community files** — `SECURITY.md` (scope statement: an agent deleting files after `fs.write` is granted is expected behaviour, not a vulnerability), `CODE_OF_CONDUCT.md`, `.editorconfig`, Dependabot config.
- **CI matrix** — Node 22 and 24, `cancel-in-progress` concurrency, 10-minute timeout, read-only permissions.

### Changed

- `engines` is now truthful: `>=22.18.0 <23.0.0 || >=23.6.0` (type stripping is unflagged only from those versions).
- README (EN and zh-CN) gained an Install section and dropped the "no coordinate clicks on macOS" limitation.

### Fixed

- Docs described macOS coordinate clicks as unimplemented long after the bridge shipped `click --x --y`.

### Known limits

- No Linux driver (AT-SPI2) yet.
- Recorder polls at 300 ms and captures left clicks only.
- `deskshell add` installs into the runtime mirror when run from an installed package, not into the project directory.

## 0.1.0 — 2026-10-29

First usable version: protocol v0 + kernel + drivers + CLI + docs + regression suite.

### Protocol v0

- Capabilities (scope + plain-language reason); an ungranted capability rejects the whole task.
- Actions: `fs.mkdir` / `fs.move` / `fs.delete` / `fs.write` / `ui.invoke` / `ui.click` / `ui.type` / `window.move`.
- Assertions: `path.exists` / `path.absent` / `file.count` / `ui.value` / `window.rect` / `window.exists` / `ui.exists`.
- Undo: `fs.move` / `fs.rmdir` / `fs.restore` / `window.move` / `noop`.
- Journal: append-only JSONL with `ok` / `rolled-back` / `failed`.
- Invariants: no path escape, every action undoable, failure rolls back, zero model dependency, every action covered by a declared capability.

### Kernel

- `preview / apply / undo / undoAll / undoTask`.
- On failure: undo the failing action's own side effects first, then roll back completed steps in reverse.
- Failures are recorded in the journal (`status: "failed"` + `detail`).

### Drivers

- Windows: UIA control tree, ValuePattern, Invoke/Select, coordinate click, window geometry, `WH_MOUSE_LL` click capture.
- macOS: native Swift AX bridge (36 ms window enumeration), control tree, focus, Unicode typing, AXPress, window move; `osascript` fallback when the bridge is absent.
- Mock: in-memory driver behind 11 contract tests.

### Skills and tools

- `downloads-cleanup`, `browser-tabs`, `tile-windows`, plus a scaffold example.
- Recorder: focus + mouse clicks + window-open events → draft skills with inferred assertions.
- `deskshell` CLI: `list / run / story / journal / undo / add / verify / doctor / version`.
- Docs site, JSON Schema, preview snapshots, 22-check regression suite.

### Known limits

- macOS driver was unverified at release time.
- Linux driver not implemented.
- Recorder polls at 300 ms; left clicks only.
- Undo covers files and window geometry; external side effects are rejected (`undo: null`).
