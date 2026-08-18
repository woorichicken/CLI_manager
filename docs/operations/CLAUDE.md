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
