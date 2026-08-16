---
description: Before running, adding, or removing a script in scripts/
authority: What each script does, whether it is safe to run, and where new ones belong
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# scripts/

Everything here is a development or test utility. **No script in this directory touches production,
publishes anything, or mutates user data** — release side effects live in
[`docs/operations/CLAUDE.md`](../docs/operations/CLAUDE.md) instead. Keep it that way: a script that
gains an outward-facing effect belongs there, documented, not here.

## Entry points

| Script | Kind | Purpose | Side effects |
|---|---|---|---|
| `prepublish-check.cjs` | manual / CI | Repository hygiene gate: committed credentials, personal absolute paths, tracked-but-ignored files, oversized files, unpushed release commits | None (read-only) |
| `sync-node-pty-prebuilds.cjs` | automatic | Runs on `postinstall`. Repairs `node-pty` native binaries when an install leaves wrong-arch `pty.node` / non-executable `spawn-helper`. | Rewrites files under `node_modules/node-pty/build/Release` |
| `mock-cli/claude-mock.cjs` | manual | Generates Claude-Code-shaped terminal output (fps, history size, full-clear cadence) for the terminal tests | None |
| `mock-cli/loop-mock.cjs` | manual | Emits burst/silence iterations so the Loop Dashboard counter can be exercised | None |
| `mock-cli/record-claude.cjs` | manual | Drives a **real** CLI through a pty and records the byte stream to JSONL | Spends real API tokens; writes to `mock-cli/recordings/` |
| `mock-cli/replay.cjs` | manual | Replays a recording with original timing — the token-free way to reproduce a real session | None |
| `mock-cli/analyze-recording.cjs` | manual | Reports ANSI sequence statistics for a recording | None |

`record-claude.cjs` is the only script here that costs money and the only one that needs an
authenticated CLI. Prefer `replay.cjs` against an existing recording; record again only when you
need a pattern the existing recordings do not contain.

It runs under Electron-as-Node because it needs the repo's `node-pty`:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/mock-cli/record-claude.cjs
```

## Pre-publish gate

`prepublish-check.cjs` runs in CI on every push and can be run by hand:

```bash
pnpm check:publish                       # every check
node scripts/prepublish-check.cjs --list # check names
node scripts/prepublish-check.cjs --only=secrets
```

It scans **tracked content only** — local scratch files are not the repository's
problem, and scanning them produces noise that trains people to skip the gate.
Failures block; warnings do not. Its own checks are pinned by
`tests/terminal/t10-prepublish-check.spec.ts`, which plants each problem in a
throwaway repository and asserts the gate fails — a gate nobody verified is
worse than no gate.

## Recordings

`mock-cli/recordings/` holds captured byte streams used as test fixtures. The directory is
**gitignored** (`.gitignore:13`), so a fresh clone has none.

Two terminal tests replay `recordings/claude.jsonl` and fail with a 96-second timeout when it is
absent — see [`docs/found-defects.md`](../docs/found-defects.md). Until that is decided, record
one locally before running the full suite on a new machine:

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/mock-cli/record-claude.cjs
```

## Adding a script

1. Decide it belongs here — dev/test only, no outward effect.
2. Add a row to the table above in the same change. An undocumented script is reported by the
   structural audit and, more importantly, gets rediscovered by the next person from scratch.
3. If it is invoked from `package.json`, say which command runs it.
4. If it spends money, makes network calls, or writes outside `node_modules/` and `scripts/`, say
   so in the side-effects column explicitly.

## Update triggers

Update when a script is added, removed, or gains a side effect, and when a `package.json` hook
starts or stops calling one.
