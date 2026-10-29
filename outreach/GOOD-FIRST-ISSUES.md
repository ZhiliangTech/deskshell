# Good first issues

Twelve tasks that are **already scoped**, **already unblocked**, and **each end with a command you can run to prove you are done**. Nothing here needs a design decision from the maintainer first — that is the point of the list.

Everything below is derived from the gaps recorded in [docs/roadmap.md](../docs/roadmap.md), the honest-limits table in [STATUS.md](../STATUS.md), and the code itself. Where part of a feature already shipped, the task names the shipped part precisely (with the file to prove it) and moves one step further, so you never spend a weekend rebuilding what exists. There is no invented work on this board.

- Repo: `https://github.com/ciceroyang/deskshell` · MIT · Node `>=22.18`
- Zero third-party runtime dependencies — an invariant, not a preference. A PR that adds a dependency needs an RFC first (see [GOVERNANCE.md](GOVERNANCE.md)).
- Protocol v0 is frozen in `spec/protocol-v0.json`. Changing action / assertion / undo semantics needs an RFC. Everything on this board fits inside v0.
- First PR path (under 30 minutes of setup): [CONTRIBUTING.md](../CONTRIBUTING.md) → `node scripts/regress.ts` → pick a task → open a draft PR with the claim comment.

## How to claim

1. Open a `bounty` issue from [.github/ISSUE_TEMPLATE/bounty.yml](../.github/ISSUE_TEMPLATE/bounty.yml) — or comment on the existing issue — and say which task number you are taking.
2. The maintainer replies within **48 h** with a mentor name, confirmation the scope is still free, and any fixture you asked for.
3. Work in a branch. Touch only the files in the task's file list.
4. Open the PR with the acceptance commands and their real output pasted in. Green CI plus pasted output is the whole review bar.

Sizes: **S** = half a day, **M** = 1–3 days, **L** = about a week, for someone who has already run `node scripts/regress.ts` once.

## Index

| # | Task | Labels | Size | Area |
| --- | --- | --- | --- | --- |
| 01 | Linux: AT-SPI2 control-tree backend above the existing window-level driver | `good first issue` `driver` `help wanted` | **L** | driver |
| 02 | Multi-display and DPI coordinate mapping | `bounty` `driver` `help wanted` | **M** | driver |
| 03 | Recorder: right/middle/wheel/drag capture + `window.rect` inference | `bounty` `driver` `recorder` | **M** | driver / recorder |
| 04 | Per-action dry-run diffs (`run --diff`) | `bounty` `kernel` | **M** | kernel |
| 05 | Cross-task undo timeline (`deskshell timeline`) | `good first issue` `kernel` | **M** | kernel / CLI |
| 06 | Remember capability consents (`--ask --remember`) | `good first issue` `kernel` | **S** | kernel |
| 07 | Full-text search in the docs site | `good first issue` `docs` | **M** | docs |
| 08 | Engineering guardrails: kernel `--fail-at`, flake soak, three-platform CI | `good first issue` `testing` `ci` | **M** (part A alone: **S**) | engineering |
| 09 | MCP adapter: expose preview / apply / undo as MCP tools | `bounty` `ecosystem` `mcp` | **M** | ecosystem |
| 10 | New skill: `screenshot-dedupe` | `good first issue` `skill` | **S** | skill |
| 11 | New skill: `browser-download-sort` | `bounty` `skill` | **M** | skill |
| 12 | New skill: `pdf-merge` (zero-dependency) | `bounty` `skill` `hard` | **L** | skill |

---

## 01 — Linux: AT-SPI2 control-tree backend

**Title:** `driver(linux): add an AT-SPI2 control-tree backend for tree() depth and selector-based invoke/click`

**Labels:** `good first issue`, `driver`, `help wanted`, `platform: linux`

**Background.** The window layer is done — do not rebuild it. `packages/drivers/linux/driver.ts` is a working X11 driver over `xdotool` + `wmctrl`: window enumeration with geometry (`xdotool getwindowgeometry --shell`), `type()` / `keys()` via `xdotool type` / `xdotool key`, `moveWindow()` via `windowmove` + `windowsize`, and exported `detect()` / `missingHint()` so a machine without `DISPLAY`, `xdotool` or `wmctrl` gets install instructions instead of a stack trace. `scripts/verify-driver.ts` already has the `linux` branch, and `.github/workflows/ci.yml` already runs `scripts/linux-driver-smoke.ts` under Xvfb.

What it cannot do is controls, and it says so. `tree(ref, depth)` ignores `_depth` and returns exactly two nodes — the window plus one synthetic `X11Content` pane. `invoke()` and `click()` call `this.unsupported()`, which throws "control-level targeting needs AT-SPI2". That is the gap: a real control tree plus selector resolution, on top of what works.

**Files and interfaces.**

