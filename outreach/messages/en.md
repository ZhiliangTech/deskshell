# Outreach copy — English

For developers who have never heard of this project. One job: get them to spend 30 minutes, and make the first step obvious.

---

## How to use this file

1. **Personalize the first line or do not send it.** Every template starts with `{why_them}` — one specific sentence about *their* project, issue, or post. If you cannot write that sentence, this person is not a lead yet.
2. **Every piece ends with a 30-minute action.** There are only three allowed: run `doctor`, write one skill, claim one issue. Do not invent a fourth, and never end with "let me know what you think".
3. **Facts only from the repo.** Numbers you may use: Node >= 22.18; 8 action kinds / 7 assertion kinds / 5 undo kinds / 7 capability ids (frozen in `spec/protocol-v0.json`); the driver interface is 6 required methods + 2 optional ones; the recorder runs on UIA event callbacks (20 ms fallback) and captures focus, left clicks and window opens; `scripts/regress.ts` passes 39/39 on a clean checkout. Nothing about users, stars, adoption, or speed.
4. **Do not claim what is not true.** Linux is window-level only — an X11 driver on xdotool + wmctrl exists, control-level AT-SPI2 doesn't. There is no public npm package yet (installer, GitHub Packages, or clone). The recorder doesn't capture drag, right-click menus or wheel.
5. Replace `{name}`, `{project}`, `{issue_url}`, `{repo_url}`. Never send with a placeholder still in it.

Canonical one-liner: **The machine as a toolbox inside your agent — every action is declared, asserted, undoable, audited, and there is no model in the kernel.**

---

## 1. Cold DM, short (~60 words)

### 1A. To a driver / UI-automation author

> Hi {name} — {why_them}
>
> I'm building deskshell: a kernel where every desktop action must declare a post-assertion and an undo, and one failed assertion rolls the whole task back. Windows (UIA), macOS (AX bridge) and Linux (X11, window-level) drivers exist. What Linux lacks is the control layer — selector-scoped click and invoke on AT-SPI2 — and that's the missing piece.
>
> 30 minutes: clone it, run `node bin/deskshell.ts doctor`. {repo_url}

### 1B. To a skill / scripting author

> Hi {name} — {why_them}
>
> deskshell asks a different question from most automation tools: what if a step had to prove it worked? Skills declare intent only (`plan() → Action[]`), every action carries a post-assertion and an undo, and the kernel handles preview, rollback and a JSONL journal. No model inside the kernel.
>
> 30 minutes: `node scripts/new-skill.ts --name my-skill`, then `run my-skill --mode preview` — nothing executes without `--mode apply`. {repo_url}

---

## 2. Cold DM, long (~120 words)

### 2A. To a driver author

> Hi {name} — {why_them}
>
> I built the layer under UI automation that refuses to trust it.
>
> In deskshell a skill only produces actions; each action must declare a post-assertion ("how we know it worked") and an undo. Preview is the default — `run` does nothing without `--mode apply`. When an assertion fails, the kernel undoes that action's own side effects, then rolls the rest back in reverse, and journals the failure. The protocol is frozen as v0 in `spec/protocol-v0.json`.
>
> The driver interface is what I'd want your opinion on — it's six required methods (`windows`, `tree`, `invoke`, `click`, `type`, `keys`) plus two optional ones (`bounds`, `moveWindow`) — and the Linux control layer (AT-SPI2 selector-scoped click/invoke) doesn't exist yet; window-level works.
>
> 30 minutes: `node bin/deskshell.ts story --fail` — watch it roll back. If the interface is wrong for your platform, say where. {repo_url}

### 2B. To a skill author

> Hi {name} — {why_them}
>
> I keep running into the same failure: an automation script does four things correctly, the fifth silently doesn't, and you're left with a half-modified machine and no record of what happened.
>
> deskshell is my answer to that. A skill declares intent only — `plan() → Action[]` — and never calls system APIs. Every action needs a post-assertion and an undo; the kernel does permission checks, preview, execution, assertions, rollback and a JSONL audit log. The kernel has no model dependency at all: models can only live behind two replaceable interfaces, `see()` and `plan()`, inside a skill. It runs offline, no API key.
>
> Status: Windows verified, macOS verified on hardware, Linux window-level (X11, xdotool + wmctrl); Linux control-level (AT-SPI2) not implemented.
>
> 30 minutes: `node scripts/new-skill.ts --name my-skill`, edit only `plan()`, then `node bin/deskshell.ts run my-skill --mode preview`. If your first skill is something you actually need, I'll review it the same day. {repo_url}

