---
description: When calling, extending, or debugging the AI Control API (REST under /v1, MCP at /mcp) that lets an AI open and drive sessions
authority: Endpoint, tool, and state contract of the AI Control API
status: active
owner: maintainer
last-reviewed: 2026-10-24
---

# AI Control API

Lets an AI open sessions in CLI Manager, type into them, wait for them, and read the screen — in
terminals the user watches. Why it is shaped this way:
[`../decisions/0005-ai-control-api-local-http.md`](../decisions/0005-ai-control-api-local-http.md).

Code: `src/main/ControlApiServer.ts` (HTTP, auth, routes) · `ControlApiService.ts` (behaviour) ·
`controlApiMcp.ts` (MCP tools) · `TerminalMirror.ts` (screen) · tests `tests/terminal/t15-control-api.spec.ts`
(sessions) and `t21-control-api-workspaces.spec.ts` (workspace registration).

## Turning it on

Settings > Agents > **AI Control API**. Default port 47821. The panel shows the verified state
(listening, or why not), the token, and a copy-ready command:

```bash
claude mcp add --scope user --transport http cli-manager http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

Scripts can read `~/.climanager/control-api.json` (`url`, `mcpUrl`, `token`, `pid`; mode 600;
deleted on quit). `CLIMANAGER_HOME` moves it — tests always set it, and the server refuses to start
in test mode without it.

## Access rule

While the API is switched on it reaches **every session in the app**, including the ones the user
opened. Rationale: [`../decisions/0006-control-api-reaches-every-session.md`](../decisions/0006-control-api-reaches-every-session.md).

| Can | Cannot |
|---|---|
| List workspaces, templates and sessions | Anything while the API is switched off |
| Open sessions (and register a new folder as a workspace) | Type text while the screen shows a question (unless `force: true`) |
| Read, type into, wait on, focus, release and close any session | Keep waiting after the user clicks **Disconnect AI** (`409 disconnected`) |
| Unregister a workspace **it registered**, once it has no sessions | Unregister, move or re-flag a workspace the user added (`403 not_ai_registered`) |

`aiControl: { client, since }` in the store is a **mark, not a permission**. It is set when the API
opens a session and the first time it reads, types into, waits on or focuses one; looking a session
up does not set it. The mark persists across restarts and machine sleep; the sidebar draws marked
sessions in green with a bot icon, and the header shows "AI connected". `release` and
**Disconnect AI** clear it — the next call from the API sets it again.

Every terminal is mirrored from the moment its pty starts — whether or not the API is on, since the
mirror is also the terminal's history ([0008](../decisions/0008-terminal-history-lives-in-main.md)) —
so reconnecting to a session returns its real screen. After an app restart the mirror starts with
the history saved before the restart, followed by a "Restored from previous session" line.
`screenPartial` stays in the response for compatibility and is false in practice.

## Master sessions (orchestrators)

An agent that runs **inside** a CLI Manager terminal and opens other sessions through the API is
an orchestrator. The sidebar draws it in rose with a crown icon (tooltip: how many sessions it
opened), above the green AI mark: **master > ai > user**.

| Piece | Contract |
|---|---|
| `CLIMANAGER_SESSION_ID` | Every pty is started with its own session id in this variable (same id when the terminal is recreated). |
| `X-Caller-Session` | Optional request header, REST and MCP alike. The caller copies its `CLIMANAGER_SESSION_ID` into it. Must match `^[A-Za-z0-9_-]{1,64}$`; anything else, or an id that names no session, is **ignored, not rejected**. |
| Becoming master | Only when a request carrying the header **opens a session** successfully. Reads and inputs do not. |
| Related sessions | Opening a session with the header relates the two (`opened`). The **first** read, input, wait or focus of another session with the header relates them too (`connected`). See below. |
| `lastSeen` | Updated on every later request carrying the header. |
| Ending | The master's shell exits, the session is closed/removed, **30 minutes** without a request carrying its id (`ORCHESTRATOR_IDLE_MS`), or the API is switched off. |
| Persistence | **Memory only.** An app restart clears every master mark and `openedBy` — the agents that made the calls are gone, and a red row restored from disk would point at nothing. |

**The header is self-reported, so it is a display hint, never a permission.** Anyone with the token
can claim any session id. Being master grants nothing, and not being one takes nothing away — access
is still decided only by the API being on ([decision 0006](../decisions/0006-control-api-reaches-every-session.md)).
The master session itself is not given the green AI mark.

API fields: `orchestrator: { since, lastSeen, client, openedCount } | null` (ISO times;
`openedCount` counts opened sessions still open) and `openedBy: <master session id> | null`, on every
session object — `GET /v1/sessions`, `GET /v1/sessions/:id`, MCP `list_sessions`, open results.

### Session folders

`:folder` (and `folder`/`sessionFolder` in bodies) is an id first, then a name (case-insensitive); a name two
folders share is `409 ambiguous_folder` — the window lets the user make such a pair. `POST /v1/sessions`
takes `sessionFolder` (id or name; a name no folder has creates it). Folder changes made here are announced
to the windows on the `session-folders` channel (the new list) and, for membership, as a normal session
`updated` event, so the sidebar follows without a reload. Window-made changes are not echoed. Expanded/
collapsed is view state and is not in the API. Access follows [Access rule](#access-rule): every folder and session.

### Related sessions

The session header's **Related** dialog lists the sessions that belong with a session. The API fills
it from the same header: `opened` when the caller opens a session, `connected` the first time the
caller reads, types into, waits on or focuses a session it did not open. One record per pair of
sessions; a later call never changes it. The user can add pairs by hand and remove any of them — a
removed pair stays marked so the agent's next call does not put it back.

Unlike the master mark, **relations are persisted** (`sessionRelations` in electron-store). The mark
says an agent is directing others *now*, which a restart ends; a relation says two sessions belong
together, which the sessions themselves outlive. Either session closing — through the API or the
sidebar — deletes the record. `openedBy` in API responses stays memory-only as before.

For MCP, set the header in the client config, e.g. Claude Code `.mcp.json`:
`"headers": { "X-Caller-Session": "${CLIMANAGER_SESSION_ID}" }`. With curl:
`-H "X-Caller-Session: $CLIMANAGER_SESSION_ID"`.

## Inbox

A session that needs the user's hands — sign in somewhere (often a browser login an agent cannot do),
look at a result, answer a question — sends a request. The app keeps it in an inbox, unread, until the user
checks it off. Code: `src/main/InboxStore.ts` (store, checks) · `ControlApiService.notifyInbox`
· renderer `hooks/useInbox.ts`, `components/Inbox/`. Tests: `t52-inbox.spec.ts`, `t53-inbox-unit.spec.ts`.

| Piece | Contract |
|---|---|
| Kind | `login` (key, orange) · `review` (eye, blue) · `question` (speech bubble, purple) · `other` (bell, gray). Omitted → `other`; anything else → `400` |
| Text | Required. Whitespace and newlines fold into single spaces; cut (not refused) at **200** characters |
| Link (`url`) | Optional. Must be an absolute URL, ≤ **2000** characters, and not `javascript:` `data:` `vbscript:` `blob:` `about:` → else `400`. Whether a click may open it is decided **when clicked**, by the same rule as a terminal link (`utils/terminalLinks.ts`: http/https/file/editor schemes + Settings > Terminal app schemes). A disallowed link is shown greyed, with how to allow it |
| Which session | `sessionId` in the body, else `X-Caller-Session`. Neither → `400 session_required`; an id that names no open session → `404 not_found`. A request without a session has nowhere to lead |
| AI mark | Sending does **not** set `aiControl` — the sender is the session itself |
| Repeats | The same session + kind + text while still unread is not added again: it moves to the top with the new time (and the new link, if one was sent). `created: false` says so |
| Read | (1) The user checks the request off (✓ on its row). (2) **Mark all read**. (3) `POST /v1/inbox/:id/read` — the sender solved it itself. Showing the session, clicking the request (it shows the session) or its link does **not** read it — since 1.22.0 (report b165acc4: reading on sight hid what was still to do) |
| Kept | electron-store `inbox`, owned by main (survives restarts; every window sees the same list). At most **200** — the oldest read ones go first. Read ones older than **7 days** are dropped at startup. A session closed (API or sidebar) takes its requests with it |
| Shown | Bell at the front of the sidebar header with the unread count in red; the main header carries the same bell while the sidebar is closed. Orange dot on the session's row (tree, All sessions, search). macOS Dock badge = unread count |

No OS notification or sound in this version: twenty sessions asking at once would be noise. With the API
switched off nothing can be sent (the inbox still shows what is kept).

## Checklists

Titled lists with a deadline, usually for one project, shown in the main header — the plan a lead
(or the user) keeps where both see it instead of in a reply that scrolls away (standup note 「기획 - 리스트」,
2026-10-31 2nd plan: "세션에 붙는게 아니라, 전체에 체크리스트 … 총괄 혹은 팀장이 만들고 특정 세션에 직접 오더").
A checklist belongs to **no session**: the lead hands the work out with `send_input` as before, and whoever
finishes an item checks it. Code: `src/main/ChecklistStore.ts` (store, checks, order) ·
`ControlApiService.listChecklists/createChecklist/…` · renderer `hooks/useChecklists.ts`,
`components/Checklists/`, `utils/dueDate.ts`. Tests: `t70-checklists-unit.spec.ts`, `t71-checklists.spec.ts`.

| Piece | Contract |
|---|---|
| Reference | A checklist by `id` or by its title (case and spacing ignored); two checklists with that title → `409 ambiguous_checklist`. An item by its number from 1 (`n` in results) or its `id` |
| Title, items | One line each: whitespace folds to single spaces, cut (not refused) at **200** characters. Items keep the order they were added; checking one does not move it |
| Deadline (`due`) | One per checklist, optional local date `YYYY-MM-DD` (a real date — `2026-02-30` → `400`). `null` or `""` clears it. `overdue` compares with this Mac's local date and is false once every item is checked |
| Project | Optional workspace, given as id, name (case ignored) or absolute path. Unknown → `404 workspace_not_found`, two of that name → `409 ambiguous_project`. Removing the workspace keeps the checklist and drops only the link. A checklist made in the panel starts with the project of the session in view |
| Repeats | Creating with the title of an open checklist reuses it (`200`, `created: false`): items it lacks are added, a `due` or `project` sent with the repeat replaces the old one. Adding an item text the checklist already has (checked or not) is skipped |
| Done | A checklist is finished when every item is checked (an empty one is open). Finished ones go to the end of the header order and stay until removed by hand — nothing is deleted on its own |
| Order | Open first, nearest deadline on top, undated ones after in the order made; then finished ones, the most recently finished first. This is the order ‹ › pages through |
| Sessions | Closing or deleting a session does not touch checklists. `createdBy` keeps the maker's id (`X-Caller-Session`); `createdByName` is `null` once that session is gone |
| AI mark | Reading or editing checklists does **not** set `aiControl` — a checklist is not a terminal |
| Kept | electron-store `checklists`, owned by main (survives restarts; every window sees the same). At most **100** checklists and **100** items each — more is refused (`409 too_many`), never trimmed |
| Shown | A chip at the left end of the main header's right-hand buttons — the checklist looked at last (switching sessions does not change it), its done/total and deadline; it stays in split view. Its panel: ‹ › (and ← → when no field has focus) through checklists, double-click the title to rename, project select, deadline (a picked date saves after 0.6 s), a progress bar, the items (check, double-click to rename, × to delete), "Add an item…", "+ New checklist", Delete (two clicks). Shortcut **⌘⇧J** (`toggleChecklists`). Below 640 px the chip shows only the icon and done/total |

Not in this version (backlog): assigning an item to a session.

## Session state

| `state` | Meaning |
|---|---|
| `starting` | Session exists, the renderer has not spawned its pty yet |
| `busy` | Output within the last 1.5s, **or** "esc to interrupt" on screen, **or** a hook reports a running turn |
| `idle` | None of the above |
| `exited` | The pty is gone |

`awaitingInput: true` — the bottom 15 lines of the screen show a question (permission prompt,
folder-trust dialog, "Enter to confirm · Esc to cancel"), or a hook reported one. Answer with keys.

`suggestion` (on output and wait results) — text shown **dim** in an otherwise empty input box: Claude
Code's next-prompt suggestion or placeholder. It also appears in `lines`, but nobody typed it; don't
read it as the user's instruction. `null` when there is none. MCP `read_output` prints it as a footer.

`memo` — the text of the session's memo pad (Cmd+J), `''` when empty. Read-only: the API has no way to
write it. `memoPages` — every page, first page first, always at least one: `memoPages[0] === memo`. The
store keeps pages 2..n in `memoPages`; the API field counts from page 1 (like the renderer's `memoPages`
helper), so the two are not the same array.

`sessionFolder` — `{ id, name }` of the All-sessions folder the session sits in, or `null`.

## Workspace registration

Opening a session in a folder that is not a workspace yet registers it. Without care those pile up
— 11 worktree and `/tmp` registrations were deleted by hand on 2026-10-01. Rationale:
[`../decisions/0007-api-cleans-up-only-its-own-registrations.md`](../decisions/0007-api-cleans-up-only-its-own-registrations.md).

| Field (store) | Set when | Effect |
|---|---|---|
| `Workspace.aiRegistration: { client, since, ephemeral? }` | The API registered the folder | `registeredBy: "ai"`; `DELETE /v1/workspaces/:id` allowed. **Missing = the user's** — every workspace stored before this field existed counts as the user's |
| `Workspace.folderId` | On registration only | The sidebar folder (group) it is filed under |
| `aiRegistration.ephemeral` | `open` with `ephemeral: true` | The workspace is unregistered when its last session closes — whether the API closed it or the user did. A startup sweep removes one left without sessions |

`folder` on open: an existing folder's **id**, or a **name** (case-insensitive) — a name that does not
exist creates that folder. `""` puts it at the top level. Omitted → Settings > Agents > AI Control
API > **Sidebar folder for AI workspaces** (default `AI Work`; empty = top level). `folder` and
`ephemeral` apply **only when the call registers the folder**; on an existing workspace they are
ignored and `note` says so — the API never moves what the user arranged.

Unregistering removes the sidebar entry only. Files on disk are never touched. Refused while the
workspace has sessions (`409 has_sessions`) or worktree workspaces under it (`409 has_worktrees`).
The sidebar folder is kept even when it becomes empty — it is shared by later registrations.

Changing the folder setting does not restart the server (waits in flight would be cut); only
`enabled` and `port` do.

## REST

All requests: `Authorization: Bearer <token>`. Optional `X-Client-Name` labels the session owner
(default `api`; MCP calls default to `mcp`). Errors: `{ "error": { "code", "message" } }`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/v1/health` | | `{ ok, app, version }` |
| GET | `/v1/workspaces` | `?query=` substring | workspaces with `kind`, session counts, `folder` (`{ id, name }` or `null`), `registeredBy` (`ai`\|`user`), `registeredByClient`, `ephemeral` |
| DELETE | `/v1/workspaces/:id` | | unregisters a workspace the API registered (files untouched). `403 not_ai_registered`, `409 has_sessions`, `409 has_worktrees`, `404 workspace_not_found` |
| GET | `/v1/templates` | | `{ id, name, command, description }[]` |
| GET | `/v1/sessions` | `?scope=ai\|all` (default `ai`), `?query=` substring of session, workspace or folder | sessions marked as AI-driven, or all of them |
| POST | `/v1/sessions` | `path` or `workspaceId`; `template` or `command`; `name`, `prompt`, `focus`; `folder`, `ephemeral` (new registrations only) | `{ session, workspace, createdWorkspace, createdFolder, terminalStarted, promptSent, note? }` |
| GET | `/v1/sessions/:id` | | session |
| GET | `/v1/sessions/:id/output` | `?mode=screen\|tail&lines=` | `{ session, mode, cols, rows, lines[] }` |
| POST | `/v1/sessions/:id/input` | `text`, `submit` (default true), `keys[]`, `force` | session |
| POST | `/v1/sessions/:id/wait` | `timeoutMs` (≤600000), `quietMs`, `lines` | output + `{ timedOut, waitedMs, sleptMs }` — time the machine slept is not counted against `timeoutMs` |
| POST | `/v1/sessions/:id/focus` | | session (the app switches to it; the window is never raised) |
| POST | `/v1/sessions/:id/rename` | `name` (trimmed, ≤80 chars) | session — renames it in the sidebar; does not set the AI mark |
| POST | `/v1/sessions/:id/session-folder` | `folder`: id or name, or `null` to take it out | session. `404 folder_not_found`, `409 ambiguous_folder`; a label change — no AI mark, no relation |
| GET | `/v1/sessions/:id/relations` | | `{ sessionId, relations: [{ sessionId, name, workspaceName, kind: opened\|connected\|manual, direction: outgoing\|incoming, at }] }` — `outgoing` = this session is the `from` of the pair. Pairs the user removed are left out. Not a field of the session so the list (100+ sessions) stays small |
| GET | `/v1/session-folders` | | `{ folders: [{ id, name, createdAt, sessions: [{ id, name, workspaceName }] }] }`, stored order |
| POST | `/v1/session-folders` | `name` | `201 { folder, created: true }`; a folder of that name (trimmed, case-insensitive) exists → `200 { folder, created: false }`. `400` for an empty name |
| POST | `/v1/session-folders/:folder/rename` | `name` | folder. `409 name_taken`, `409 ambiguous_folder`, `404 folder_not_found` |
| DELETE | `/v1/session-folders/:folder` | | `{ removed: true, releasedSessions }` — sessions stay open, only their membership goes |
| POST | `/v1/sessions/:id/release` | | hands it to the user; clears the AI mark |
| DELETE | `/v1/sessions/:id` | `?handTo=<session id>` | kills the pty and removes the session — any session, including the user's. `{ ok, handedOver }`: with `handTo`, the closing session's shown Related pairs are first copied to that session (same kind, direction and time; skipped: the pair with `handTo` itself and any partner `handTo` already has a record with, removed ones included). `handTo` equal to the id → `400`, unknown → `404`, and nothing is closed in either case |
| POST | `/v1/inbox` | `kind`, `text`, `url`; `sessionId` or the `X-Caller-Session` header | `{ request, created }` — see [Inbox](#inbox). `400 session_required`, `404 not_found` |
| GET | `/v1/inbox` | `?unread=1` | `{ unreadCount, requests[] }`, newest first. A request carries `id`, `sessionId`, `sessionName`, `workspaceName`, `kind`, `text`, `url?`, `client`, `read`, `at`, `createdAt`, `readAt` (ISO) |
| POST | `/v1/inbox/:id/read` | | the request, marked read. `404 not_found` |
| GET | `/v1/checklists` | `?status=open\|done\|all` (default `open`) · `?project=` | `{ checklists[] }` in header order — see [Checklists](#checklists). A checklist carries `id`, `title`, `workspaceId`, `workspaceName`, `due`, `overdue`, `done`, `total`, `complete`, `items[]` (`id`, `n`, `text`, `done`, `doneAt`), `client`, `createdBy`, `createdByName`, `createdAt`, `updatedAt` (ISO; absent values are `null`) |
| POST | `/v1/checklists` | `title`, `items?` (string or list), `due?`, `project?` | `201 { checklist, created: true }`; an open checklist of that title → `200 { checklist, created: false }`. `400`, `404 workspace_not_found`, `409 ambiguous_project`, `409 too_many` |
| GET | `/v1/checklists/:checklist` | id or title | `{ checklist }`. `404 checklist_not_found`, `409 ambiguous_checklist` |
| POST | `/v1/checklists/:checklist` | any of `title`, `due` (`null` clears), `project` (`null` clears) | `{ checklist }`. Nothing to change → `400` |
| DELETE | `/v1/checklists/:checklist` | | `{ ok }` |
| POST | `/v1/checklists/:checklist/items` | `items` (string or list) or `text` | `{ checklist, added }` — text it already has is skipped. Empty → `400`, over the cap → `409 too_many` |
| POST | `/v1/checklists/:checklist/items/:item` | `done` (boolean) and/or `text`; item by number from 1 or id | `{ checklist }`. `404 item_not_found` |
| DELETE | `/v1/checklists/:checklist/items/:item` | | `{ checklist }` |

A session carries `aiControlled`, `controlledBy`, `connectedAt` (both `''` when unmarked),
`screenPartial`, `orchestrator` and `openedBy` (see [Master sessions](#master-sessions-orchestrators)).

Status codes that carry meaning: `409 disconnected` (the user clicked Disconnect AI during a wait),
`404 not_found`, `409 awaiting_input` (a question is on screen), `409 not_started`,
`403 not_ai_registered` / `409 has_sessions` (unregistering a workspace).

### Input semantics

- `text` then, after a delay that grows with length, Enter — agent TUIs read a fast Enter as part
  of a paste. `submit: false` types without Enter.
- When the program draws an input box (Claude Code: rows between the last two `─` rules), the API
  checks that Enter emptied it and presses Enter again, up to twice, 3s apart. Under heavy load a
  long prompt once stayed typed-but-unsent. An extra Enter on an empty box does nothing. If it is
  still there, `open` answers `promptSent: false` with a note.
- Anything sent within 600ms of an `escape` key waits out the rest: a terminal reads ESC plus a
  quick character as Alt+character, and the text vanished. Two `escape`s in a row stay fast.
- Multi-line text becomes one bracketed paste when the program enabled bracketed paste (Claude
  Code does), otherwise each newline is sent as Enter.
- `keys` run after `text`: a single character, or `enter escape tab shift-tab backspace space up
  down left right ctrl-c ctrl-d ctrl-l ctrl-u`.
- Input goes through `CLISessionTracker` like typing, so a typed `claude` still gets `--session-id`.

### Showing a session costs the user's caret

`focus` (and `/focus`) switches which session the app displays. The window is never raised, but the
switch itself has a price that cannot be engineered away: a terminal inside a hidden container is
blurred by the browser, so whatever the user was typing in loses the caret. Measured 2026-09-25.

So `focus` defaults to false, and the app makes sure the **newly shown terminal does not pick the
caret up** — otherwise the user's next keystrokes would land in the agent's prompt. Use `focus` only
when the user asked to watch. `t16-api-focus.spec.ts` holds both halves.

### Opening with a prompt

`prompt` is sent only when the start command is running (the shell has a child process), the
screen has then been quiet for 2s, and no question is showing. Otherwise `promptSent: false` and
`note` says why — typically Claude Code asking whether to trust a new folder.

## MCP

`POST /mcp`, JSON-RPC 2.0, stateless, `application/json` responses; `GET` → 405. Protocol versions
2024-11-05 … 2025-11-25 are echoed. Tools: `list_workspaces`, `list_templates`, `list_sessions`,
`open_session` (with `folder`, `session_folder`, `ephemeral`), `send_input` (with optional `wait_seconds`), `wait_for_idle`, `read_output`,
`focus_session`, `rename_session`, `release_session`, `close_session` (with `hand_to`), `list_session_folders`, `create_session_folder`, `rename_session_folder`, `delete_session_folder`, `move_session_to_folder` (`session_id`, `folder`: string or null), `list_session_relations`, `unregister_workspace`, `inbox_notify`
(`kind`, `text`, `url`, `session_id` — or the caller header), `inbox_list` (`unread_only`), `checklist_list` (`status`, `project`),
`checklist_create` (`title`, `items`, `due`, `project`), `checklist_update` (`checklist`, `title`, `due`, `project` — null clears),
`checklist_add_items` (`checklist`, `items`), `checklist_check` (`checklist`, `item` — number from 1 or id, `done` default true; answers
"<title>: 2/5 checked."), `checklist_remove_item`, `checklist_remove`. The server instructions ask a coordinating agent to keep its plan
in a checklist and check items off as they finish. Domain errors come back as tool results with
`isError: true` so the model can read them; screen results are plain text, not JSON.

## MCP 없이 쓰기 (REST + 셸)

MCP 를 설정하지 않아도 쓸 수 있다. 주소와 토큰은 발견 파일에서 읽는다.

```bash
URL=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.climanager/control-api.json')))['url'])")
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.climanager/control-api.json')))['token'])")
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

curl -s "${H[@]}" "$URL/v1/templates"                                     # 무엇을 실행할 수 있나
curl -s "${H[@]}" -d "{\"path\":\"$PWD\",\"template\":\"claude-code\",\"prompt\":\"fix the failing test\"}" \
     "$URL/v1/sessions"                                                   # 열기 (session.id 를 받는다)
curl -s "${H[@]}" -d '{"timeoutMs":300000}' "$URL/v1/sessions/$ID/wait"    # 끝날 때까지 기다리기
curl -s "${H[@]}" -d '{"keys":["down","enter"]}' "$URL/v1/sessions/$ID/input"   # 질문에 답하기
curl -s "${H[@]}" -X DELETE "$URL/v1/sessions/$ID"                        # 닫기
curl -s "${H[@]}" -X DELETE "$URL/v1/workspaces/$WS"                      # API 가 등록한 폴더를 사이드바에서 해제
curl -s "${H[@]}" -H "X-Caller-Session: $CLIMANAGER_SESSION_ID" \
     -d '{"kind":"login","text":"Sign in to Aside, then tell me","url":"https://example.com/login"}' \
     "$URL/v1/inbox"                                                      # 사람 손이 필요할 때 — 앱 인박스로
curl -s "${H[@]}" -H "X-Caller-Session: $CLIMANAGER_SESSION_ID" \
     -d '{"title":"v1.24 release","project":"CLImanger","due":"2026-11-03","items":["Build","Publish"]}' \
     "$URL/v1/checklists"                                                 # 계획을 헤더 체크리스트로
curl -s "${H[@]}" -d '{"done":true}' "$URL/v1/checklists/v1.24%20release/items/1"   # 1번 항목 체크
```

`/tmp`·워크트리처럼 한 번 쓰고 버릴 폴더는 열 때 `"ephemeral": true` 를 주면 마지막 세션이
닫힐 때 등록도 같이 사라진다.

에이전트가 쓸 때는 **HTTP 상태 코드로 분기**한다: `409 awaiting_input` 은 화면에 질문이
있다는 뜻이므로 텍스트 대신 `keys` 로 답하고, `409 disconnected` 는 기다리는 도중 사용자가
Disconnect AI 를 눌렀다는 뜻이므로 사용자가 다시 시키기 전에는 그 세션 사용을 멈춘다. `wait` 의 `timedOut: true` 는 실패가 아니라
"아직 실행 중"이다.

## 요청 하나가 도는 길

```
클라이언트            앱(단일 프로세스)                                 사용자 화면
  | POST /v1/sessions   ControlApiServer
  |-------------------> 토큰·Host·Origin 검사
  |                     ControlApiService
  |                      +- 폴더 -> 워크스페이스 해석(없으면 등록)
  |                      +- 세션 기록 저장 (electron-store, aiControl)
  |                      +- control-api-session 브로드캐스트 -----------> 사이드바에 녹색 세션
  |                                                                       TerminalView 마운트
  |                     TerminalManager <--- terminal-create -------------+
  |                      +- node-pty spawn -> zsh --login -> 템플릿 명령
  |  (응답은 pty 가 생긴 뒤)
  |<--------------------
  |                     pty 출력 --+--> 4ms 배칭 -> 렌더러 xterm (사람이 보는 화면)
  |                                +--> TerminalMirror (headless xterm, 모든 터미널 — 화면 읽기·히스토리)
  | POST .../input      ControlApiService -> TerminalManager.writeInput
  |-------------------> (CLISessionTracker 를 거치는, 사람 타이핑과 같은 경로)
  | POST .../wait       200ms 간격으로 mirror 를 보고 busy/idle 판정 -> 화면 한 장 반환
  |<--------------------
```

- 네트워크는 루프백 한 홉뿐이고 앱 밖으로 나가는 트래픽은 없다.
- pty 를 만드는 주체는 **렌더러**다(기존 세션 생성과 같은 경로). 그래서 세션 열기는 창이
  살아 있어야 성공하고, 아니면 `terminalStarted: false` 로 알려 준다.
- 읽기 경로는 렌더러와 **독립**이다. 창을 숨겨도, 다른 세션을 보고 있어도 화면을 읽을 수 있다.

## 비용 (2026-09-23 실측, `scripts/bench-control-api.mjs`)

| 언제 | 무엇을 쓰나 |
|---|---|
| API **꺼짐** | 서버·타이머 없음. 미러는 히스토리용으로 항상 있다(아래 줄의 파싱 비용·메모리, 0008) |
| API 켜짐, AI 세션 없음 | 대기 중인 소켓 하나. 폴링 타이머 없음 |
| AI 세션 1개 | 화면 미러가 출력을 한 번 더 파싱 — 5~7µs/청크(23~28MB/s). 실제 Claude 세션이 평균 0.5KB/s, 피크 4KB/s 를 내므로 **CPU 0.002%(피크 0.015%)**, 메모리는 스크롤백 2000줄을 가득 채웠을 때 힙 0.86MB + 줄 버퍼(폭에 비례) — RSS 80열 약 2.5MB, 200열 약 8MB(2026-10-13 재측정) |
| `wait` 가 떠 있는 동안 | 200ms 마다 화면 1장 검사 30~60µs → **0.03%** |

비교용: 같은 머신에서 포트 모니터는 포트 11개일 때 CPU 약 7%다(루트 `CLAUDE.md`).

미러는 API 와 상관없이 **모든 터미널에 pty 생성 시점부터** 붙는다 — 렌더러가 죽거나 창을 다시 열어도
화면을 되살리는 히스토리 원본이기 때문이다([0008](../decisions/0008-terminal-history-lives-in-main.md)).
예전에는 서버가 살아 있는 동안에만 붙였다(`startMirroring`/`stopMirroring`, 삭제됨). 스크롤백 2000줄은
`read --tail` 이 돌려줄 수 있는 최대 줄 수이자 복원되는 히스토리 길이다.

## Renderer contract

Main broadcasts `control-api-session` (`ControlApiSessionEvent`: `opened` / `updated` / `closed` /
`focus` / `workspaceRemoved`). The store is already updated when it arrives; `App.tsx` mirrors it into
React state. `opened` carries `workspace` when the folder was just registered and `folder` when a
sidebar folder was just created for it. `workspaceRemoved` also fires when the **user** closes the
last session of an ephemeral workspace (`remove-session` IPC) — the renderer drops the workspace the
same way as a sidebar delete.
It also broadcasts `control-api-masters` (`ControlApiMasters`, the whole snapshot on every change);
`hooks/useControlApiMasters.ts` holds it in one module-level store so each sidebar row reads it
without its own IPC listener.
IPC: `get-control-api-state`, `set-control-api`, `regenerate-control-api-token`,
`control-api-release-session`, `get-control-api-masters`.
The inbox has its own channel `inbox` (the whole list on every change) and `get-inbox`, `mark-inbox-read`,
`mark-inbox-all-read`; `hooks/useInbox.ts` holds it in one module-level store
like the masters. Checklists likewise: channel `checklists` (the whole list in header order on every change)
and `get-checklists`, `create-checklist`, `update-checklist`, `remove-checklist`, `add-checklist-item`,
`update-checklist-item`, `remove-checklist-item`; `hooks/useChecklists.ts` holds it the same way.