- `packages/drivers/linux/driver.ts`: make `tree(ref, depth)` honour `depth` and return real control nodes from AT-SPI2 when the app exposes them; **keep the two-node synthetic tree as the fallback** when it does not. Many X11 apps ship no accessibility bridge; degrading honestly beats throwing.
- Selector resolution: `UiSelector` → AT-SPI2 node (`name`, `controlType`, accessible-id interface where implemented), then `invoke()` through the AT-SPI `Action` interface and `click()` through the component extents centre. Keep the existing rule — no matching node throws, never a silent success.
- Leave `windows()`, `bounds()`, `moveWindow()`, `type()`, `keys()` alone except where the a11y layer needs a focus call.
- `scripts/verify-driver.ts`: on Linux report the tree's real node count.
- `docs/drivers.md`: refresh the Linux row — window level verified, control level verified / unverified split, known limit (apps without an a11y bridge fall back).
- New test script following the existing pattern: `scripts/atspi-tree-test.ts`.

**Acceptance criteria.**

```bash
# X11 session with xdotool + wmctrl installed and AT-SPI2 live on the session bus
node scripts/verify-driver.ts
# expect: platform=linux, PASS windows(), PASS tree() with a real node count, final "N passed, 0 failed"
# on a machine missing DISPLAY/xdotool/wmctrl it must still print the missingHint() instructions
# and exit 1 — that path exists today, do not break it
```

```bash
node scripts/atspi-tree-test.ts
# "<n>/<n> passed", covering: tree depth > 2 for an app that exposes accessibility (name it in
# the PR), a selector resolving to a real control, an unmatched selector throwing instead of
# silently succeeding, and the fallback path returning the two synthetic nodes
node scripts/regress.ts   # green
```

**Size:** L — about a week. A third of it is already written, so the work is the accessibility tree and D-Bus, not the window plumbing.

**What we provide.** A mentor who wrote the other drivers and will answer AT-SPI2 / D-Bus questions in the thread; review within 48 h of your first push; your name in `CONTRIBUTORS.md` under *Driver* and in the release notes of the first version with control-level Linux support.

**Risks and notes.** AT-SPI2 is a D-Bus service: check `busctl --user list | grep -i atspi` first; if `org.a11y.Bus` is absent, load the bridge (`NO_AT_BRIDGE=0`, `GTK_MODULES=gail:atk-bridge`) before concluding the code is wrong. **No new dependency** — talk to the bus through the existing CLI style (`gdbus` / `busctl`) or a hand-rolled client, not an npm D-Bus library. `xvfb-run` is fine for a smoke test but usually has no accessibility bus, so it cannot prove the control tree. Do not put a permission check inside the driver — permissions belong to `packages/core/src/policy.ts`.

---

## 02 — Multi-display and DPI coordinate mapping

**Title:** `driver: map coordinates across multiple displays and DPI scaling factors`

**Labels:** `bounty`, `driver`, `help wanted`

**Background.** The gap is real in the code, not only in the roadmap: searching `packages/`, `apps/`, `bin/` and `scripts/` for `dpi`, `scaling`, `devicePixelRatio` or `monitor` returns nothing — only `docs/roadmap.md` and its Chinese mirror mention the item. Every driver therefore assumes one display at one scale factor. `window.rect` assertions compare rectangles in whatever space the platform API returns, and `click(ref, sel)` resolves a target to a point in that same space. On a mixed-DPI desk (a 150 % laptop panel next to a 100 % external monitor) those assumptions stop holding and a click lands tens of pixels off. **Reproduce it before you fix it** — the exact failure depends on whether the host process is DPI-aware, and establishing that is part of the deliverable.

**Files and interfaces.**

- `packages/drivers/windows/driver.ps1` / `driver.ts`: report the monitor layout and be explicit about DPI awareness.
- `packages/core/src/types.ts`: add an *additive* optional capability (for example `screens?(): Promise<Screen[]>`). `UiDriver` already mixes six required methods with two optionals (`bounds?`, `moveWindow?`), so follow that shape — do not change the meaning of `Rect` and do not make the new method required, or the macOS and Linux drivers stop compiling.
- `scripts/verify-driver.ts`: a `screens()` check printing every monitor with bounds and scale factor.
- New test script following the existing pattern: `scripts/dpi-map-test.ts`.

**Acceptance criteria.**

```bash
node scripts/verify-driver.ts
# expect a new PASS screens() line listing each monitor with bounds + scale,
# and the existing windows()/tree()/focus() checks unchanged
```

```bash
node scripts/dpi-map-test.ts
# exits 0, one line per synthetic monitor case, e.g.
#   case 1 display 0 @150%  point (100,100)   -> screen (100,100)   PASS
#   case 2 display 1 @100%  point (2600,300)  -> screen (2600,300)  PASS
# final line "<n>/<n> cases passed"
```

At least one case must be one where naive arithmetic gives the wrong answer, so a future regression is caught rather than tolerated. `node scripts/regress.ts` stays green and `node scripts/snapshot-test.ts` still prints `3/3 snapshots match` — a coordinate fix must not move preview snapshots.

**Size:** M — 1–3 days including the reproduction write-up.

**What we provide.** The maintainer's reproduction notes from macOS hardware (the AX bridge already clicks by coordinate there), a review that argues about the abstraction instead of the formatting, and a release-notes mention.

**Risks and notes.** Two traps. "Just multiply by the scale factor" is wrong the moment a window straddles two monitors — handle per-monitor scale, not per-system scale. And `Rect` is protocol v0: if you want to change its units, stop and open an RFC ([rfcs/README.md](../rfcs/README.md)), because that invalidates every stored assertion.

