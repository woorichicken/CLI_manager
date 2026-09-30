---
description: When changing which sessions the Control API may touch, what the AI mark means, or when the mirror is attached
authority: Rationale for the Control API's access rule and whole-app screen mirroring; supersedes the access rule in 0005
status: active
owner: maintainer
last-reviewed: 2026-09-30
---

# 0006. While the Control API is on, it reaches every session

## Context

[0005](0005-ai-control-api-local-http.md) let the API touch only sessions it had opened
(`TerminalSession.aiControl`). In use that rule had one hole and one cost:

- **No way back.** The mark could be set only by `open_session` and cleared by `release` or
  "Disconnect AI". Once cleared, the session answered `403 not_controlled` forever, and the API did
  not list it any more — the AI could not even find the id again.
- **The work the user wanted delegated was often already running** in a terminal they had opened.

The maintainer decided (2026-09-30): if the API is switched on, all sessions are reachable.

## Decision

- **Access is the switch, not the mark.** With the API enabled, read, input, wait, focus and close
  work on any session. Everything else in 0005 stands: off by default, `127.0.0.1`, bearer token,
  `Host`/`Origin` checks, text refused while a question is on screen.
- **`aiControl` is a visible mark.** It is set when the API opens a session and the first time it
  reads, types into, waits on or focuses one. Looking a session up (`GET /v1/sessions/:id`, listing)
  does not set it. The sidebar draws marked sessions in green, so the user can see which of their
  terminals something else may type into.
- **"Disconnect AI" interrupts, it does not lock.** It clears the mark and makes a wait in flight
  fail with `409 disconnected`. The next call from the API marks the session again. Ending access
  means switching the API off.
- **Every terminal is mirrored while the API is on**, from the moment its pty starts. A mirror only
  knows what was printed after it was attached, so attaching on first access would hand the AI an
  empty screen — and question detection would be blind until the program printed again. The
  alternatives were rejected:
  - *Ask the program to repaint (SIGWINCH).* Changes what the user sees: repaint debris lands in
    their scrollback (terminal rendering invariant 2 in the root `CLAUDE.md`).
  - *Copy the renderer's xterm buffer on demand.* Needs a new dependency and an IPC round trip, and
    output that arrives during the copy is either lost or applied twice.
- **Listing stays small by default.** `GET /v1/sessions` returns marked sessions; `scope=all` (with
  `query`) returns everything. A real install had 167 sessions — dumping them into every
  `list_sessions` result would cost an agent tens of kilobytes per call.
- **A wait does not count time the machine slept.** Measured by freezing the app for 8s with a 5s
  wait in flight: it came back `timedOut` the instant the app resumed. The poll loop now takes any
  gap of 5s or more out of the budget and reports it as `sleptMs`.

## Consequences

- Any process that can read the token can type into every terminal in the app while the API is on.
  The token file is owner-only, so this is the same boundary as the user's shell — but it is wider
  than 0005's, and the Settings text says so.
- Mirror cost now scales with open terminals, not AI sessions: 0.86MB each when full, and about
  0.001% CPU per terminal at a real agent's output rate (`scripts/bench-control-api.mjs`,
  2026-09-30). Still zero while the API is off.
- A terminal that was already running when the API was switched on has an incomplete mirror. It is
  reported as `screenPartial: true` rather than guessed at.
- The user and an AI can type into the same session at once; nothing arbitrates. See `backlog.md`.
- After an app restart the pty is new. The mark persists, the screen and the running work do not.

## Reversal

- If a user needs one session kept away from the AI while the API stays on, add a per-session
  block that "Disconnect AI" sets and an explicit "Connect to AI" clears — do not go back to
  opened-only access, which is what made reconnecting impossible.
- If mirror memory becomes a problem with many terminals, shrink `MIRROR_SCROLLBACK` before
  switching to on-demand attach; on-demand brings the empty-screen problem back.
