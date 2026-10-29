# CHANGELOG

This project follows semantic versioning. During `0.x`, breaking changes are listed here with migration notes.

## 0.5.0 — 2026-10-29

Operating a system you can leave running: batch undo, a journal that survives growth, previews that state the cost, and a recorder driven by events instead of polling.

### Added

- **`deskshell undo --last N` / `--since 30m|2h|1d`** — batch undo, newest first. One line per task, one exit code; a failed undo stops that task only.
- **Journal rotation** — past 5 MiB the journal becomes `journal-<timestamp>.jsonl` and a fresh one starts. `load()` reads rotated files plus the current one in time order; undo rewrites only the file holding the affected entries, so statuses stay right without duplicating rows. Override with `DESKSHELL_JOURNAL_MAX_BYTES`.
- **Preview summary** — before touching anything, `run` prints what the plan costs:

  ```
  汇总：新建 3 · 移动 10 ｜ 可撤销 13/13 ｜ 风险 low 13 / medium 0 / high 0
  ```

  Non-undoable steps are counted and warned about separately. Available as `summary` in `--json`.
- **Recorder is event-driven** — focus comes from `AddAutomationFocusChangedEventHandler`, window opens from `AddStructureChangedEventHandler`, clicks from the existing `WH_MOUSE_LL` hook, all pumped through `Application.DoEvents()`. A 15-second session produced 8 meaningful events where polling emitted ~50 duplicate focus rows. `-Poll` forces the old behaviour, and event-registration failure falls back automatically.
- **Draft skills get a real window scope** — the generator now writes the recorded window names (e.g. `Notepad`) instead of the `recorded` placeholder, so a draft actually passes the policy layer and can be previewed.

### Fixed

- Recorder `.ps1` files are written as UTF-8 **with BOM**; PowerShell 5.1 reads BOM-less scripts as ANSI, which silently corrupted non-ASCII comments and produced parser errors.
- Duplicate window-open rows: structure events fire several times per window, now de-duplicated by title + pid.

### Evidence

- `scripts/regress.ts` → 33 checks
- undo range 6/6 · journal rotation 7/7 · preview summary 9/9 · recorder modes 8/8
- Real session: 15 s recording → 8 events (5 focus / 3 window-open) → 2 clicks → draft with 2 steps → `--mode preview` accepted

## 0.4.0 — 2026-10-29

Hardening the guarantees, plus the operational surface a real user needs.

### Security

- **UI window scope is enforced.** A skill declaring `ui.input` with scope `Notepad` can no longer drive `Calculator`; `checkAction` now matches the action's window against the declared scope (regex, case-insensitive). Contract test `ui.scope` covers both the denial and the allowed case.
- **Undo refuses to overwrite a file that changed.** `fs.write` steps record the sha256 of what was written; undo compares it and refuses when the file was edited afterwards. Contract-level test `undo-guard` also asserts the journal does not lie: a refused undo is not marked `rolled-back`.
- **Property-based path tests.** `scripts/policy-fuzz.ts` generates 2000 adversarial paths plus 10 known vectors (`C:\Windows`, UNC, `/etc/passwd`, `..`, mixed separators) and asserts every escape is rejected, while 500 legitimate paths still pass.

### Added

- **`deskshell run a b c --parallel`** — concurrent skills, shared journal, one failure does not stop the others. `scripts/parallel-test.ts` proves both the happy path and failure isolation.
- **`deskshell history`** — task list with skill, step count, duration and state.
- **`deskshell show [taskId]`** — full timeline of one task, including each step's undo kind.
- **Journal entries carry `skill` and `hash`**, so history is readable and undo can detect external edits.
- **`deskshell add` installs into `~/.deskshell/skills`** (override with `$DESKSHELL_SKILLS_DIR`), outside the package, so upgrades no longer reset user skills. Same name in the user directory wins over the built-in one.
- **Docs**: new `internals` page (kernel flow, policy table, failure semantics, journal schema, parallel model), macOS bridge command list on the drivers page, and a 5000-file benchmark section. 13 pages per language.

### Fixed

- `undoLastTask` marked **every** entry of the task as `rolled-back` even when an undo failed; it now marks only the steps that actually rolled back. Same bug class as the 0.3.0 self-undo fix: the journal must never report a rollback that did not happen.

### Changed