---

## 03 — Recorder: pointer coverage and geometry inference

**Title:** `recorder: capture right-click, middle-click, wheel and drag; infer window.rect assertions`

**Labels:** `bounty`, `driver`, `recorder`

**Background.** The event-hook rewrite is done and is the default: `packages/drivers/windows/recorder.ps1` line `$useEvents = -not $Poll` selects UIA `FocusChanged` / `StructureChanged` callbacks drained through `Application.DoEvents()`, with `-Poll` (300 ms sampling) only as the fallback, and `scripts/recorder-mode-test.ts` proves both modes start and write JSONL. **Do not redo that.**

Two real gaps remain, and they live in the same two files:

- **Input coverage.** `ClickWatcher` (`SetWindowsHookEx(14, …)`, i.e. `WH_MOUSE_LL`) filters on one message: `wParam == 0x0201`, left button down. Right-click, middle-click, wheel and drag are dropped silently. `docs/recording.md` admits it under *Known limits*.
- **Geometry.** `interface Sample` in `scripts/draft-skill.ts` has `ts / type / window / controlType / name / automationId / value / x / y` and no rectangle at all, so `window.rect` — the fourth "the click worked" signal, the one `tile-windows` writes by hand — can never be inferred. Today the script infers only `window.exists` (a window appeared within 3 s), `ui.exists` (focus moved within 2.5 s) and `ui.value` (typed text).

**Files and interfaces.**

- `packages/drivers/windows/recorder.ps1`: handle `0x0204` (right down), `0x0207` (middle down), `0x020A` (wheel — the high word of `mouseData` is a signed delta), pair `0x0201` with `0x0202` plus movement beyond a threshold for drag; add `rect: [x, y, w, h]` to `click` and `window-open` rows (`BoundingRectangle` is already in scope).
- Recording JSONL is an internal schema, **not** protocol v0: click rows gain `button: "left" | "right" | "middle"`, a `wheel` row type carries `delta`, and a `drag` row carries `from` / `to`.
- `scripts/draft-skill.ts`: left clicks keep generating `ui.click`; every other kind emits an explicit `// TODO: <kind> at <window> — no Action kind in protocol v0` comment instead of being dropped (silent data loss is the bug); and a click followed within 3 s by a geometry change of the same window emits `{ kind: "window.rect", window, rect, tolerance }` — a kind `packages/core/src/types.ts` already declares, so no protocol change.
- `docs/recording.md`: update the three-event-kinds paragraph, the modes table, and the inference rules list.
- `scripts/recorder-mode-test.ts`: add cases for the new event kinds.

**Acceptance criteria.**

```bash
node scripts/recorder-mode-test.ts
# "8/8 passed" today; yours keeps it green and adds the new kinds
```

```bash
node apps/recorder/main.ts --seconds 15 --out .demo/recordings/rec.jsonl
# during the recording: one left click, one right click, one wheel scroll, one title-bar drag, then:
node -e "const r=require('fs').readFileSync('.demo/recordings/rec.jsonl','utf8').trim().split(/\n/).map(JSON.parse); console.log([...new Set(r.map(x=>x.type+(x.button?':'+x.button:'')))].join(' '))"
# expect output containing: click:left click:right wheel drag
```

```bash
node scripts/draft-skill.ts --recording .demo/recordings/rec.jsonl --name rec-check --only "."
# the draft has a TODO comment per non-left-click event AND a window.rect assertion for the drag,
# and the summary line counts the inferred assertion
node bin/deskshell.ts run rec-check --mode preview   # renders a plan
node scripts/snapshot-test.ts                        # 3/3 snapshots match — existing drafts unchanged
node scripts/regress.ts                              # green
```

Negative case that must be covered: a click that does **not** move the window produces no `window.rect` assertion.

**Size:** M — 1–3 days; the hook plumbing is small, the drag threshold and tolerance tuning eat the time. Split it into two PRs if you prefer: capture first, inference second.

**What we provide.** A recording session and the JSONL the maintainer produced for comparison; a review focused on event loss, tolerance justification and the poll fallback staying equivalent; credit as recorder contributor.

**Risks and notes.** `WH_MOUSE_LL` callbacks run on a hook thread and must stay fast — enqueue and resolve on the drain thread the way the existing left-click path does, do not call UI Automation inline. Drag needs a distance threshold or every shaky click becomes a drag. Maximized, minimized and animating windows produce garbage rectangles — skip those rows. Stay out of protocol v0: a right-click that genuinely needs a new `Action` kind is a separate RFC.

---

## 04 — Per-action dry-run diffs (`run --diff`)

**Title:** `kernel: per-action dry-run diff output for preview mode`

**Labels:** `bounty`, `kernel`

**Background.** Preview is the default mode and already prints a plan with risk level, per-step undoability and a summary. What it does not do is say what the bytes would become. For a skill that rewrites 300 files, "312 steps, low risk" is not enough to approve. Searching for `dryRun` / `dry-run` outside the publish scripts returns nothing — this does not exist.

**Files and interfaces.**

