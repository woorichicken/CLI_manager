---
description: Before building, publishing, or distributing a release — anything with an effect outside this machine
authority: Release and distribution procedures, including their side effects and prerequisites
status: active
owner: maintainer
last-reviewed: 2026-08-18
---

# Operations

Commands here reach outside the working copy: they sign binaries, create public GitHub releases,
and overwrite objects users download. Day-to-day development commands live in the root
[`CLAUDE.md`](../../CLAUDE.md); this file covers only the ones with consequences.

## Command map

| Command | Effect | Prerequisites | Safe to re-run |
|---|---|---|---|
| `pnpm build:mac` / `build:win` / `build:linux` | Builds an installer into `release/`. Local only. | — | Yes |
| `pnpm publish:mac` | Builds **and creates/updates a public GitHub Release** for macOS | `GH_TOKEN`, signing identity | No — see below |
| `pnpm publish:win` | Same, Windows target | `GH_TOKEN` | No |
| `pnpm publish:all` | Same, all three targets in one run | `GH_TOKEN`, signing identity | No |

`--publish always` uploads on every invocation. Re-running against an unchanged version replaces
the assets of an existing release rather than failing, so a mistaken run is visible to users
immediately. Bump the version first; do not re-publish to "fix" an upload.

There is no dry-run flag. To rehearse, use the matching `build:*` command and inspect `release/`.

## Release sequence

Two scripts cover the whole flow; do not perform these steps by hand.

```bash
node scripts/release.cjs --version X.Y.Z --build      # ~10 min, run detached
node scripts/release.cjs --version X.Y.Z --publish --notes notes.md
DATABASE_URL=... node scripts/post-release.cjs --version X.Y.Z --notes changelog.json
```

Procedure and rationale live in
[`.claude/rules/deploy-workflow.md`](../../.claude/rules/deploy-workflow.md); the scripts themselves
are documented in [`scripts/CLAUDE.md`](../../scripts/CLAUDE.md). Deployment only runs when the user
explicitly asks for it — never inferred from a commit request.

Before any publish:

1. Working tree clean and the release commit **pushed**. An unpushed release is unreproducible.
2. `pnpm typecheck` and `pnpm build` pass.
3. `pnpm test:term` green — the terminal pipeline has no runtime guard, so a regression here ships.

## Release hazards (measured 2026-09-23, v1.9.0)

Three things cost two build slots and nearly shipped an unsigned app. All three are now gated or
disabled; this section exists so the next release does not rediscover them.

### The DMG step runs Python, and a broken one lies about itself

`electron-builder` builds the DMG window layout with a vendored Python script. It tries `python3`
from `PATH` and falls back to `python`, which macOS no longer ships — so a broken `python3` surfaces
as `Command failed: which python`, and the retry loop then reports `unable to execute hdiutil`
against a temp directory it has already cleaned up. **The visible error names the wrong tool.**

Measured: Homebrew python 3.14.7 cannot `import plistlib` — its `pyexpat` links
`_XML_SetAllocTrackerActivationThreshold`, which the system libexpat does not export. Apple's
`/usr/bin/python3` works.

`release.cjs` now proves a python by importing `plistlib` before the build and pins it through
`PYTHON_PATH`. If preflight says "no python can build the DMG layout", fix the interpreter — do not
start a ten-minute build.

### Pushing the tag wakes a workflow that can overwrite the notarized release

`.github/workflows/release.yml` ("Build and Release") triggers on `v*`, and this repository has **no
signing secrets**, so it would build unsigned artifacts and upload them under the same filenames —
including `latest-mac.yml`, the auto-update feed. Earlier releases survived by accident (the run
always died at dependency install).

It is **disabled manually** (`gh workflow disable 215359425 -R woorichicken/CLI_manager`) since
v1.9.0. Leave it that way unless the owner decides otherwise — see [`../backlog.md`](../backlog.md).
A tag push is therefore safe, but check `gh run list --workflow "Build and Release"` if that changes.

### Verify the distribution from outside, not from the script's own report

`post-release.cjs` checks its own steps; these are the user-facing facts:

```bash
curl -sI "https://pub-dc249db286af4c1991fedf690157891d.r2.dev/cli-manager-<version>-arm64.dmg" | head -1
curl -sL https://www.solhun.com | grep -o "cli-manager-[0-9.]*-arm64.dmg" | head -1
curl -sL https://github.com/woorichicken/CLI_manager/releases/latest/download/latest-mac.yml | head -1
```

Use **`www.solhun.com`**: the apex redirects (307) and returns a 15-byte body, so grepping it finds
no version and reads like a failed deploy.

Test failures inside the gate now leave their full output at `/tmp/release-tests-<ts>.log`, named in
the failure message.

## Cloudflare R2

DMG distribution runs inside `post-release.cjs`, which wraps the
[`upload-to-r2`](../../.claude/skills/upload-to-r2/SKILL.md) skill and then verifies the public URL
before the website is repointed at it.

Credentials come from the environment, loaded from `.env.release` at the repository root — a
gitignored file. **Never commit R2 keys**, and never paste them into a document under `docs/`:
this directory is public in the published repository.

## Codex prompt setup

[`codex-prompts.md`](codex-prompts.md) maps this repository's `.claude/commands` onto
`~/.codex/prompts` for contributors driving the repo with Codex. It is contributor setup, not a
release step.

## Dependency security

This is a public repository shipping a signed desktop app, so the question that matters is what
reaches users — not what is installed on a developer's machine.

- CI runs `pnpm audit --prod --audit-level critical` on every push.
- Dependabot (`.github/dependabot.yml`) opens weekly PRs and separate, immediate ones for
  security fixes.

**Why the gate sits at `critical` rather than `high`:** Electron publishes high-severity advisories
continuously and their fixes usually land in a later major. A `high` gate would be red permanently,
and a permanently red gate gets switched off — which is the state that lets a real finding through.
The high/moderate stream is handled as reviewable Dependabot PRs instead.

Check the shipped surface directly when in doubt:

```bash
pnpm audit --prod          # what users get
pnpm audit                 # includes the dev tree
```

Keep `@types/*` in `devDependencies`. In `dependencies` they inflate both the shipped tree and this
report — `@types/uuid` was pulling a second `uuid` into the production audit until 2026-08-18.

## Update triggers

Update when a `package.json` script gains or loses a side effect, when a distribution target
changes, or when credentials move. A new operational command is not done until it has a row in the
table above.
