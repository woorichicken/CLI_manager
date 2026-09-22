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

## Renderer contract

Main broadcasts `control-api-session` (`ControlApiSessionEvent`: `opened` / `updated` / `closed` /
`focus`). The store is already updated when it arrives; `App.tsx` mirrors it into React state.
IPC: `get-control-api-state`, `set-control-api`, `regenerate-control-api-token`,
`control-api-release-session`.
