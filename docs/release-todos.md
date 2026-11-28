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

- **The sidebar has no "Disconnect AI" item any more** (fb-1128 2ea599ad, branch `fix/fb-1128-sidebar`).
  - **Waits for**: the release that carries it — the installed app's session right-click menu has no
    "Disconnect AI" (Control API answers do not change: `409 disconnected` still comes from `release`).
  - **Do**: `climanager-session` — `SKILL.md` (exit code 4 row and safety rule 4) and `scripts/clim.mjs`
    (the `disconnected` comment) say the user clicked Disconnect AI; say instead that the session was
    released (`POST /v1/sessions/:id/release`) during the wait, and keep "stop using that session".
  - **Not before**: on an older app the menu item still exists and the current wording is still right.
- **Thread names end in « · thread»** (fb-1128 8d1fe130, branch `fix/fb-1128-chat`)
  - **Waits for**: the release with that commit — check: `clim fork` on a test session, the new session's name ends
    in ` · thread` (`GET /v1/sessions/:id` → `name`).
  - **Do**: `~/skills/macbook-cc/climanager-session/references/app.md` 「fork」 line — `<이름> · fork` → `<이름> · thread`
    (the release after 1.38.0; older apps still name it ` · fork`). Nothing in `clim.mjs` reads the tail.
  - **Not before**: the installed app still writes ` · fork`, and the skill would describe a name the person does not see.
