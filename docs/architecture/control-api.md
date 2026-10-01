---
description: When calling, extending, or debugging the AI Control API (REST under /v1, MCP at /mcp) that lets an AI open and drive sessions
authority: Endpoint, tool, and state contract of the AI Control API
status: active
owner: maintainer
last-reviewed: 2026-10-01
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

Every terminal is mirrored from the moment its pty starts, so reconnecting to a session returns
its real screen. The one gap: a terminal already running when the API was switched on reports
`screenPartial: true`, and output from before that moment is missing.

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
write it.

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
| POST | `/v1/sessions/:id/release` | | hands it to the user; clears the AI mark |
| DELETE | `/v1/sessions/:id` | | kills the pty and removes the session — any session, including the user's |

A session carries `aiControlled`, `controlledBy`, `connectedAt` (both `''` when unmarked) and
`screenPartial`.

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
`open_session` (with `folder`, `ephemeral`), `send_input` (with optional `wait_seconds`), `wait_for_idle`, `read_output`,
`focus_session`, `rename_session`, `release_session`, `close_session`, `unregister_workspace`. Domain errors come back as tool results with
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
  |                                +--> TerminalMirror (headless xterm, API 전용)
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
| API **꺼짐** | 터미널당 이벤트 emit 0.2~0.4µs/청크(리스너 없음). 서버·타이머·미러 전부 없음 |
| API 켜짐, AI 세션 없음 | 대기 중인 소켓 하나. 폴링 타이머 없음 |
| AI 세션 1개 | 화면 미러가 출력을 한 번 더 파싱 — 5~7µs/청크(23~28MB/s). 실제 Claude 세션이 평균 0.5KB/s, 피크 4KB/s 를 내므로 **CPU 0.002%(피크 0.015%)**, 메모리 0.86MB(스크롤백 2000줄을 가득 채웠을 때) |
| `wait` 가 떠 있는 동안 | 200ms 마다 화면 1장 검사 30~60µs → **0.03%** |

비교용: 같은 머신에서 포트 모니터는 포트 11개일 때 CPU 약 7%다(루트 `CLAUDE.md`).

미러는 **서버가 살아 있는 동안에만** 붙는다(`startMirroring`/`stopMirroring`). API 를 끄면
이전에 열어 둔 AI 세션이 남아 있어도 파싱 비용은 사라진다. 스크롤백 2000줄은 `read --tail`
이 돌려줄 수 있는 최대 줄 수와 같다 — 그 너머는 읽을 방법이 없으므로 갖고 있지 않는다.

## Renderer contract

Main broadcasts `control-api-session` (`ControlApiSessionEvent`: `opened` / `updated` / `closed` /
`focus` / `workspaceRemoved`). The store is already updated when it arrives; `App.tsx` mirrors it into
React state. `opened` carries `workspace` when the folder was just registered and `folder` when a
sidebar folder was just created for it. `workspaceRemoved` also fires when the **user** closes the
last session of an ephemeral workspace (`remove-session` IPC) — the renderer drops the workspace the
same way as a sidebar delete.
IPC: `get-control-api-state`, `set-control-api`, `regenerate-control-api-token`,
`control-api-release-session`.
