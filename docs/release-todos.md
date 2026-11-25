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

### Session role and tags — teach the skill (decision 0015)

- **Waits for**: PR of `feat/session-role-tags-1125`. Shipped when `GET /v1/sessions/<id>` answers with a
  `role` field (null or a value).
- **Do** (skill repository `~/skills/macbook-cc/climanager-session`, `no-auto-push` 「스킬 개선」):
  - `scripts/clim.mjs` — `open --role <lead|work|talk|watch> --tag <t>` (repeatable), `sessions --role --tag`,
    a `label <session> [--role r|none] [--tag t …]` command; help says `앱 1.38+` (or the shipped version).
  - `scripts/watch-sessions.sh` — select by `SESSION_ROLE` / `SESSION_TAG` (through `GET /v1/sessions?role=&tag=`),
    keep `SESSION_PREFIX` as a fallback for one release.
  - `SKILL.md` (naming rule near the `AI: <배치>` line) and `references/conducting.md` (the 「대화:」 rules,
    cleanup exemption, folder rule) — name = the work summary; role and batch go in `--role` / `--tag`;
    cleanup skips `role=talk` instead of the `대화:` prefix.
  - HQ `roles/team-lead.md` (the two prefix rules) — same change.
  - A one-time script: read every session's name, set `role` from the prefix (`AI:`·`작업:` → work, `대화:` →
    talk, `팀장:` → lead, `Q ` → watch) and the batch as a tag. Whether it also strips the prefix from the name
    is the person's call (asked 2026-11-25, not decided) — default leave names alone.
- **Not before**: an old app ignores `role` on open and `?role=` on list — a watcher would watch every session
  and cleanup would no longer recognise talk sessions.
