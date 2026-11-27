---
description: When changing what UI an agent may send the app (show_ui, A2UI), where the app draws it, or where a button press on it goes
authority: Rationale for agent-sent UI drawn by the app from an allowlist, with presses typed into the sending session
status: active
owner: maintainer
last-reviewed: 2026-11-27
---

# 0016. An agent may send a small UI; the app draws it from an allowlist and types the answer into that session

> Decided 2026-11-27 with the author: 「한번 시작해보면 좋겠고」 · 「화면 GUI 에 쓸수 있지 않아?」 (a renderer usable
> anywhere in the app, not only in the inbox) · 「처음에 체크리스트 등 고민인데, 이거는 세션에서 결정」 (the first use
> and place were left to the work session) · 「규약을 스킬로 래핑하고 /eli5 처럼 호출」 (a tool plus a skill that
> teaches the call). Prototype: PR on `feat/a2ui-gui-1127`, not merged without the author.

## Context

An agent in a terminal can only ask in prose. When it needs a decision — merge this PR? which of these
three? approve with a note? — the person reads a paragraph and types an answer the agent then parses.
[A2UI](https://github.com/a2ui-project/a2ui) (Apache-2.0, spec v1.0) is a protocol where an agent sends UI
as **data** — components with ids, a data model, actions — and the client draws it with its own parts.
A smoke run (brand session, 11-27) drew a v1.0 card with `@a2ui/react` 0.16.1 under React 19 and got the
button's event back with the typed note.

Terminal agents do not emit A2UI by themselves, so the app needs a tool they call, and a skill that
teaches the call. The input that comes back is the delicate part: a card's button ends up typing into a
terminal where an agent runs.

## Decision

- **Entry**: `POST /v1/ui` and MCP `show_ui` — `{ text, components, data?, kind? }`, only from the session
  the card is for: `X-Caller-Session` is required and is the target (`400 session_required` without it);
  a `sessionId` other than the caller → `403 not_your_session`. The header is asserted by the caller like
  everywhere in this API — the bearer token is the access check, and a token holder can already type into
  any session (0006); this rule keeps a card's answer in the session that asked. Code: `ControlApiService.showUi`.
- **What is drawn — an allowlist in main** (`src/main/agentUi.ts`), not the library's schema:
  - Components: `Card`, `Column`, `Row`, `Text`, `Divider`, `Button`, `TextField`, `CheckBox`,
    `ChoicePicker` — each with only its listed properties. No `Image`, `Icon`, `Video`, `AudioPlayer`
    (remote content; the renderer CSP is `img-src 'self' data:` anyway), no `Modal`, `Tabs`, `List`,
    `Slider`, `DateTimeInput`, no `TextField` variant `obscured` (a card is no place to collect a password
    an agent then reads).
  - Values are literals or `{ "@path": "/…" }` into the card's own data. No `@call`, no `functionCall`
    actions (the basic catalog's `openUrl` would navigate), no `userMessage`, no `@checks`, no child
    templates.
  - One tree under `root`: every id unique and used in one place, nothing unreachable — so no cycle and no
    shared subtree that renders exponentially.
  - A bound slot gets data its part can show: text slots a string, number or boolean; a CheckBox `true`/`false`;
    a ChoicePicker a list of strings (or nothing yet). An object where text goes made the library throw inside
    Lit, where React's error boundary does not see it (Codex review, 11-27).
  - Caps: 40 components, depth 8, 12 children, 12 options, 8 context keys, 500 characters a string,
    16 KB of JSON for the whole card. The card lives in config.json beside up to 200 inbox requests.
  - Refusals are `400 bad_ui` with the first problem in words an agent can act on.
- **Where it is drawn (v1)**: under its request in the inbox — `InboxRequest.ui`. The inbox already binds a
  request to its session, counts it on the bell and the Dock, drops it when the session closes, and has the
  guarded answer path (Reply). A repeat of the same unread text replaces the card, unanswered, with a new
  `rev` (set by the inbox); the open popover redraws it.
- **The renderer is one part that does not know the inbox**: `components/AgentUi/AgentUiCard.tsx` takes a
  card and an `onAction`; `AgentUiSurface.tsx` (lazy chunk) turns it into the three v1.0 messages for
  `@a2ui/react`. Colours come from `color-scheme: dark` and `--a2ui-*` variables. A second place (a pane
  beside the session, a Chat reply) mounts the same part with its own `onAction`; the agent's call does not
  change.
- **Where a press goes**: IPC `inbox-ui-action` → main looks the button up **in the stored card** and
  writes one line — `[CLI Manager card] <event name> <context JSON>` — from its declared event name and
  context. The renderer supplies only the values of `@path` keys (what the person typed or picked), kept
  to strings, numbers, booleans and lists of strings, 1000 characters a value, 2000 for the line; JSON keeps
  a typed newline on one line. The line goes through the Chat view's send (`ConversationService.send`):
  a question on the agent's screen or text in its input box refuses it (the card says why and stays open),
  a working agent gets it when its turn ends, no AI mark. One press at a time; once it is sent or queued
  the card locks (`ui.answered`). Answering does not read the request (b165acc4).
- **A press names the card it was drawn from** (`rev`). A press on a replaced card is refused (`replaced`) —
  otherwise a person who saw PR 324 would answer for the PR 999 the agent swapped in. An answer that was
  being sent while the card was replaced locks only the old card (Codex review, 11-27).

## What it does not do

- No card from a session to another session, and no press that reaches a session without an agent (the
  card is drawn but inert, with the same reason as Reply).
- No remote images, links, scripts, HTML or markdown links; no renderer-side functions.
- No reply channel besides the terminal: the agent reads the answer as its next input. No polling API.
- The library's own validation is a second net, not the boundary — main stores only what it checked.

## Consequences

- Renderer gains `@a2ui/react`, `@a2ui/web_core` (Lit, zod, markdown-it) as devDependencies, bundled into
  a ~1 MB lazy chunk (`AgentUiSurface-*.js`) loaded the first time a card is drawn; the main chunk carries only the wrapper and the import call (checked 11-27: no library code in `index-*.js`).
- `tsconfig.json` maps `@a2ui/web_core/catalogs/basic/v1` to its `.d.ts` (the package's subpath export
  needs `moduleResolution` the project does not use).
- An agent learns the format from the MCP instructions, the tool description and the
  `climanager-session` skill's `references/app.md`.

## Plan

1. v1 (this PR): `show_ui` → inbox card → answer line. Tests T193 (unit: allowlist, tree, caps, answer
   line, store) · T194 (app: drawn, refused on a question, answered and locked, 390 wide).
2. After the author's review: decide the second place (pane beside the session, a card in a Chat reply,
   checklists), each mounting `AgentUiCard`.

## What would reverse it

- If agents keep sending prose anyway, or the person prefers typing an answer, drop the tool and the
  chunk — the inbox and Reply stand on their own.
- If a press typed into a terminal proves risky in practice (a line read as a command by something other
  than the agent), move answers to a pull API the agent reads instead of terminal input.