- New: `packages/core/src/diff.ts` — a pure function turning an `Action` into a short human diff (`fs.write` → `+18 -0` with a bounded excerpt, `fs.move` → `a -> b`, `fs.delete` → `-<n> bytes`, `fs.restore` → `restore <n> bytes`).
- `bin/deskshell.ts`: a `--diff` flag on `run`, printed in preview mode only, carried into `--json` as a per-step `diff` field.
- New test: `scripts/dry-run-diff-test.ts`, shaped like `scripts/preview-summary-test.ts`.

**Acceptance criteria.**

```bash
node scripts/make-fixture.ts
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --diff
# expect one diff line per step, e.g.   fs.move  notes.txt -> 文档/notes.txt
# plus the existing summary; without --diff the output is byte-identical to today
```

```bash
node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --diff --json
# expect steps[i].diff to be a string and "ok": true
node scripts/dry-run-diff-test.ts   # "<n>/<n> passed"
node scripts/snapshot-test.ts       # 3/3 snapshots match — default preview unchanged
node scripts/regress.ts             # green
```

**Size:** M — 1–3 days, mostly deciding how much of a file to show before a diff becomes a dump.

**What we provide.** The fixture generator (`scripts/make-fixture.ts`), a review focused on output determinism (this output gets pasted into issues and screenshots), and a release-notes credit.

**Risks and notes.** Do not read whole files to build a diff — cap the bytes and say so in the output. Keep it deterministic: no absolute paths, no timestamps, no locale-dependent formatting. Do not change default preview output; `scripts/snapshot-test.ts` exists to catch exactly that.

---

## 05 — Cross-task undo timeline (`deskshell timeline`)

**Title:** `cli: deskshell timeline — one time-ordered view across tasks, with per-step undoability`

**Labels:** `good first issue`, `kernel`

**Background.** Read the three existing pieces first; this task is not a rename of any of them.

- `deskshell history [--root DIR] [--json]` — one row **per task**: taskId, skill, step count, duration, state, start time. It never shows steps, and it ends by telling you to run `show`.
- `deskshell show [taskId] [--root DIR]` — **one task's** steps: `✓ 01. 12:34:56 fs.move …`, plus `undo: <kind>` when the journal entry carries an undo. For a step recorded with `undo: null` it prints nothing, so absence is ambiguous between "no undo needed" and "cannot be undone".
- `deskshell undo --task <id> | --last <N> | --since <30m|2h|1d>` — already the way to roll back.

What nothing provides is the roadmap's ask: one view across *all* tasks in time order that answers "what did this machine do in the last hour, and which of it can still be taken back" — with non-undoable steps marked, already-undone steps marked, and apply/undo events interleaved.

**Files and interfaces.**

- `bin/deskshell.ts`: a new `timeline` command with `--since`, `--limit`, `--json`, `--root`.
- `packages/core/src/journal.ts`: whatever read helper the view needs (a `load()` already exists).
- New test: `scripts/timeline-test.ts`.

**Acceptance criteria.**

```bash
node bin/deskshell.ts timeline --root .demo/downloads
# one time-ordered stream across tasks; each step marked ok / failed / already undone,
# and explicitly "不可撤销" where undo is null; footer states which range can still be undone now
```

```bash
node bin/deskshell.ts timeline --root .demo/downloads --json
# expect { tasks: [ { taskId, skill, start, steps, undoable, notUndoable, undone } ] }
node scripts/timeline-test.ts   # "<n>/<n> passed", including a task with an undo:null step
node scripts/regress.ts         # green — cli.history / cli.show / undo behaviour unchanged
```

Put real `history` and `show` output next to `timeline` output in the PR description, so the reviewer can see it adds information rather than reformatting.

**Size:** M — 1–3 days. Reading the journal is trivial; designing an output that is not a prettier `show` is the work.

**What we provide.** A journal fixture with a mixed undoable / non-undoable / partially-undone task, a review of the table layout against `history` so the two do not drift, and a release-notes credit.

**Risks and notes.** Read-only: it must not undo anything. Do not change the journal schema — existing `.deskshell/journal.jsonl` files must keep working, which the rotation and range tests police. Do not modify `history` or `show` output in this PR; if you think they should merge, that is a separate discussion. Column widths and ordering are user-visible API — follow `history`'s alignment conventions.

---

## 06 — Remember capability consents (`--ask --remember`)

**Title:** `cli: persist capability consent so --ask does not re-ask every run`

**Labels:** `good first issue`, `kernel`

**Background.** Interactive consent already exists: `bin/deskshell.ts` has the `--ask` flag and `askCapabilities()`, which on a TTY asks per capability through `node:readline/promises` and on a pipe reads `y`/`n` lines from stdin. Its behaviour is pinned by `scripts/ask-test.ts`: all-yes proceeds, any-no exits 2 with no side effects, empty input counts as refusal.

What it does not do is **remember**. Searching `bin/`, `packages/` and `scripts/` for `remember` or `grants.json` returns nothing: there is no consent store, so every run re-interviews the user — and in practice people pass `--grant` and skip the asking entirely, which defeats the design. `packages/core/src/policy.ts` takes `granted: CapabilityId[]` as an argument and stores nothing.

**Files and interfaces.**

