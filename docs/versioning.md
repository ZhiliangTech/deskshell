<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Versioning

The foundation of an ecosystem is "the interface does not change at 2 a.m.". Version policy comes before features.

## Version numbers

- `core` is `0.x`; the protocol is `v0`;
- breaking changes bump the minor (`0.1 → 0.2`) and ship with a migration note;
- fixes go in patch releases, as often as weekly;
- a commit that "quietly changes semantics" without a version bump is reverted.

## Skills declare a protocol version

```json
{
  "name": "downloads-cleanup",
  "version": "0.1.0",
  "protocol": "0",
  "entry": "./index.ts"
}
```

The kernel checks `protocol` on load:

- exact match: load normally;
- major mismatch: refuse to load and tell the user the skill needs an update;
- missing field: assume current, but print a deprecation warning.

## Breaking-change process

1. Open an RFC under `rfcs/`: what changes, why, which skills are affected, how to migrate;
2. at least 7 days of discussion;
3. ship a compatibility shim or a migration script with the change;
4. put a three-step migration guide at the top of the CHANGELOG entry.

## Snapshot tests

Every skill runs two checks in CI:

- **preview snapshot** — fixed input must produce a fixed plan (a kernel upgrade must not silently change behaviour);
- **rollback test** — apply then undo must return the filesystem to a byte-identical state.

This is the last gate against "an upgrade broke someone else's skill".

## Deprecation

- after `@deprecated`, keep the behaviour for at least two minor versions;
- warn once at runtime during the deprecation window, never hard-fail;
- removal requires a codemod or a migration document.

## Layout

```
rfcs/          proposals
docs/          this site (English)
docs/zh-CN/    Chinese translation
CHANGELOG.md   release notes
```

The most valuable asset of an ecosystem project is not the code — it is whether people dare depend on it. Version discipline *is* that asset.