- Fixture skills declare real window scopes (`Notepad|记事本`, `Edge|Chrome|…`) instead of placeholders, because placeholders are now rejected — which is the point.

### Evidence

- `scripts/regress.ts` → 29 checks green
- contract 13/13 · snapshots 3/3 · parallel 7/7 · policy fuzz 5/5 · undo guard 3/3
- benchmark: 1000 files 0.7–0.9 ms/step; 5000 files 0.8 ms/step, journal 424 B/step

## 0.3.0 — 2026-10-29

Hardening and reach: symlink escapes are blocked, three new skills ship with tests, and the kernel gets a performance baseline.

### Security

- **Symlink / junction escape is now rejected.** Path checks run twice: lexically (`..` rejected) and by real path. A junction or symlink inside the task root that points outside is refused before execution. `isInsideReal()` resolves the nearest existing ancestor, so the target does not need to exist to be checked.
- New contract test `symlink.escape` creates a junction to an outside directory, attempts a write, and asserts both refusal and that nothing leaked outside.

### Fixed

- **A failing action no longer destroys neighbouring data.** The kernel used to run the failing action's own undo unconditionally. When the failure happened at the pre-assertion stage, that undo (`move(to → from)`) would move a pre-existing destination file out of the way — data loss. Now self-undo only runs when the action actually entered its execution phase, and only when its effect is verifiably present (`selfUndoSafe`). Covered by `rename-batch` collision test.

### Added — three skills

- **`photo-sort`** — archives images into `YYYY-MM` folders by mtime (no EXIF dependency). 12-file fixture: 3 month folders, undo restores all 12 and removes the folders. Snapshot included.
- **`log-archive`** — moves `.log` files older than 30 days into `archive/YYYY-MM/`; nothing is deleted. Supports `now` / `maxAgeDays` for deterministic runs.
- **`rename-batch`** — zero-padded sequential renames with a `path.absent` pre-assertion, so a name collision fails the batch and rolls it back instead of overwriting.

### Added — tooling and docs

- **`scripts/bench.ts`** — 1000-file benchmark. Measured: plan 44 ms (1002 steps), apply 737 ms (0.7 ms/step), undo 727 ms, journal 387 KB (396 B/step), heap +7 MB.
- **Docs**: `recipes` page (five runnable scenarios with real output) and `faq` page, in English with Chinese mirrors. Docs site is now 12 pages per language.
- `scripts/photo-sort-test.ts`, `scripts/new-skills-test.ts` (8 assertions), `scripts/make-photo-fixture.ts` wired into the regression suite — now **24 checks**.

## 0.2.0 — 2026-10-29

The "make it a real project" release: bilingual docs, brand, packaging, and macOS click parity.

### Added

- **Docs site is now bilingual**, English first: `docs/*.md` (10 pages, including a generated Skills catalog) and `docs/zh-CN/*.md`. Every page carries a language switch; `site/index.html` redirects to `/en/`.
- **Generated Skills page** — built from `packages/skills/*/skill.json` (name, version, description, capabilities with reasons, platforms). Internal test fixtures are hidden but counted.
- **Sidebar search** on the docs site — 18 lines of vanilla JS, no dependencies.
- **macOS coordinate clicks** — `MacDriver.clickAt(x, y)` posts CGEvent mouse events; `click()` now falls back to clicking the element's centre when AXPress is refused. Verified on hardware: Calculator `7 × 8 = 56` via coordinate clicks, plus a fallback case where AXPress is rejected and the synthetic click still lands on centre.
- **Packaging** — scoped name `@ciceroyang/deskshell`, `files` allowlist, `repository`/`homepage`/`bugs`, `bin/deskshell.mjs`, a launcher that works around Node's refusal to strip types under `node_modules`. `npm pack`: 47 files, 46 kB.
- **Community files** — `SECURITY.md` (scope statement: an agent deleting files after `fs.write` is granted is expected behaviour, not a vulnerability), `CODE_OF_CONDUCT.md`, `.editorconfig`, Dependabot config.
- **Distribution channels** — published to GitHub Packages (`@ciceroyang/deskshell@0.2.0`, verified by a real `npm install` + `deskshell version`), and a release tarball for auth-free installs. npmjs.com is unreachable from some networks (website 403, registry API fine), so the public registry publish is pending a token.
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
