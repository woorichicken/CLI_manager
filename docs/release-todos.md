---
description: When a merged change needs work outside this repository that must wait for the release (a skill, a script, another tool), or when finishing a release
authority: The list of work that waits for an app release, and what to do once it ships
status: active
owner: maintainer
last-reviewed: 2026-11-25
---

# Release todos — work that waits for the release

A change merged into `main` is not on anyone's machine until it is released. Tools outside this repository
— the `climanager-session` skill (`clim`, `watch-sessions.sh`), the HQ role files, other people's
scripts — talk to the **installed** app. Teach them a feature before it ships and they call an API the
running app does not have; worse, an older app **ignores** fields and query parameters it does not know,
so the call "works" and does the wrong thing (`GET /v1/sessions?role=work` on an old app returns every
session).

So: the change that needs such work adds a row here **in the same PR**. The release reads this file
(`.claude/commands/release.md` 「릴리즈 뒤 할 일」) and, once the new version is installed, does the rows
whose version has shipped, then deletes them in a commit that says what was done.

## How to write a row

- **Waits for**: the commit or PR, and how to tell the installed app has it (a field in an API answer,
  `GET /v1/health` version). A check, not a guess.
- **Do**: the concrete edits, with paths. Mark the app version they need (`앱 1.38+`) in the tool's own
  help, as `clim` already does.
- **Not before**: what breaks if it is done early.

## Open

| Waits for | Do | Not before |
| --- | --- | --- |
| This PR (Getting started 4th step «Connect an AI agent», onboarding-1127) merged **and released**; the installed app shows the step: `gettingStarted` in `config.json` has `withAiStep` after «Show Again», or the card shows 0/4 | **Skill (original)**: push this batch's local `climanager-session` commits (list: `~/Downloads/_batches/onboarding-1127/reports/multi-skill.md` «같이 고친 문서») — other sessions' unpushed commits sit on the same local `main`, so stop and report if `git log --oneline origin/main..HEAD` holds more than yours. **Public edition**: in a clone of `woorichicken/climanager-session`, `git am ~/Downloads/_batches/onboarding-1127/public-multi-skill.patch` (two commits: onboarding, then the move to `skills/<name>/` plus the new `climanager-team` skill — it replaces the older `public-onboarding.patch`), replace «next release» in the feature map with the shipped version, run `verify-release.mjs` once per skill (`--skill climanager-session`, `--skill climanager-team`), and check on a temporary public branch — before `main` — that an old install picks up the new layout with `npx skills update -g` (order in the skill's `references/release.md`), then merge to public `main` (procedure: skill `references/release.md`; never `sync-release`) | The skill's onboarding tells people to press the card's **Turn on AI Control API** button; an app without the card has only Settings › Agents. The public repo must not describe a card its users cannot find |

