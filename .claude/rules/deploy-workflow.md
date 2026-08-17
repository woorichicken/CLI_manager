# Deploy Workflow

Deployment runs only when the user explicitly asks for it — "배포", "deploy", "release too",
"publish". A commit request alone never triggers it.

Everything below is scripted. Do not perform these steps by hand: the scripts carry preconditions
and verifications that are easy to skip and expensive to miss.

## The two commands

```bash
# 1. Build and publish the GitHub release
node scripts/release.cjs --check                                  # preflight only, changes nothing
node scripts/release.cjs --version X.Y.Z --build                  # ~10 min
node scripts/release.cjs --version X.Y.Z --publish --notes notes.md

# 2. Distribute: R2, website links, changelog
node scripts/post-release.cjs --version X.Y.Z --check
DATABASE_URL=... node scripts/post-release.cjs --version X.Y.Z --notes changelog.json
```

Version bump policy: patch by default. Use minor when the release adds user-facing features.

## Why build and publish are separate

The build takes about ten minutes; publishing takes seconds. When they shared one process, an
interruption threw away completed notarization. Two releases were lost that way. Run `--build`
detached (`nohup … &` then `disown`) so a session timeout cannot kill it, and confirm it finished by
reading the exit line rather than a wrapper's status — a background wrapper reports its own exit
code, not the build's.

If the build fails, `release/` is moved to `release-failed-<timestamp>/`, the version bump is
reverted, and nothing is published. Inspect it, then delete it.

## Order is a safety property

`post-release.cjs` verifies the **public** R2 URL — status 200 and a content length matching the
local file — before rewriting the website. An upload API call returning success is not the same
fact as a working download, and the website is what users click. If R2 verification fails the site
is left pointing at the previous release, which is the safe state.

## Credentials

| Secret | Where it lives |
|---|---|
| Signing / notarization (`CSC_*`, `APPLE_*`) | Shell environment |
| R2 (`R2_*`) | `.env.release` in the repo root — **gitignored**, loaded automatically |
| `DATABASE_URL` (changelog) | Passed on the command line, never stored in the repo |

Nothing here belongs in a tracked file. `pnpm check:publish` fails the run if a credential-shaped
string is ever committed.

## Release notes

Two separate artifacts, both written by hand:

- **GitHub release notes** — Markdown, passed to `release.cjs --notes`.
- **Changelog row** — JSON `{ title, description, improvements[], fixes[] }`, passed to
  `post-release.cjs --notes`. Lands in the `changelogs` table that solhun.com reads.

## What the scripts do not do

Nothing after the changelog. There is no Slack or social announcement step; if one is wanted, it is
manual and happens after `post-release.cjs` reports DONE.
