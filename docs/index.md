<p align="center"><img src="../brand/banner.svg" alt="deskshell" width="760"></p>

# deskshell docs

> A protocol-first shell for AI computer control. Every action is previewed, verified, undoable, and audited.

deskshell is not a pile of "AI clicks the mouse" scripts. It separates **what to do** from **how to do it safely**:

- **Skill** — declares intent only (`plan() → Action[]`). Never touches system APIs, never writes rollback code.
- **Kernel** — permissions, preview, execution, assertions, rollback, journal. The layer with a frozen interface.
- **Driver** — platform-specific (Windows UIA / macOS AX / Mock), fully replaceable.

## Three concepts

**Capability** — what a skill asks for, with a scope and a plain-language reason. Users can refuse.

**Action** — one step. Must declare a `pre` condition, a `post` assertion, and how to `undo` itself.

**Journal** — append-only JSONL. What ran, whether it succeeded, how to undo it.

## Why protocol first

Most "AI operates the computer" projects die in the same place: the demo works, but nobody dares use it. Users don't know what it will do next, and they don't know how to recover when it goes wrong.

deskshell makes trust part of the protocol:

- an action without a post-assertion is rejected;
- an action that cannot be undone is rejected by default;
- a path outside the declared scope is blocked.

## What exists today

- Protocol v0 + kernel (TypeScript, zero dependencies)
- Windows UIA driver (verified) and macOS native AX bridge (verified on hardware)
- Mock driver with 11 contract tests (kernel is platform-agnostic)
- Four usable skills, plus a recorder that turns a human session into a skill draft
- Nine CLI commands, eleven assertions, JSONL audit, preview snapshots
- This docs site, built from Markdown with `node scripts/build-docs.ts`

## Where to go next

- [Quick start](quickstart.html) — run it in 30 seconds
- [Protocol v0](protocol.html) — the five types and the invariants
- [Writing a skill](writing-a-skill.html) — 30 lines to a working skill
- [Undo and trust](undo-and-trust.html) — why rollback lives in the kernel
- [Recipes](recipes.html)
- [Recording](recording.html) — record once, get a draft skill
- [Drivers](drivers.html)
- [Internals](internals.html) — what each platform can and cannot do
- [Versioning](versioning.html) — how the interface stays stable
- [Roadmap](roadmap.html)
- [FAQ](faq.html) — what is next, and what needs a decision