- `bin/deskshell.ts`: `--ask --remember` (persist) and `--ask --forget` (clear).
- New: a grants store under the task root — `<root>/.deskshell/grants.json` holding skill name, capability id, scope and granted-at timestamp. Root-scoped, never global.
- `packages/core/src/policy.ts`: optionally read stored grants before interviewing.
- New test: `scripts/ask-remember-test.ts`.

**Acceptance criteria.**

```bash
printf 'y\ny\n' | node bin/deskshell.ts run downloads-cleanup --root .demo/ask2 --ask --remember --mode preview
# exit 0, and .demo/ask2/.deskshell/grants.json exists containing both capabilities
node bin/deskshell.ts run downloads-cleanup --root .demo/ask2 --ask --mode preview < /dev/null
# exit 0 without a prompt, plus one line saying stored consent is being reused
node bin/deskshell.ts run downloads-cleanup --root .demo/ask2 --ask --forget
# grants.json gone; the next --ask run asks again
```

```bash
node scripts/ask-remember-test.ts   # "<n>/<n> passed"
node scripts/ask-test.ts            # still 8/8 passed — plain --ask semantics unchanged
node scripts/regress.ts             # green
```

**Size:** S — half a day.

**What we provide.** `scripts/ask-test.ts` as the behavioural contract to preserve, a review that focuses on the refusal path above all, and a release-notes credit.

**Risks and notes.** Consent that silently widens is a security bug. A reused grant must be printed, `--forget` must really delete, and a stored grant must never apply to another skill or a wider scope. A corrupt `grants.json` is treated as absent and re-asks — never as "everything allowed". CLI and policy only, not protocol v0.

---

## 07 — Full-text search in the docs site

**Title:** `docs: full-text search across page bodies, keyboard navigable`

**Labels:** `good first issue`, `docs`

**Background.** The built site already has a search box — `#nav-search` in `scripts/build-docs.ts` — and it is a decent progressive enhancement, but it filters `.nav-item` link text only, i.e. the sidebar's page titles. It is not full-text search and should not be described as one. A reader who remembers the word "tolerance" but not the page gets nothing. The site is generated for both languages with no third-party assets, and that constraint stays.

**Files and interfaces.**

- `scripts/build-docs.ts`: emit a search index at build time (`site/en/search-index.json`, `site/zh-CN/search-index.json`) from page HTML — heading text, anchor ids, and a bounded body excerpt per heading section.
- The injected script in the same file: query the index, render hits as page + heading links, support ↑/↓ to move through hits and Enter to open, and keep today's title filter as the empty-query state.
- `docs/index.md`: one line telling readers that search covers page bodies.

**Acceptance criteria.**

```bash
node scripts/build-docs.ts
# the existing "built <n> pages" line, and additionally:
ls site/en/search-index.json site/zh-CN/search-index.json   # both exist
```

```bash
node -e "const i=require('./site/en/search-index.json'); const q='tolerance'; console.log(i.filter(e=>JSON.stringify(e).toLowerCase().includes(q)).map(e=>e.page+'#'+e.anchor).join('\n'))"
# at least one hit that is not a page title — the sidebar filter could never find it
node scripts/regress.ts   # green, including the docs.build check
```

Manual check written into the PR: open `site/en/index.html`, type a word that appears only in a body, get a hit, press ↓ and Enter, land on the right anchor. With JavaScript disabled the page behaves as today (filter hidden, layout intact).

**Size:** M — 1–3 days. Indexing is easy; keeping the payload small and the UI honest is the work.

**What we provide.** A review of the generated HTML for accessibility and for the no-JS path, and your name under *Docs* in `CONTRIBUTORS.md`.

**Risks and notes.** No third-party search library, no CDN, no build-time service — the site must stay openable offline from `file://`. Strip tags and navigation chrome from indexed text or every page matches every query. Cap excerpt length.

---

## 08 — Engineering guardrails: `--fail-at`, flake soak, three-platform CI

**Title:** `kernel+ci: --fail-at for any skill, a random-fault soak, and a Windows/macOS CI matrix`

**Labels:** `good first issue`, `testing`, `ci`

**Background.** Two honest gaps, both about proof.

- **Fault injection lives in a demo, not in the kernel.** `apps/cli-demo/fail-story.ts` reads `--fail-at <step>` from `process.argv` (lines 6–7) and wraps the plan to fail at that step. There is no equivalent on `node bin/deskshell.ts run` and nothing random anywhere in the tree, even though `docs/roadmap.md` lists "random fault injection on top of `--fail-at`".
- **CI is single-platform.** `.github/workflows/ci.yml` has exactly two jobs, both on `ubuntu-latest`: `regress` (Node 22 + 24 matrix, running `node scripts/regress.ts` and `node scripts/build-docs.ts`) and `linux-ui` (installs `xvfb xterm xdotool wmctrl`, runs `node scripts/contract-test.ts` and `xvfb-run -a --server-args="-screen 0 1280x800x24" node scripts/linux-driver-smoke.ts`). The Windows UIA driver and the macOS AX bridge — the two things STATUS.md claims were verified on hardware — are never exercised in CI. A regression there ships silently.

Part A (CI matrix) is a half-day and mergeable on its own. Part B (fault injection) is the other half.