---

## 3. Email

**Subject:** {name} — a kernel where every desktop action has to prove it worked

> Hi {name},
>
> {why_them}
>
> I'm writing because of one problem: an AI or a script clicks something, and afterwards nobody can say what changed or how to get back.
>
> deskshell makes that structural instead of aspirational. Actions declare a post-assertion and an undo. Preview is the default — nothing runs without `--mode apply`. A failed assertion stops the run, undoes that action's own side effects, then rolls back everything else in reverse. Every step — including the failures — lands in a JSONL journal with the undo recipe attached. The protocol is frozen as v0 (`spec/protocol-v0.json`), and the kernel contains no model; models only appear behind `see()` / `plan()` inside a skill.
>
> Two honest limitations: the Linux driver is window-level only, so control-level AT-SPI2 isn't there yet, and there is no public npm package — install is a PowerShell installer, GitHub Packages, or a clone.
>
> If this is useful for {project}, the cheapest next step is 30 minutes:
> `git clone {repo_url} && cd deskshell && node bin/deskshell.ts doctor`
> `node bin/deskshell.ts story --fail` shows the rollback.
>
> If it isn't useful, tell me why in one line — that is more valuable to me than a polite yes.
>
> {your_name}

---

## 4. Technical comment in someone else's issue

Rule: **the first 80% of the comment must be useful even if nobody clicks the link.** The project gets one sentence at the end, and only when it is genuinely on-topic.

### 4A. In a UI-automation bug thread (flaky click, wrong element, silently no-op)

> Reproduced something close to this on {platform} with {tool} {version}.
>
> What made it deterministic for me: the click succeeded against a stale element handle. After the tree refreshes, the handle still resolves, the call returns success, and nothing observable changes. Two checks that catch it cheaply:
>
> 1. Assert on the *effect*, not the call — after clicking, poll the expected state (value changed, window count changed, file appeared) with a short deadline, and fail loudly on timeout.
> 2. Capture the element's bounding box before the click and re-resolve by that geometry if the handle is stale.
>
> If you want a reference for doing (1) generically: I've been building deskshell around exactly that — every action must carry a post-assertion and an undo, so a silently-failed click stops the run instead of continuing. `spec/protocol-v0.json` has the assertion kinds. Not a fix for this issue, but it is the missing assertion layer, if that's where this is heading.
>
> Happy to test a patch on {platform} if you get one.

### 4B. In a "AI agent did something wrong on my desktop" thread

> The interesting part of this failure isn't the wrong click — it's that nothing stopped after it.
>
> Three things would have contained it, none of them model-side:
>
> - **Pre-execution preview**: list the concrete actions (kind + target + risk) before anything runs. Most bad runs are visible at this stage.
> - **Post-assertion per step**: "the tab count went from 6 to 5" — if it's false, halt instead of continuing on a corrupted state.
> - **A declarative undo per step**: not a screenshot rollback, an actual inverse operation (`fs.move` back, `window.move` back to the recorded rect).
>
> The hard part is (3): it forces you to decide, before acting, how you'd reverse it — which in practice also kills a lot of actions that should never have been automated.
>
> I've been implementing this as a protocol (deskshell, MIT). The frozen v0 spec lists 8 action kinds, 7 assertion kinds, 5 undo kinds, and rejects any action with `undo: null`. It is not a product recommendation — the useful part is that the constraints are written down rather than implicit.
>
> The 30-minute check, if you want one: `node bin/deskshell.ts story --fail` and watch a rigged failure undo itself. {repo_url}

### 4C. Pull request description for an awesome-list

> Adds deskshell — a protocol-first kernel for AI/scripted desktop operations.
>
> Why it belongs here: it is not another wrapper over a click API. It defines a frozen protocol (v0) where every action carries a post-assertion and an undo, preview is the default mode, failed assertions trigger rollback, and every step is written to a JSONL audit log. The kernel has no model dependency.
>
> - License: MIT
> - Runtime: Node >= 22.18, zero third-party runtime dependencies
> - Platforms: Windows (UIA, verified), macOS (Swift AX bridge, verified on hardware), Linux (window-level X11 via xdotool + wmctrl; control-level AT-SPI2 not implemented)
> - Why it may not fit: no public npm package yet, pre-1.0, one maintainer. Happy to be declined on those grounds.

---

## 5. Show HN

### Titles (pick one, keep the `Show HN:` prefix)

