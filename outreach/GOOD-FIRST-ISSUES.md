# Good first issues

Twelve tasks that are **already scoped**, **already unblocked**, and **each end with a command you can run to prove you are done**. Nothing here needs a design decision from the maintainer first — that is the point of the list.

Everything below is derived from the gaps recorded in [docs/roadmap.md](../docs/roadmap.md) and the honest-limits table in [STATUS.md](../STATUS.md). Where a naive version of a feature already shipped, the task says so and moves one step further, so you never spend a weekend rebuilding what exists. There is no invented work on this board.

- Repo: `https://github.com/ciceroyang/deskshell` · MIT · Node `>=22.18`
- Zero third-party runtime dependencies — this is an invariant, not a preference. A PR that adds a dependency needs an RFC first (see [GOVERNANCE.md](GOVERNANCE.md)).
- Protocol v0 is frozen in `spec/protocol-v0.json`. Changing action / assertion / undo semantics needs an RFC. Almost everything on this board fits inside v0.
- First PR path (should take under 30 minutes of setup): [CONTRIBUTING.md](../CONTRIBUTING.md) → `node scripts/regress.ts` → pick a task below → open a draft PR with the claim comment.

## How to claim

1. Open a `bounty` issue from [.github/ISSUE_TEMPLATE/bounty.yml](../.github/ISSUE_TEMPLATE/bounty.yml) — or comment on the existing issue for that task — and say which task number you are taking.
2. The maintainer replies within **48 h** with: a mentor name, confirmation that the scope is still free, and any fixture you asked for.
3. Work in a branch. Do not touch files outside the task's file list, and do not rewrite docs you were not asked to touch.
4. Open the PR with the acceptance commands and their real output pasted into the description. Green CI plus pasted output is the whole review bar.

Sizes: **S** = half a day, **M** = 1–3 days, **L** = about a week, measured for someone who has already run `node scripts/regress.ts` once.

## Index

| # | Task | Labels | Size | Area |
| --- | --- | --- | --- | --- |
| 01 | Linux AT-SPI2 driver: `windows()` and `tree()` | `good first issue` `driver` `help wanted` | **L** | driver |
| 02 | Multi-display and DPI coordinate mapping | `bounty` `driver` `help wanted` | **M** | driver |
| 03 | Recorder: right-click, middle-click, wheel and drag | `bounty` `driver` `recorder` | **M** | driver / recorder |
| 04 | Infer `window.rect` assertions from a recording | `bounty` `recorder` | **M** | recorder / kernel |
| 05 | Per-action dry-run diffs (`run --diff`) | `bounty` `kernel` | **M** | kernel |
| 06 | Undo timeline view (`deskshell timeline`) | `good first issue` `kernel` | **M** | kernel / CLI |
| 07 | Remember capability consents (`--ask --remember`) | `good first issue` `kernel` | **S** | kernel |
| 08 | Full-text search in the docs site | `good first issue` `docs` | **M** | docs |
| 09 | Random fault injection soak | `good first issue` `testing` | **S** | engineering |
| 10 | New skill: `screenshot-dedupe` | `good first issue` `skill` | **S** | skill |
| 11 | New skill: `browser-download-sort` | `bounty` `skill` | **M** | skill |
| 12 | New skill: `pdf-merge` (zero-dependency) | `bounty` `skill` `hard` | **L** | skill |

---

## 01 — Linux AT-SPI2 driver: `windows()` and `tree()`

**Title:** `driver(linux): implement UiDriver.windows() and tree() over AT-SPI2`

**Labels:** `good first issue`, `driver`, `help wanted`, `platform: linux`

**Background.** `packages/drivers/` contains `windows/`, `macos/` and `mock/` — there is no `linux/`. `scripts/verify-driver.ts` has an explicit branch for the missing case: it picks `WindowsDriver` on `win32`, `MacDriver` on `darwin`, and otherwise prints that no driver exists for the platform and exits 0. So on Linux every file-based skill runs and nothing that touches a screen does. The interface is frozen, which is what makes this a fill-in-the-blank task instead of a design task.

**Files and interfaces.**

- New: `packages/drivers/linux/driver.ts` exporting `class LinuxDriver implements UiDriver`.
- The interface is `UiDriver` in `packages/core/src/types.ts`: `windows()`, `tree(ref, depth)`, `invoke(ref, sel)`, `click(ref, sel)`, `type(ref, sel, text)`, `keys(ref, combo)`, `focus(ref)`, `bounds(ref)`.
- `scripts/verify-driver.ts`: add the `linux` branch.
- `docs/drivers.md`: add the Linux row with a *verified / not verified / known limits* split, the same shape the macOS section already uses.
- Reference implementations to copy the shape from: `packages/drivers/mock/driver.ts` (small, readable) and `packages/drivers/macos/driver.ts`.

