<p align="center"><img src="brand/logo-mark.svg" width="72" alt=""></p>

# Security policy

deskshell is a tool whose entire purpose is to operate a computer on someone's behalf. That makes its security model unusual, and worth stating plainly before anything else.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` | ✅ yes — fixes land here |
| `< 0.1.0` | ❌ never released; no support |

We are pre-1.0. The protocol is `v0`. Breaking changes bump the minor version (`0.1 → 0.2`) and ship with a migration note in [CHANGELOG.md](CHANGELOG.md); fixes go out as patches. Security fixes are backported to the latest `0.1.x` patch only — there is one supported line, not a matrix.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private advisory form:

👉 https://github.com/ciceroyang/deskshell/security/advisories/new

That channel is private between you and the maintainers, gives us a place to develop and review a fix, and lets us credit you in the published advisory.

Please include, as far as you can:

- what you did, in reproducible steps (the exact `deskshell` command, skill manifest, or driver call);
- the version (`node bin/deskshell.ts version`) and platform;
- what you expected the policy layer to do, and what it did instead;
- the journal tail if the run produced one (`<root>/.deskshell/journal.jsonl`, one JSON object per line) — it is the audit trail and usually contains the answer;
- a proof of concept, if you have one. A failing test is worth more than a paragraph.

What to expect:

| Stage | Target |
| --- | --- |
| Acknowledgement that a human read it | 72 hours |
| Initial triage: in scope / out of scope, severity | 7 days |
| Fix or documented mitigation for confirmed issues | 30 days for high severity, next minor for the rest |
| Public advisory | coordinated with you; 90 days by default |

If a fix is going to take longer than that, we will say so and keep you updated rather than let the report rot.

## Scope: what this tool is supposed to do

**deskshell is not sandboxed by accident — it is sandboxed by policy, and the policy is the product.**

> **An agent deleting files after the user grants `fs.write` is expected behaviour, not a vulnerability.**

The same holds for every capability: an agent that deletes, moves, overwrites or window-moves **after the user has granted the matching capability is the tool working as designed.** An agent that does any of that *without* the capability being granted is a serious bug — that is the vulnerability. Concretely:

- `fs.write` covers `fs.write`, `fs.move`, `fs.mkdir` **and `fs.delete`** (`packages/core/src/policy.ts`). A user who grants `fs.write` on a root has granted deletion inside that root. "The agent deleted my file" is expected behaviour; the undo journal is the answer to it, and the preview is the answer before it.
- `ui.input` covers typing, clicking, invoking UI elements and moving windows. A skill that clicks the wrong button, or types into the wrong field, is a bug in that skill's plan — not a policy bypass.
- A model producing a bad plan, a skill with a wrong `post` assertion, or a bad prompt is a skill-quality problem. That belongs in a normal issue, not a security advisory.

If your report is "I granted broad capability and got broad capability", it will be closed as working-as-intended — politely, and with a pointer to `preview` and `undo`.

### In scope — real vulnerabilities

These are the things worth a private advisory:

1. **Policy bypass** — an action that executes without the capability it requires being declared *and* granted. Includes: an action kind missing from `ACTION_CAPABILITY` so nothing is checked; a skill that smuggles a destructive action under a benign `kind`; the executor running an action the policy layer rejected; a declared capability being treated as decorative.
2. **Path escape** — any `fs.*` action that reads, writes, moves or deletes outside the task `root` (`isInside()` in `packages/core/src/policy.ts`). Includes `..` traversal, absolute paths, symlink/junction/8.3-short-name tricks, UNC paths, `\\?\` prefixes, case-folding on Windows, and TOCTOU between the check and the syscall.
3. **Rollback failure** — an apply → undo cycle that does not return the filesystem to a byte-identical state, a partial rollback silently reported as complete, an orphaned side effect that later blocks rollback (`ENOTEMPTY`, for example), or a journal that claims a rollback that did not happen. The guarantee is "fully done, or back where you started" — a break in it is a security bug, because it silently destroys data.
4. **Driver memory safety** — the macOS AX bridge (`packages/drivers/macos`) and the Windows UI Automation driver are native code reached from untrusted input (another process's UI tree). Out-of-bounds reads, use-after-free, unchecked lengths, or a malformed accessibility tree that crashes or corrupts the host process are in scope.
5. **Journal / audit integrity** — forging, truncating, or silently dropping journal entries so a run cannot be reconstructed; a journal path the skill can choose.
6. **Capability scope confusion** — a granted scope that is enforced against a different path than the one acted on; `{{root}}` substitution that can be influenced by the skill.

### Out of scope

- Anything covered by "you granted the capability" above — including file deletion, overwriting, and window moves inside a granted root.
- Running a skill you found somewhere and did not read. Skills are code; `deskshell add` prints the capabilities it requests precisely so this decision is informed.
- External side effects that end up not being undone. Network calls, sent emails and hard deletes cannot be rolled back; the protocol rejects actions with `undo: null`, and `docs/undo-and-trust.md` documents the boundary.
- Missing platform coverage (no Linux driver yet) and known UI limitations (no coordinate clicks on macOS, 300 ms recorder polling). These are documented limits, not vulnerabilities.
- Automated-scanner output with no demonstrated impact, missing hardening headers on the docs site, and anything requiring an already-compromised local account with write access to the repo.
- Social engineering of maintainers, and denial of service against the project's own CI.

## Handling

We develop and review fixes in a private fork, land the fix with a regression test that fails without it, and publish the advisory with the patched version. Credit goes to the reporter unless asked otherwise. We do not operate a paid bounty programme; we do operate a "we will actually fix it and tell you when it ships" programme.

## Related

- [docs/undo-and-trust.md](docs/undo-and-trust.md) — what undo guarantees, and where it stops
- [docs/protocol.md](docs/protocol.md) — capability declarations and what the kernel enforces
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to send a fix
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — how we treat each other while doing it
