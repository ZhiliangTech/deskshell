<p align="center"><img src="../brand/banner.svg" alt="deskshell" width="760"></p>

# deskshell docs

> **An OS runtime for agents.** The machine as a toolbox; every action a declared contract — asserted, undoable, audited — and no model in the kernel.

deskshell is not an agent that clicks. It is the layer that turns the whole machine into something an agent can call safely: **the OS as a tool, not a surface to poke**. It separates **what to do** from **how to do it safely**:

- **Skill** — declares intent only (`plan() → Action[]`). Never touches system APIs, never writes rollback code.
- **Kernel** — permissions, preview, execution, assertions, rollback, journal. The layer with a frozen interface.
- **Driver** — platform-specific (Windows UIA / macOS AX / Mock), fully replaceable.

## Three commands, thirty seconds

```bash
npm run demo     # four steps succeed, the fifth fails, everything rolls back, directory is byte-identical
npm run r0       # R0: residue / rollback / traceability rates under 15 injected failures
npm run mcp      # the same kernel as an MCP server (skills / preview / apply / undo)
```

Each one is backed by a test that fails the build if the claim stops being true: `scripts/thirty-seconds-test.ts`, `scripts/recovery-bench.ts`, `scripts/mcp-test.ts`.

## Build it with us

Twelve scoped tasks, each with an acceptance command — and no cash bounty. What you get instead: ownership of what you build, your name in the contributors file, and a roadmap vote after two merged PRs.

- [Contributor board](https://github.com/ZhiliangTech/deskshell/issues/3) — claim a task with one comment
- [The task list](https://github.com/ZhiliangTech/deskshell/blob/main/outreach/GOOD-FIRST-ISSUES.md) — acceptance criteria, sizes, what we provide
- [Discussions](https://github.com/ZhiliangTech/deskshell/discussions) — questions and the roadmap vote

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