**Scope the first PR to read-only.** `windows()` and `tree()` only. Implement the input methods as `throw new Error("not implemented: <name>")` and let the verifier report them as `SKIP`, exactly as it already does for `click()` / `invoke()` today. A read-only driver that passes `windows()` and `tree()` is mergeable; a half-working input driver is not.

**Acceptance criteria.**

```bash
# on a Linux box with a desktop session (GNOME/KDE) and AT-SPI2 enabled
node scripts/verify-driver.ts
# expect: platform=linux
#         PASS windows()  <n> windows, e.g. <some window title>
#         PASS tree()     <window> -> <n> nodes
#         final line "N passed, 0 failed", every unimplemented method listed as SKIP
```

```bash
node bin/deskshell.ts doctor     # environment self-check still reports 0 failed
node scripts/regress.ts          # last line is "NN/NN passed" with 0 failures
```

Also required: the Linux section of `docs/drivers.md` states which of the eight interface methods are verified on hardware, which are implemented-but-unverified, and what the known limits are (no accessibility bus, a Wayland session with the accessibility bridge disabled, and so on).

**Size:** L — one week. Two thirds of it is learning the AT-SPI2 bus and the accessibility tree shape, not typing.

**What we provide.** A mentor who wrote the other two drivers and will answer bus / DBus questions in the issue thread; review within 48 h of your first push; your name in `CONTRIBUTORS.md` under *Driver* and in the release notes of the first version that ships Linux support.

**Risks and notes.** You need a real desktop session — a headless container has no accessibility bus, so "it works on my CI" is not achievable here and we will not ask you to fake it. Check `busctl --user list | grep -i atspi` first; if `org.a11y.Bus` is missing, get the bridge loaded (`NO_AT_BRIDGE=0`, `GTK_MODULES=gail:atk-bridge`) before concluding the driver is wrong. Do not put a permission check inside the driver — permissions belong to `packages/core/src/policy.ts`.

---

## 02 — Multi-display and DPI coordinate mapping

**Title:** `driver: map coordinates across multiple displays and DPI scaling factors`

**Labels:** `bounty`, `driver`, `help wanted`

**Background.** Searching the whole tree for `dpi`, `scaling`, `devicePixelRatio` or `monitor` returns nothing: every driver assumes one display at one scale factor. `window.rect` assertions compare rectangles in whatever space the platform API returns, and `click(ref, sel)` resolves a target to a point in that same space. On a mixed-DPI desk (a 150 % laptop panel next to a 100 % external monitor) those assumptions stop holding and a click lands tens of pixels off. **Reproduce it before you fix it** — the exact failure depends on whether the host process is DPI-aware, and establishing that is part of the deliverable.

**Files and interfaces.**

- `packages/drivers/windows/driver.ps1` / `driver.ts`: report the monitor layout and be explicit about DPI awareness.
- `packages/core/src/types.ts`: add an *additive* capability (for example `screens(): Promise<Screen[]>`). Additive is fine — do not change the meaning of `Rect` or `bounds()`.
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

The test must contain at least one case where naive arithmetic gives the wrong answer, so a future regression is caught instead of tolerated. `node scripts/regress.ts` stays green and `node scripts/snapshot-test.ts` still prints `3/3 snapshots match` — preview snapshots must not move because of a coordinate fix.

**Size:** M — 1–3 days including the reproduction write-up.

**What we provide.** The maintainer's reproduction notes from macOS hardware (the AX bridge already clicks by coordinate there), a review that argues about the abstraction instead of the formatting, and a release-notes mention.

**Risks and notes.** Two traps. "Just multiply by the scale factor" is wrong the moment a window straddles two monitors — handle per-monitor scale, not per-system scale. And `Rect` is part of protocol v0: if you find yourself wanting to change its units, stop and open an RFC ([rfcs/README.md](../rfcs/README.md)), because that invalidates every stored assertion.

---

## 03 — Recorder: right-click, middle-click, wheel and drag

**Title:** `recorder: capture right-click, middle-click, wheel and drag`

**Labels:** `bounty`, `driver`, `recorder`