**Files and interfaces.**

- Part A: `.github/workflows/ci.yml` — add `windows-latest` and `macos-latest` jobs running `node scripts/regress.ts` and `node scripts/build-docs.ts`; on macOS build the bridge first (`packages/drivers/macos/build.sh`) so the AX path is actually exercised. Fail the job on any snapshot drift by running `node scripts/snapshot-test.ts` on every OS.
- Part B: kernel-level injection — a `--fail-at <step>` flag on `deskshell run` (or a kernel option) that makes step N fail during `apply`, so any skill can be tested, not only the demo.
- Part B: new `scripts/flake-soak.ts` running N iterations with a **random** step, seeded and reproducible, asserting after each: side effects gone, exactly one failed step in the journal, rollback count reported, second undo a no-op.
- `docs/roadmap.md` / `docs/zh-CN/roadmap.md`: tick the item off in the same PR.

**Acceptance criteria.**

```bash
# Part A — after pushing the branch, the PR's checks show three operating systems
gh pr checks   # or read them in the browser: regress (ubuntu), regress (windows), regress (macos) all green
node scripts/snapshot-test.ts   # 3/3 snapshots match on every OS
```

```bash
# Part B — injection usable on a real skill, not just the demo
node bin/deskshell.ts run downloads-cleanup --root .demo/fail-at --mode apply --fail-at 7
# expect: step 7 fails, 6 steps rolled back, exit non-zero
node bin/deskshell.ts journal --root .demo/fail-at   # shows exactly 1 failed step
```

```bash
node scripts/flake-soak.ts --runs 20
# one line per run:  run 7/20  fail-at step 13/20  rolled back 12  journal ok  PASS
# final line: "20/20 runs rollback-consistent"; any inconsistency prints the journal path and exits non-zero
node scripts/flake-soak.ts --runs 5 --seed 42   # same seed, same steps
node scripts/regress.ts                          # green
```

**Size:** M total — Part A is S (half a day), Part B is S too. They are independent PRs; do one, claim the other.

**What we provide.** The failing-run journal from any soak you publish, a review that insists the seed is reproducible and that CI failures are real failures (no `continue-on-error` masking), and a release-notes credit.

**Risks and notes.** On macOS the Swift bridge build may fail for reasons unrelated to your change — if it does, report the failure and mark the driver checks `SKIP` with a linked issue; do **not** make CI green by swallowing the error. The soak runs the kernel dozens of times against the filesystem: keep everything under `.demo/` and clean up between runs. If the soak finds a real kernel bug that is a **success** — open a separate `bug` issue and link it rather than fixing the kernel inside this PR.

---

## 09 — MCP adapter

**Title:** `mcp: expose deskshell preview / apply / undo as MCP tools`

**Labels:** `bounty`, `ecosystem`, `mcp`

**Background.** Nothing in the tree speaks MCP today — searching the code for `mcp` returns only planning notes under `outreach/`. Meanwhile the interface an MCP client needs is exactly the one the kernel already has: a plan (preview), an execution (apply), and a reversal (undo), each already returning structured JSON (`deskshell run --json` returns `{ ok, steps }`). Exposing those three as tools is the cheapest way to let any MCP-capable agent drive deskshell **without** giving the kernel a model dependency, and it changes no protocol semantics.

**Files and interfaces.**

- New: `apps/mcp/server.ts` (plus a thin `bin/` entry if you prefer `deskshell mcp`) speaking JSON-RPC over stdio: `initialize`, `tools/list`, `tools/call`.
- Three tools, thin wrappers over existing kernel entry points: `deskshell_preview` (`skill`, `root`), `deskshell_apply` (`skill`, `root`, `grant` required — no implicit grants), `deskshell_undo` (`taskId` or `last`, `root`). Reuse `run()` / `undoTask()` from `packages/core/src/kernel.ts`; do not reimplement execution.
- **Zero dependencies**: hand-roll the JSON-RPC framing rather than adding `@modelcontextprotocol/sdk`. This is the constraint that makes the task interesting, and it is non-negotiable without an RFC.
- New test: `scripts/mcp-smoke.ts` driving the server over stdin/stdout.
- `docs/index.md` (or a new `docs/mcp.md` if that is cleaner): a five-line "connect an MCP client" section with the exact command.

**Acceptance criteria.**

```bash
node scripts/mcp-smoke.ts
# "<n>/<n> passed": initialize handshake, tools/list returns exactly 3 tools,
# tools/call deskshell_preview returns the plan as JSON, tools/call on a skill whose
# capabilities were not granted returns a structured error (not a crash), and an
# unknown tool name returns a JSON-RPC error
```

```bash
# manual, from any MCP client (Claude Desktop, or your own script):
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node apps/mcp/server.ts
# expect a well-formed initialize result, then the same for tools/list
node scripts/regress.ts   # green — the new smoke check included
```

**Size:** M — 1–3 days. The protocol surface you need is small; the discipline is in not letting the adapter bypass the permission layer.

**What we provide.** A review focused on one question — does the adapter weaken the capability model? — plus a sample client config for the docs, and credit under *Ecosystem* in `CONTRIBUTORS.md`.

