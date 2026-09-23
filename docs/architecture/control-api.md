---
description: When calling, extending, or debugging the AI Control API (REST under /v1, MCP at /mcp) that lets an AI open and drive sessions
authority: Endpoint, tool, and state contract of the AI Control API
status: active
owner: maintainer
last-reviewed: 2026-09-22
---

# AI Control API

Lets an AI open sessions in CLI Manager, type into them, wait for them, and read the screen — in
terminals the user watches. Why it is shaped this way:
[`../decisions/0005-ai-control-api-local-http.md`](../decisions/0005-ai-control-api-local-http.md).

Code: `src/main/ControlApiServer.ts` (HTTP, auth, routes) · `ControlApiService.ts` (behaviour) ·
`controlApiMcp.ts` (MCP tools) · `TerminalMirror.ts` (screen) · test `tests/terminal/t15-control-api.spec.ts`.

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

| Can | Cannot |
|---|---|
| List workspaces and templates | Read or type into sessions the user opened |
| Open sessions (and register a new folder as a workspace) | Act on a session after the user clicks **Disconnect AI** |
| Drive, read, focus, release, close sessions it opened | Type text while the screen shows a question (unless `force: true`) |

A session it opened carries `aiControl: { client, since }` in the store. The flag persists across
restarts; the sidebar draws such sessions in green with a bot icon, and the header shows
"AI connected".

## Session state

| `state` | Meaning |
|---|---|
| `starting` | Session exists, the renderer has not spawned its pty yet |
| `busy` | Output within the last 1.5s, **or** "esc to interrupt" on screen, **or** a hook reports a running turn |
| `idle` | None of the above |
| `exited` | The pty is gone |

`awaitingInput: true` — the bottom 15 lines of the screen show a question (permission prompt,
folder-trust dialog, "Enter to confirm · Esc to cancel"), or a hook reported one. Answer with keys.

## REST

All requests: `Authorization: Bearer <token>`. Optional `X-Client-Name` labels the session owner
(default `api`; MCP calls default to `mcp`). Errors: `{ "error": { "code", "message" } }`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/v1/health` | | `{ ok, app, version }` |
| GET | `/v1/workspaces` | `?query=` substring | workspaces with `kind`, session counts |
| GET | `/v1/templates` | | `{ id, name, command, description }[]` |
| GET | `/v1/sessions` | | sessions under AI control |
| POST | `/v1/sessions` | `path` or `workspaceId`; `template` or `command`; `name`, `prompt`, `focus` | `{ session, createdWorkspace, terminalStarted, promptSent, note? }` |
| GET | `/v1/sessions/:id` | | session |
| GET | `/v1/sessions/:id/output` | `?mode=screen\|tail&lines=` | `{ session, mode, cols, rows, lines[] }` |
| POST | `/v1/sessions/:id/input` | `text`, `submit` (default true), `keys[]`, `force` | session |
| POST | `/v1/sessions/:id/wait` | `timeoutMs` (≤600000), `quietMs`, `lines` | output + `{ timedOut, waitedMs }` |
| POST | `/v1/sessions/:id/focus` | | session (the app switches to it; the window is not raised) |
| POST | `/v1/sessions/:id/release` | | hands it to the user; API loses access |
| DELETE | `/v1/sessions/:id` | | kills the pty and removes the session |

Status codes that carry meaning: `403 not_controlled` (not the API's session, or disconnected),
`404 not_found`, `409 awaiting_input` (a question is on screen), `409 not_started`.

### Input semantics

- `text` then, after a delay that grows with length, Enter — agent TUIs read a fast Enter as part
  of a paste. `submit: false` types without Enter.
- Multi-line text becomes one bracketed paste when the program enabled bracketed paste (Claude
  Code does), otherwise each newline is sent as Enter.
- `keys` run after `text`: a single character, or `enter escape tab shift-tab backspace space up
  down left right ctrl-c ctrl-d ctrl-l ctrl-u`.
- Input goes through `CLISessionTracker` like typing, so a typed `claude` still gets `--session-id`.

### Opening with a prompt

`prompt` is sent only when the start command is running (the shell has a child process), the
screen has then been quiet for 2s, and no question is showing. Otherwise `promptSent: false` and
`note` says why — typically Claude Code asking whether to trust a new folder.

## MCP

`POST /mcp`, JSON-RPC 2.0, stateless, `application/json` responses; `GET` → 405. Protocol versions
2024-11-05 … 2025-11-25 are echoed. Tools: `list_workspaces`, `list_templates`, `list_sessions`,
`open_session`, `send_input` (with optional `wait_seconds`), `wait_for_idle`, `read_output`,
`focus_session`, `release_session`, `close_session`. Domain errors come back as tool results with
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
```

에이전트가 쓸 때는 **HTTP 상태 코드로 분기**한다: `409 awaiting_input` 은 화면에 질문이
있다는 뜻이므로 텍스트 대신 `keys` 로 답하고, `403 not_controlled` 는 사용자가 세션을
회수했다는 뜻이므로 그 세션 사용을 멈춘다. `wait` 의 `timedOut: true` 는 실패가 아니라
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
`focus`). The store is already updated when it arrives; `App.tsx` mirrors it into React state.
IPC: `get-control-api-state`, `set-control-api`, `regenerate-control-api-token`,
`control-api-release-session`.