**Background.** The event-hook rewrite already landed: `packages/drivers/windows/recorder.ps1` registers `Automation.AddAutomationFocusChangedEventHandler` and `AddStructureChangedEventHandler` on `RootElement`, with a 300 ms `-Poll` fallback, and `scripts/recorder-mode-test.ts` proves both modes start and write JSONL. What is still missing is *which* pointer events get through. The low-level mouse hook (`SetWindowsHookEx(14, …)`, i.e. `WH_MOUSE_LL`) filters on one message only: `wParam == 0x0201`, left button down. Right-click, middle-click, wheel and drag are dropped silently, and `docs/recording.md` admits it under *Known limits*.

**Files and interfaces.**

- `packages/drivers/windows/recorder.ps1`: handle `0x0204` (right down), `0x0207` (middle down), `0x020A` (wheel — the high word of `mouseData` is a signed delta), and for drag pair `0x0201` with `0x0202` plus movement beyond a threshold.
- Recording JSONL is an internal schema, **not** protocol v0: add `button: "left" | "right" | "middle"` to click rows and a `wheel` row type carrying `delta`.
- `scripts/draft-skill.ts`: keep generating `ui.click` for left clicks; for every other kind, emit an explicit `// TODO: <kind> at <window> — no Action kind in protocol v0` comment in the draft instead of dropping the event. Silent data loss is the bug.
- `docs/recording.md`: update the three-event-kinds paragraph and the modes table.

**Acceptance criteria.**

```bash
node scripts/recorder-mode-test.ts
# "8/8 passed" today; your version keeps it green and adds cases for the new kinds
```

```bash
node apps/recorder/main.ts --seconds 15 --out .demo/recordings/rec.jsonl
# then, after performing a left click, a right click and a wheel scroll:
node -e "const r=require('fs').readFileSync('.demo/recordings/rec.jsonl','utf8').trim().split(/\n/).map(JSON.parse); console.log([...new Set(r.map(x=>x.type+(x.button?':'+x.button:'')))]  .join(' '))"
# expect output containing: click:left click:right wheel
```

```bash
node scripts/draft-skill.ts --recording .demo/recordings/rec.jsonl --name rec-check --only "."
# the draft contains a TODO comment for every non-left-click event, and
node bin/deskshell.ts run rec-check --mode preview
# still renders a plan
node scripts/regress.ts   # green
```

**Size:** M — 1–3 days. The hook plumbing is small; the drag threshold and de-duplication eat the time.

**What we provide.** A recording session and the JSONL the maintainer produced for comparison; a review that looks for event loss and for the poll fallback staying equivalent; credit as recorder contributor.

**Risks and notes.** `WH_MOUSE_LL` callbacks run on a hook thread and must stay fast — do not call UI Automation inline, enqueue and resolve on the drain thread the way the existing left-click path does. Drag detection needs a distance threshold, or every slightly shaky click becomes a drag. Stay out of protocol v0: a right-click that really needs a new `Action` kind is a separate RFC, and this task deliberately stops at the recording layer.

---

## 04 — Infer `window.rect` assertions from a recording

**Title:** `draft: infer a window.rect assertion when a click moves or resizes a window`

**Labels:** `bounty`, `recorder`, `kernel-adjacent`

**Background.** `scripts/draft-skill.ts` already infers three assertion kinds: a window appearing within 3 s becomes `window.exists`, focus moving within 2.5 s becomes `ui.exists`, and typed text becomes `ui.value`. Geometry is the fourth "the click worked" signal — the one `tile-windows` declares by hand today — and nothing infers it. The real blocker is that recording samples carry no geometry at all: `interface Sample` has `ts / type / window / controlType / name / automationId / value / x / y` and nothing else.

**Files and interfaces.**

- `packages/drivers/windows/recorder.ps1`: include `rect: [x, y, w, h]` on `click` and `window-open` rows (`BoundingRectangle` is already in scope in both handlers).
- `scripts/draft-skill.ts`: `interface Sample` gains `rect`; when a click is followed within 3 s by a geometry change of the same window beyond a tolerance, emit `{ kind: "window.rect", window, rect, tolerance }`.
- `packages/core/src/types.ts` already declares `{ kind: "window.rect"; window; rect; tolerance? }` — no protocol change needed.
- `docs/recording.md`: add the new inference rule to the rules list.

**Acceptance criteria.**

```bash
node apps/recorder/main.ts --seconds 12 --out .demo/recordings/rect.jsonl
# drag a window's title bar during the recording, then:
node scripts/draft-skill.ts --recording .demo/recordings/rect.jsonl --name rect-check --only "."
# expect a window.rect post-assertion in the draft, and the summary line counting it
node bin/deskshell.ts run rect-check --mode preview
# expect the plan to render, with the window.rect step visible
```