**Risks and notes.** An MCP tool is an entry point for an agent, so the permission layer must stay exactly where it is: `apply` without an explicit `grant` argument must fail closed, and every call must land in the journal like any other run. Do not expose a "shell" or "arbitrary action" tool — three narrow tools or nothing. Do not let `server.ts` import anything that pulls in a model SDK; the kernel stays dependency-free and so does its adapter.

---

## 10 — New skill: `screenshot-dedupe`

**Title:** `skill: screenshot-dedupe — collapse near-identical screenshots, keep the earliest`

**Labels:** `good first issue`, `skill`

**Background.** Two existing skills are adjacent but neither does this. `dedupe-folders` hashes file *content*, so it only catches byte-identical copies. `screenshot-organize` groups screenshots by date into `YYYY/MM/` and prefixes the time. What people actually have is bursts: six screenshots of the same dialog, differing only in a caret blink. That case is unserved — and it is an ideal first skill because it is filesystem-only, so it runs on every platform, including Linux without a control-level driver.

**Files and interfaces.**

- `node scripts/new-skill.ts --name screenshot-dedupe` scaffolds `packages/skills/screenshot-dedupe/{index.ts,skill.json}`; after that only `plan()` changes.
- Manifest: `fs.read` and `fs.write` scoped to `"{{root}}"` with a plain-language `reason` each. The kernel rejects actions not covered by a declared capability, so an over-broad scope gets refused.
- Zero dependencies: read dimensions from the PNG `IHDR` header and the JPEG `SOF` marker (a few dozen lines) — no image library.
- Fixture: `scripts/make-screenshot-fixture.ts` (new) generating PNGs of known dimensions and mtimes.
- Register in `scripts/regress.ts` following the `photo-sort` / `new-skills` pattern.

**Acceptance criteria.**

```bash
node scripts/make-screenshot-fixture.ts .demo/screenshots
node apps/cli-demo/run.ts --skill packages/skills/screenshot-dedupe/index.ts --mode preview --root .demo/screenshots
# the plan's step count equals the number of duplicate candidates, every step undoable
node apps/cli-demo/run.ts --skill packages/skills/screenshot-dedupe/index.ts --mode apply --root .demo/screenshots
node apps/cli-demo/run.ts --skill packages/skills/screenshot-dedupe/index.ts --mode undo
# the file count returns exactly to its starting value
node scripts/regress.ts   # green, with your new check included
```

Hard rules from `CONTRIBUTING.md`: every action has a `post` assertion, every action has an `undo`, `plan()` calls no system APIs, and duplicates go to `.trash` — nothing is deleted.

**Size:** S — half a day.

**What we provide.** The fixture generator sketch, a review that checks the "keep the earliest" rule and the `.trash` safety, and your name under *Skill* in `CONTRIBUTORS.md`.

**Risks and notes.** "Near-identical" is a policy decision, not an algorithm: same dimensions plus a small mtime window is defensible and explainable, and the rule must sit in the skill's `description` so the user sees it before applying. No deleting, no overwriting, no deduping across directories in v1.

---

## 11 — New skill: `browser-download-sort`

**Title:** `skill: browser-download-sort — sort a browser download folder by type and name pattern`

**Labels:** `bounty`, `skill`

**Background.** `browser-tabs` reads browser *windows* through the UI tree (Windows and macOS only). `downloads-cleanup` sorts by extension alone. Nobody sorts a download folder using what the filenames actually say — `report (3).pdf`, `setup-x64.exe`, `invoice_2026-03.pdf` — even though that information is right there. Filesystem-only, so it works on all platforms today.

**Files and interfaces.**

- `packages/skills/browser-download-sort/{index.ts,skill.json}`, scaffolded by `node scripts/new-skill.ts --name browser-download-sort`.
- Deterministic rules only — no model calls, no network: strip browser duplicate suffixes (`(1)`, ` (2)`), strip size suffixes, group with a documented classifier (installer / document / archive / image / media), and preserve the original filename inside the target folder.
- Fixture: `scripts/make-download-fixture.ts` (new) with a name table covering every rule you implement.
- `docs/recipes.md`: a short recipe entry in the existing page format.
- Register in `scripts/regress.ts`.

**Acceptance criteria.**

```bash
node scripts/make-download-fixture.ts .demo/dl-sort
node apps/cli-demo/run.ts --skill packages/skills/browser-download-sort/index.ts --mode preview --root .demo/dl-sort
# the plan names every move, e.g.   fs.move  setup-x64.exe -> 安装包/setup-x64.exe
node apps/cli-demo/run.ts --skill packages/skills/browser-download-sort/index.ts --mode apply --root .demo/dl-sort
node apps/cli-demo/run.ts --skill packages/skills/browser-download-sort/index.ts --mode undo
# file count and every original path restored; a second undo is a no-op
node scripts/regress.ts   # green, including your new check
```

The classifier table must appear in the skill `description` and in the PR: a user approving a move list deserves to know the rule that produced it.

**Size:** M — 1–3 days. The rules are easy; the collisions are not.

**What we provide.** A real download-folder listing (names only, no content) to test against, a review that pushes on collision handling, and credit under *Skill*.