1. `Show HN: Deskshell – every desktop action is previewed, asserted, and undoable`
2. `Show HN: A protocol for letting an AI click things without trusting it`
3. `Show HN: Deskshell – transactional semantics for desktop automation`
4. `Show HN: Preview, post-assertion, undo, JSONL audit – a kernel with no model in it`
5. `Show HN: I built undo for AI-driven desktop actions (Windows and macOS verified)`

*Pick #1 or #2. #4 and #5 describe it accurately but read like changelogs; HN rewards a claim you can check.*

### Body

> I kept hitting the same failure mode with scripted desktop work: four steps work, the fifth silently doesn't, and you're left with a half-modified machine and no idea what changed.
>
> deskshell treats a desktop task like a transaction.
>
> - A skill declares intent only: `plan() → Action[]`. It never calls system APIs.
> - Every action must declare a **post-assertion** ("this is how we know it worked") and an **undo**.
> - **Preview is the default**: `run` does nothing without `--mode apply`.
> - A failed assertion stops the run, undoes that action's own side effects, then rolls back the rest in reverse.
> - Everything, including failures, goes into a JSONL journal with the undo recipe attached.
> - The kernel has **zero model dependency**. Models can only live behind `see()` and `plan()`, inside a skill. It runs offline, no API key.
>
> The protocol is frozen as v0 in `spec/protocol-v0.json`: 8 action kinds, 7 assertion kinds, 5 undo kinds, 7 capability ids. New fields must be backward compatible; anything else needs an RFC.
>
> Try it in 30 seconds: `git clone`, `node bin/deskshell.ts doctor`, then `node bin/deskshell.ts story --fail` — the third step is rigged to fail and you can watch it roll back to the starting state.
>
> What is honestly not there: the Linux driver is window-level only — control-level AT-SPI2 isn't implemented — the recorder misses drag, right-click menus and wheel, undo covers file and window-geometry changes but not network side effects (the protocol rejects actions with `undo: null`), and there's no public npm package — the installer, GitHub Packages or a clone are the three ways in.
>
> I'd most like feedback on the protocol shape: whether seven assertion kinds are enough to describe "the click worked" without letting people cheat with weak assertions.
>
> MIT, Node >= 22.18, no third-party runtime dependencies.
>
> If you only have 30 minutes: `node bin/deskshell.ts doctor`, then `node bin/deskshell.ts story --fail`. That's the whole demo.

*Notes: post Wed/Thu morning US Eastern; stay in the comments for three hours; answer "why not just use Playwright" with the technical answer from OBJECTIONS.md, not defensively.*

---

## 6. Reddit

Post to one subreddit at a time, spaced across days. Read the current sidebar and pinned rules first — karma and account-age gates vary, and most subs expect roughly a 9:1 ratio of participation to self-promotion.

### r/computeruse, r/LocalLLaMA — title

`Every desktop action has to prove it worked, or the whole task rolls back — deskshell (MIT)`

### r/opensource, r/automation — title

`A frozen protocol for undoable desktop automation: post-assertions per action, preview by default, JSONL audit`

### Body

> I got tired of automation that reports success and leaves a mess, so I built the layer that refuses to trust it.
>
> Concrete mechanics, since that's the only interesting part:
>
> - A skill only produces actions (`plan() → Action[]`) — no system calls, no rollback code in the skill.
> - Each action declares a **post-assertion** and an **undo**. The protocol rejects `undo: null` unless it's explicitly marked non-undoable.
> - **Preview is the default**: without `--mode apply`, nothing happens.
> - On a failed assertion the kernel undoes that action's own side effects first, then rolls back the rest in reverse.
> - Every step, failures included, is appended to a JSONL journal: task id, skill, action id, kind, summary, status, hash, detail, undo.
> - No model anywhere in the kernel. Models sit behind `see()` / `plan()` inside a skill. Runs offline.
>
> Protocol v0 is frozen in `spec/protocol-v0.json`: 8 action kinds, 7 assertion kinds, 5 undo kinds, 7 capability ids. Backward-compatible additions only; semantic changes need an RFC.
>
> 30-minute test:
>
> ```
> git clone {repo_url} && cd deskshell
> node bin/deskshell.ts doctor
> node scripts/make-fixture.ts
> node bin/deskshell.ts run downloads-cleanup --root .demo/downloads            # preview only
> node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode apply
> node bin/deskshell.ts run downloads-cleanup --root .demo/downloads --mode undo
> node bin/deskshell.ts story --fail                                            # watch a failure roll back
> ```
>
> Limits, up front: **Linux is window-level only** (X11 via xdotool + wmctrl; control-level AT-SPI2 not implemented), the recorder misses drag, right-click menus and wheel, undo doesn't cover network side effects, no public npm package yet (installer / GitHub Packages / clone), pre-1.0.
>
> What I actually want from this post: pushback on the assertion model. Is "post-assertion per action" the right place to put the trust boundary, or does it belong at the task level?
>
> 30-minute version, if you'd rather just look: `node bin/deskshell.ts doctor` — one command, tells you whether your platform is supported at all.