```bash
node scripts/snapshot-test.ts   # 3/3 snapshots match — existing drafts must not change
node scripts/regress.ts         # green
```

A negative case must be covered too: a recorded click that does **not** move the window must not produce a `window.rect` assertion.

**Size:** M — 1–3 days, most of it tolerance tuning plus the negative case.

**What we provide.** A recorded session containing a window drag to develop against; a review that argues about the tolerance rule specifically (that is the part we will disagree on); credit as recorder contributor.

**Risks and notes.** Maximized, minimized and animating windows produce garbage rectangles — skip those rows rather than asserting them. Tolerance must be tight enough to catch a real regression and loose enough not to flake; start at 1–2 px and justify the number in the PR. This task depends on **02** for mixed-DPI correctness; if you hit that wall, land the single-display case first and say so.

---

## 05 — Per-action dry-run diffs (`run --diff`)

**Title:** `kernel: per-action dry-run diff output for preview mode`

**Labels:** `bounty`, `kernel`

**Background.** Preview is the default mode and it already prints a plan with a risk level, per-step undoability and a summary. What it does not do is say what the bytes would become. For a skill that rewrites 300 files, "312 steps, low risk" is not enough to approve. Searching for `dryRun` / `dry-run` outside the publish scripts returns nothing — this does not exist.

**Files and interfaces.**

- New: `packages/core/src/diff.ts` — a pure function turning an `Action` into a short human diff (`fs.write` → `+18 -0` with a bounded excerpt, `fs.move` → `a -> b`, `fs.delete` → `-<n> bytes`, `fs.restore` → `restore <n> bytes`).
- `bin/deskshell.ts`: a `--diff` flag on `run`, printed in preview mode only, and carried into `--json` as a `diff` field per step.
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

**Risks and notes.** Do not read whole files to build a diff — cap the bytes and say so in the output. Keep it deterministic across platforms: no absolute paths, no timestamps, no locale-dependent formatting. Do not change default preview output; `scripts/snapshot-test.ts` exists to catch exactly that.

---

## 06 — Undo timeline view (`deskshell timeline`)

**Title:** `cli: deskshell timeline — a time-ordered undo view with per-step undoability`

**Labels:** `good first issue`, `kernel`

**Background.** Undo has more surface than people expect: `deskshell undo --task <id>`, `--last <N>`, `--since <30m|2h|1d>`, plus `deskshell show <taskId>` for one task's steps and `deskshell history` for per-task counts. What is missing is the thing the roadmap asks for: a *time* view answering "what did this machine do in the last hour, and which of it can still be taken back". Today that is `history` → pick an id → `show`, and nothing tells you that a step ran with `undo: null` and therefore cannot be reverted.

**Files and interfaces.**

- `bin/deskshell.ts`: a new `timeline` command with `--since`, `--limit`, `--json`.
- `packages/core/src/journal.ts`: whatever read helper the view needs (a `load()` already exists).
- New test: `scripts/timeline-test.ts`.

**Acceptance criteria.**

```bash
node bin/deskshell.ts timeline --root .demo/downloads
# newest task first: taskId, skill, start time, step count, and a marked count of
# non-undoable steps, e.g.   20 步（18 可撤销 / 2 不可撤销）
```

```bash
node bin/deskshell.ts timeline --root .demo/downloads --json
# expect { tasks: [ { taskId, skill, start, steps, undoable, notUndoable } ] }
node scripts/timeline-test.ts   # "<n>/<n> passed", including a task containing an undo:null step
node scripts/regress.ts         # green — history/show/undo behaviour unchanged
```

**Size:** M — 1–3 days. The reading is trivial; designing the output is the work.

**What we provide.** A journal fixture with a mixed undoable / non-undoable task, a review of the table layout against `history` so the two do not drift, and a release-notes credit.

**Risks and notes.** This is a **read-only** command: it must not undo anything. Do not change the journal schema — existing `.deskshell/journal.jsonl` files must keep working, which the rotation and range tests already police. Column widths and ordering are user-visible API; follow the alignment conventions `history` already uses.

---

## 07 — Remember capability consents (`--ask --remember`)

**Title:** `cli: persist capability consent so --ask does not re-ask every run`

**Labels:** `good first issue`, `kernel`

