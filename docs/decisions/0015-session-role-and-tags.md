---
description: When adding a session field that classifies sessions, when an agent tells sessions apart by their name, or when changing how a session's role or tags are set, shown or filtered
authority: Rationale and plan for a session's role and tags living beside its name, not in it
status: active
owner: maintainer
last-reviewed: 2026-11-25
---

# 0015. A session's role and tags live beside its name, not in it

> Decided 2026-11-25 with the author (role: fixed list · batch: tags · set inside the app too). The
> screens went through two rounds of before/after review; round 2 replaced text pills and a filter row
> with icons after 「아이콘으로 하는게, 좋아보임, 화면이 좁은데 더 좁아보여」.

## Context

Agents that drive the app through the Control API tell sessions apart by a **name prefix**: `AI: <batch>`
(worker — a batch watcher selects by prefix), `대화: <topic>` (a person talks there — cleanup must not close
it), `팀장: …`, `Q `, `SU `. A count of 57 real sessions on 2026-11-25: no prefix 19 · `AI` 13 · `대화` 12 ·
`작업` 5 · `이벤트` 4 · `팀장` 2 · other 2 — two of those prefixes were in no rule at all.

The prefix does two jobs badly. It eats the start of the name, so the sidebar cuts off the part that says
what the session does. And it is a convention, not data: a typo or a new word silently drops a session out
of a watcher or into a cleanup. The author: 「세션 이름 자체는 작업 요약으로 하고 그리고 태그 등으로 해야 보기가
편할거라고 생각함」, and the role should be settable inside the app too.

The app already has words near this: `data-session-role` (master · ai · user — who drives it, derived, not
stored), session folders (one per session), and the AI mark. None says what a session is *for*.

## Decision

- **Two stored fields on `TerminalSession`.** `role?: 'lead' | 'work' | 'talk' | 'watch'` — one value from a
  fixed list, unset = none. `tags?: string[]` — free words. The name stays the work summary.
  - Fixed list, because a role drives behaviour (colour, filter, a watcher's selection, cleanup's
    exemption); free text would bring back the typo problem. Labels are English (Lead · Work · Talk · Watch);
    a person's own words for them belong to their tools, not the app.
  - Tags are normalized on every write path: trimmed, one line, `#` dropped, at most 32 characters each,
    at most 8 per session, duplicates removed ignoring case (the first spelling wins), empty dropped.
  - Not the existing `data-session-role`: that one is derived from who drives the session. The new one is
    `data-work-role` in the DOM to keep the two apart.
- **Shown in the sidebar row — no added width.** The role is an icon (Lead flag · Work hammer · Talk
  speech bubble · Watch eye) **in the row's icon slot**: after the master crown, before the template logo and
  the AI robot (the row's colour still says AI). The first tag (`· #night-1125 +1`) rides inside the dim
  workspace label of the flat lists, which already gives way before the name; Tree and the folder view show
  tags in the icon's tooltip only. A session with neither looks exactly as before.
- **Filter**: one icon button in the All sessions toolbar (after Threads) opens Role and Tag lists; picking
  both shows sessions with both, a dot says a filter is on. The button appears only once some session has a
  role or a tag — until then it would only squeeze "New session". Kept in localStorage like the layout.
- **Set in the app**: the sidebar row's menu gains `Role ▸` (Lead · Work · Talk · Watch · None, saved on
  click) and `Edit Tags…`; the tab's menu gains `Role & Tags…`. Both open one editor (role buttons, tag chips,
  suggestions from tags other sessions use, Save/Cancel), mounted in `App` so a tab can open it with the
  sidebar closed. Setting either is a label change: no AI mark, no relation.
- **Control API / MCP** ([`control-api.md`](../architecture/control-api.md)):
  - `POST /v1/sessions` takes `role` and `tags`.
  - `POST /v1/sessions/:id/labels` `{ role?: string | null, tags?: string[] }` — omitted keys stay, `null`
    clears the role, `tags` replaces the list. MCP `set_session_labels`.
  - `GET /v1/sessions?role=&tag=` filters (with `scope` as today); every session object carries `role`
    (or `null`) and `tags` (`[]`).
  - An unknown role is `400 bad_role` — silently storing nothing would hide a typo the fixed list exists
    to catch. A bad tag is normalized, not refused; one that normalizes to nothing is dropped.
  - Changes are announced with the existing `updated` event, so the sidebar follows without a reload.
- **No prefix migration in the app.** Reading `대화:` or `AI:` out of names is one person's convention; the
  app ships to people who never used it. The migration is a one-time script on the tools' side (`clim`),
  which sets roles through the API and leaves the names alone. Its consumers (`watch-sessions.sh`'s
  `SESSION_PREFIX`, `clim sessions`, the cleanup exemption for `대화:`) switch to role/tag queries after the
  app release and keep the prefix as a fallback for one release.

## Consequences

- Every code path that writes `workspaces` must keep the two fields. Most mutate the stored session in place;
  any that rebuilds a session object (restart, move, fork) is checked during implementation — `memoPages`
  was lost that way once (T56).
- The role takes the icon slot, so a template logo or the AI robot is hidden on a row with a role. The
  row's colour still marks AI; the tooltip names the driver.
- Phone list, Related dialog and tab bar do not show role or tags in the first round (tracked below).

## Plan

| Step | Where |
|---|---|
| Types + normalization (pure, shared) | `src/shared/types.ts`, `src/shared/sessionLabels.ts` |
| Store write + IPC `set-session-labels` | `src/main/index.ts`, `src/preload/index.ts` |
| Control API + MCP | `ControlApiService.ts`, `ControlApiServer.ts`, `controlApiMcp.ts`, `docs/architecture/control-api.md` |
| Row icon + tag, filter button | `Sidebar/SessionItem.tsx`, `SessionRoleIcon.tsx`, `SessionLabelFilter.tsx`, `AllSessionsToolbar.tsx`, `Sidebar/index.tsx` |
| Menu items + editor dialog | `Sidebar/SessionLabelMenuItems.tsx`, `ContextMenus.tsx`, `SessionTabs/SessionTabMenu.tsx`, `SessionLabelsDialog.tsx` (host in `App.tsx`) |

Tests: T176 (unit — role parsing, tag normalization, apply/clear, filter, tooltip) and T177 (app — the
seeded labels are read, menu → config.json → row icon, editor Esc/Save/suggestions, tab menu, filter
role/tag/empty/clear, the button only once labels exist; REST set/keep/clear/400/404, `GET ?role=&tag=`,
open with labels, a bad role opens nothing, no AI mark, the sidebar follows without reload; MCP
`set_session_labels` and `list_sessions role`).

Later, not in the first round: phone list pill · Related and tab bar · the `clim` migration script and its
consumers (another repository, after the release).

## What would reverse it

If roles turn out to need words the fixed list cannot hold for most users — people keep tagging
`role:<x>` because the list has no fit — make the list user-editable in Settings rather than free text.