---

## 7. X / Twitter thread (5 posts)

> **1/5**
> Every desktop automation I've written has the same bug: step 5 silently fails, steps 1–4 already happened, and nothing tells you.
>
> So I made the failure expensive to ignore: every action must declare how you'll know it worked, and how to undo it.

> **2/5**
> A skill only produces actions. plan() → Action[].
> Each action carries a post-assertion and an undo.
> Preview is the default — `run` does nothing without `--mode apply`.
> No system calls in skills, no rollback code in skills.

> **3/5**
> When an assertion fails:
> 1. undo the failing action's own side effects
> 2. roll back the rest in reverse
> 3. write the failure to the journal
>
> `deskshell story --fail` lets you watch all three happen.

> **4/5**
> The kernel has no model in it. None. Models live behind see() / plan() inside a skill, and can be swapped or removed. It runs offline with no API key.
>
> Protocol v0 is frozen: 8 action kinds, 7 assertion kinds, 5 undo kinds, 7 capability ids.

> **5/5**
> Honest status: Windows (UIA) and macOS (AX bridge) verified. Linux is window-level only (xdotool + wmctrl); the AT-SPI2 control layer is the open piece. Recorder misses drag/right-click/wheel. 39/39 regressions pass.
>
> 30 min: clone, `node bin/deskshell.ts doctor`. MIT.

---

## 8. Discord / Slack self-introduction

> Hi — I'm {your_name}, I build desktop automation tooling. I lurk here mostly to steal ideas about element trees.
>
> The thing I've been working on for a while: deskshell, an MIT kernel for computer-use where the interesting constraint is that **every action must declare a post-assertion and an undo**, preview is the default mode, and a failed assertion rolls the whole task back instead of continuing. Protocol is frozen as v0. No model in the kernel — models only sit behind `see()` / `plan()` in a skill.
>
> Windows and macOS verified on hardware; Linux has a window-level X11 driver, the control layer on AT-SPI2 is still open. Repo: {repo_url}
>
> I'm mostly here for the hard parts: multi-display coordinate mapping, the Linux control layer on AT-SPI2, and how people decide what "the click worked" means. If anyone's fighting a flaky `click()`, I have opinions and a repro harness — happy to dig in on your issue instead of talking about mine.
>
> If you want to poke at it in 30 minutes: clone, `node bin/deskshell.ts doctor`, then `node bin/deskshell.ts story --fail`.

---

## 9. Follow-up 1 (send 5–7 days after first contact, only with something new)

> Hi {name} — following up once, with something concrete rather than a reminder.
>
> Since I wrote: I opened {issue_url} for the piece I mentioned ({one_line_about_the_issue}). If that specific problem is one you've hit, the issue has the repro and the acceptance criteria, so it's claimable without reading the whole codebase.
>
> If the timing is wrong, no problem — I'll close the loop in a week and then leave you alone.
>
> 30-minute version if you want the fast look: `node bin/deskshell.ts doctor`. {repo_url}

---

## 10. Follow-up 2 (the last one — give them an exit)

> Hi {name} — last message from me on this, so you can stop reading here with a clear conscience.
>
> No reply needed. Two options, pick either:
>
> - **Interested later** — watching the repo is enough: {repo_url}. Everything that lands goes into CHANGELOG.md with migration notes.
> - **Not interested** — reply "no" and I'll take you off my list permanently.
>
> For the record, what I was going to ask for: 30 minutes on `node bin/deskshell.ts doctor`, and one sentence about whether the post-assertion model is the right place to put the trust boundary. That's it.

---

## 11. Reply after a decline

> Thanks for the straight answer — that's more useful than silence.
>
> Taking you off the list; you won't hear from me about this again.
>
> One thing, only if it's free: was it the problem (you don't have this failure mode), the project (not convinced it solves it), or the timing? One line is plenty. If it's the second, I'd rather know now than after building more on it.
>
> Either way — good luck with {project}.