**Background.** `--ask` already works and is pinned down by `scripts/ask-test.ts`: all-yes proceeds, any-no exits 2 with no side effects, empty input counts as refusal, per-capability interview on a TTY and `y`/`n` lines otherwise. What it does not do is remember. Every run re-interviews, so in practice people pass `--grant` and skip the asking — which defeats the design. `packages/core/src/policy.ts` takes `granted: CapabilityId[]` as an argument and stores nothing.

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

**Risks and notes.** Consent that silently widens is a security bug. A reused grant must be printed, `--forget` must really delete, and a stored grant must never apply to another skill or a wider scope. A corrupt `grants.json` is treated as absent and re-asks — never as "everything allowed". This touches the CLI and policy only, not protocol v0.

---

## 08 — Full-text search in the docs site

**Title:** `docs: full-text search across pages instead of the sidebar title filter`

**Labels:** `good first issue`, `docs`

**Background.** The built site already has a search box — `#nav-search` — and it is a decent progressive enhancement, but it only filters `.nav-item` link text, i.e. page titles. A reader who remembers the word "tolerance" but not the page gets nothing. `scripts/build-docs.ts` generates the entire bilingual site with no third-party assets, and that constraint stays.

**Files and interfaces.**

- `scripts/build-docs.ts`: emit a search index at build time (for example `site/en/search-index.json` and `site/zh-CN/search-index.json`) built from page HTML — heading text, anchor ids, and a bounded body excerpt per heading section.
- The injected script in the same file: query the index, render hits as page + heading links, and keep today's title filter as the empty-query state.
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

Manual check written into the PR: open `site/en/index.html`, type a word that only appears in a page body, get a hit, click it, land on the right anchor. With JavaScript disabled the page behaves as it does today (filter hidden, layout intact).

**Size:** M — 1–3 days. Indexing is easy; keeping the payload small and the UI honest is the work.

**What we provide.** A review of the generated HTML for accessibility and for the no-JS path, and your name under *Docs* in `CONTRIBUTORS.md`.

**Risks and notes.** No third-party search library, no CDN, no build-time service — the site must stay openable offline from `file://`. Strip tags and navigation chrome from the indexed text or every page matches every query. Cap the excerpt length.

---

## 09 — Random fault injection soak

**Title:** `scripts: flake-soak — random fault injection on top of --fail-at`

**Labels:** `good first issue`, `testing`

**Background.** `apps/cli-demo/fail-story.ts` takes `--fail-at <step>` and proves that a failure at a chosen step rolls everything back and lands in the journal. That is a *deterministic* failure at a step you picked. Flakiness comes from failures you did not pick: the first step, the last step, twice in a row, during a rollback. There is no random injection anywhere in the tree today.

**Files and interfaces.**

- New: `scripts/flake-soak.ts`. For N runs, inject a failure at a random step (bounded by plan length), then assert the invariant after each run: side effects gone, journal holds exactly one failed step, the report carries the rollback count, and a second undo is a no-op. `scripts/undo-test.ts` proves idempotence for one case; you are generalising it.
- Reuse the fixture and helper style from `apps/cli-demo/fail-story.ts` and parameterise its failure injection instead of writing a second mechanism.

**Acceptance criteria.**

```bash
node scripts/flake-soak.ts --runs 20
# one line per run:  run 7/20  fail-at step 13/20  rolled back 12  journal ok  PASS
# final line: "20/20 runs rollback-consistent"
# exit 0; any inconsistency prints the offending journal path and exits non-zero
```

```bash
node scripts/flake-soak.ts --runs 5 --seed 42   # same seed, same steps — reproducible
node scripts/regress.ts                          # green
```

**Size:** S — half a day, plus however long you keep finding bugs with it.

**What we provide.** The failed-run journal from any soak you publish, a review that insists the seed is reproducible, and a release-notes credit.

**Risks and notes.** This run the kernel dozens of times against the filesystem — keep everything under `.demo/` and clean up between runs or you will leave orphan directories behind. A soak that only ever fails at step 3 is not a soak: assert the random steps actually spread across the plan. If it finds a real kernel bug that is a **success** — open a separate `bug` issue and link it; do not fix the kernel inside this PR.

---

## 10 — New skill: `screenshot-dedupe`

**Title:** `skill: screenshot-dedupe — collapse near-identical screenshots, keep the earliest`

**Labels:** `good first issue`, `skill`

**Background.** Two existing skills are adjacent but neither does this. `dedupe-folders` hashes file *content*, so it only catches byte-identical copies. `screenshot-organize` groups screenshots by date into `YYYY/MM/` and prefixes the time. What people actually have is bursts: six screenshots of the same dialog, differing only in a caret blink. That case is unserved, and it is an ideal first skill because it is filesystem-only — it runs on every platform, including Linux without a driver.