**Risks and notes.** Two files that would land on the same target must make the step fail loudly rather than silently overwrite — `rename-batch` set that precedent; follow it. Do not read browser history databases, do not touch anything outside `{{root}}`.

---

## 12 — New skill: `pdf-merge` (zero-dependency)

**Title:** `skill: pdf-merge — merge PDFs without adding a dependency`

**Labels:** `bounty`, `skill`, `hard`

**Background.** No skill under `packages/skills/` touches PDFs, and the honest reason is that merging PDFs is real work: object graphs, cross-reference tables, trailer dictionaries, page trees, compressed streams. The zero-dependency invariant rules out `pdf-lib` and friends, so this is either a carefully bounded implementation or nothing. It is on the board because the bounded version is genuinely doable.

**Files and interfaces.**

- `packages/skills/pdf-merge/{index.ts,skill.json}` with `fs.read` + `fs.write` on `"{{root}}"`.
- A minimal PDF reader/writer next to the skill (or under `packages/core/src/` if genuinely reusable — say which and why in the PR): parse `startxref` → xref table → trailer → `/Root` → `/Pages` → `/Kids`, copy page objects into a new document, write a fresh xref and trailer.
- **Bounded first version:** same page geometry only; no encryption; no object streams (`/ObjStm`). Refuse those inputs with a clear message instead of emitting a corrupt file.
- Fixture: `scripts/make-pdf-fixture.ts` (new) generating small uncompressed PDFs so the output is inspectable.

**Acceptance criteria.**

```bash
node scripts/make-pdf-fixture.ts .demo/pdfs
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode preview --root .demo/pdfs
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode apply --root .demo/pdfs
node scripts/pdf-merge-test.ts
# "<n>/<n> passed", including:
#   merged page count == sum of input page counts
#   output opens with no repair warning in two independent viewers (name both in the PR)
#   an /ObjStm input is refused with a message, not silently mangled
node apps/cli-demo/run.ts --skill packages/skills/pdf-merge/index.ts --mode undo
# merged file gone, every input byte-identical (compare hashes)
node scripts/regress.ts   # green, including your new check
```

**Size:** L — about a week. The hardest task on the board, listed for someone who wants it, not for a first afternoon.

**What we provide.** Staged mentor review (parser design first, then the writer), a fixture set, and explicit guidance on when to refuse an input rather than risk writing a broken file. Credit as *Skill* author, stated in the release notes.

**Risks and notes.** A corrupted output PDF is worse than no feature: write to a temp path, validate the page count by re-parsing your own output, then move into place. Do not add a dependency "just for parsing" — if you believe one is unavoidable, that is an RFC about the zero-dependency invariant, not a PR ([rfcs/README.md](../rfcs/README.md), [GOVERNANCE.md](GOVERNANCE.md)). Never claim support for encrypted or object-stream PDFs; refusing is correct.

---

## Already shipped — do not rebuild these

Stale requests for these keep arriving. Each has a real, runnable proof.

| Already shipped | Proof |
| --- | --- |
| Linux **window-level** X11 driver (`xdotool` + `wmctrl`): window enumeration with geometry, `type`, `keys`, `moveWindow`, plus `missingHint()` install guidance | `packages/drivers/linux/driver.ts`; `scripts/verify-driver.ts`; `scripts/linux-driver-smoke.ts` runs it under Xvfb in CI — the follow-up gap is task **01** (control tree) |
| `deskshell run a b --parallel` — several skills in one invocation, one failing does not stop the others | `node scripts/parallel-test.ts` → `7/7 passed` |
| Interactive capability consent (`--ask`, per feature, TTY interview or piped `y`/`n`) | `node scripts/ask-test.ts` → `8/8 passed` — the remaining gap is task **06** (remembering) |
| Recorder on UIA event hooks (`FocusChanged` + `StructureChanged`, default since `$useEvents = -not $Poll`) with a `-Poll` fallback | `node scripts/recorder-mode-test.ts` → `8/8 passed`; `docs/recording.md` documents both modes — remaining gap is task **03** |
| `deskshell history` (per-task list) and `deskshell show` (one task's steps) | Usage text in `bin/deskshell.ts` lines 35–36; `cli.history` / `cli.show` checks in `scripts/regress.ts` — remaining gap is task **05** (cross-task) |

Also already true, and worth knowing before proposing a shortcut: every action needs a `post` assertion and an `undo`; actions with `undo: null` are rejected by the kernel; the kernel has no model dependency and adding one is not on the table.

## What the maintainer will not accept

Stated once, so nobody discovers it three days in — the same list appears in [CONTRIBUTOR-LADDER.md](CONTRIBUTOR-LADDER.md) and [GOVERNANCE.md](GOVERNANCE.md):

- A demo-only script that works once on the author's machine and has no assertion or no undo.
- A change to protocol semantics (action kinds, assertion kinds, undo contract) smuggled into a feature PR. That is an RFC.
- A new third-party runtime dependency without an RFC.
- A driver that does its own permission checks — permissions belong to `packages/core/src/policy.ts`.
- A "bypass" that widens capability scope to make a skill convenient.
- CI made green by swallowing an error (`continue-on-error`, `|| true`, skipped assertions).