**Files and interfaces.**

- `node scripts/new-skill.ts --name screenshot-dedupe` scaffolds `packages/skills/screenshot-dedupe/{index.ts,skill.json}`; after that only `plan()` changes.
- Manifest: `fs.read` and `fs.write` scoped to `"{{root}}"` with a plain-language `reason` each. The kernel rejects actions not covered by a declared capability, so an over-broad scope gets refused.
- Zero dependencies: read dimensions from the PNG `IHDR` header and the JPEG `SOF` marker (a few dozen lines) — no image library.
- Fixture: `scripts/make-screenshot-fixture.ts` (new), generating PNGs of known dimensions and mtimes.
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

**Risks and notes.** "Near-identical" is a policy decision, not an algorithm: same dimensions plus a small mtime window is defensible and explainable, and the rule must sit in the skill's `description` so the user sees it before applying. No deleting, no overwriting, and no deduping across directories in v1.

---

## 11 — New skill: `browser-download-sort`

**Title:** `skill: browser-download-sort — sort a browser download folder by type and name pattern`

**Labels:** `bounty`, `skill`

**Background.** `browser-tabs` reads browser *windows* through the UI tree (Windows and macOS only). `downloads-cleanup` sorts by extension alone. Nobody sorts a download folder using what the filenames actually say — `report (3).pdf`, `setup-x64.exe`, `invoice_2026-03.pdf` — even though that information is right there. Filesystem-only, so it works on all three platforms today.

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

**Risks and notes.** Two files that would land on the same target must make the step fail loudly rather than silently overwrite — `rename-batch` already set that precedent; follow it. Do not read browser history databases, do not touch anything outside `{{root}}`.

---

## 12 — New skill: `pdf-merge` (zero-dependency)

**Title:** `skill: pdf-merge — merge PDFs without adding a dependency`

**Labels:** `bounty`, `skill`, `hard`

**Background.** No skill under `packages/skills/` touches PDFs, and the honest reason is that merging PDFs is real work: object graphs, cross-reference tables, trailer dictionaries, page trees, compressed streams. The zero-dependency invariant rules out `pdf-lib` and friends, so this is either a carefully bounded implementation or nothing. It is on the board because the bounded version is genuinely doable.

**Files and interfaces.**

- `packages/skills/pdf-merge/{index.ts,skill.json}` with `fs.read` + `fs.write` on `"{{root}}"`.
- A minimal PDF reader/writer next to the skill (or under `packages/core/src/` if it is genuinely reusable — say which and why in the PR): parse `startxref` → xref table → trailer → `/Root` → `/Pages` → `/Kids`, copy page objects into a new document, write a fresh xref and trailer.
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

Three items from older roadmap drafts are **done**, and stale requests for them keep arriving. If you want to work in one of these areas, take the follow-up task above instead.

| Already shipped | Proof you can run yourself |
| --- | --- |
| `deskshell run a b --parallel` — several skills in one invocation, one failing does not stop the others | `node scripts/parallel-test.ts` → `7/7 passed` |
| Interactive capability consent in the terminal (`--ask`, per capability, TTY or piped) | `node scripts/ask-test.ts` → `8/8 passed` — the remaining gap is task **07** |
| Recorder on UIA event hooks (`FocusChanged` + `StructureChanged`) with a `-Poll` fallback instead of pure 300 ms polling | `node scripts/recorder-mode-test.ts` → `8/8 passed`; both modes documented in `docs/recording.md` — remaining gaps are tasks **03** and **04** |

Also already true, and worth knowing before proposing a shortcut: every action needs a `post` assertion and an `undo`; actions with `undo: null` are rejected by the kernel; the kernel has no model dependency and adding one is not on the table.

## What the maintainer will not accept

Stated once here so nobody discovers it three days in — the same list appears in [CONTRIBUTOR-LADDER.md](CONTRIBUTOR-LADDER.md) and [GOVERNANCE.md](GOVERNANCE.md):

- A demo-only script that works once on the author's machine and has no assertion or no undo.
- A change to protocol semantics (action kinds, assertion kinds, undo contract) smuggled into a feature PR. That is an RFC.
- A new third-party runtime dependency without an RFC.
- A driver that does its own permission checks — permissions belong to `packages/core/src/policy.ts`.
- A "bypass" that widens capability scope to make a skill convenient.
