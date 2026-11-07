---
description: When changing how a phone reaches the app (Settings › Phone), who it lets in, or whether a phone may resize a terminal
authority: Rationale for the phone connection's separate server, its access rule, and the Mac-size terminal
status: active
owner: maintainer
last-reviewed: 2026-11-03
---

# 0009. A phone reaches the app through a second, opt-in server — never the Control API

## Context

The request: see the sessions running on this Mac from a phone (the Mac's own sessions, not new
ones), read their chat, answer a question card, type a few keys, and be told when an agent needs
you. Tailscale already runs on the Mac and the phone. The person's worry, in their words: "the Mac
becomes a server — is that all right?"

Everything a phone needs already lives in main: the ptys, their history (the screen mirror,
[0008](0008-terminal-history-lives-in-main.md)), status, and the Chat view's data
(`ConversationService`). What is missing is a door and a page.

## Decision

- **A second HTTP server, not the Control API.** `src/main/phone/PhoneServer.ts`, off by default
  (Settings › Phone), bound to `127.0.0.1` on its own port (47830). It knows a fixed set of routes —
  the session list, one session's chat, one session's terminal socket, alerts, pairing, the files a
  chat names ([0010](0010-phone-reads-only-what-the-chat-names.md)), the Artifact Dock's list (read
  only; the extension's order, untouched), and (when
  the Mac shows the feedback widget, `drive` devices only) the feedback relay — and
  nothing that creates, deletes, renames or resizes. The Control API port is never forwarded:
  its token opens every session and a phone would have to carry it. The phone server calls the same
  `ConversationService` functions the Electron IPC handlers call, in the same process.
- **Reached through `tailscale serve`, which the person runs.** Settings shows the command and the
  one that undoes it; the app never runs either, nor `tailscale funnel`. A Funnel request (the
  public internet) is refused whatever it carries.
- **Who gets in.** A request whose `Tailscale-User-Login` equals this Mac's own login (read from
  `tailscale status --json`) and whose `X-Forwarded-For` is a tailnet address — serve writes both
  and strips any copy the device sent. Everyone else pairs: a six-digit code shown on the Mac,
  ten minutes, five tries, a token in an HttpOnly cookie, only its hash on disk (0600). A paired
  device can type or only watch; the list is in Settings with a disconnect per device. The rules
  follow ovis `server/access.ts` / `devices.ts` (MIT), without its shared token, open mode or relay.
- **The phone's terminal is the Mac's size.** It draws the mirror's snapshot at the pty's size and
  shrinks it to the phone's width (zoom and pan to read). The server takes only `input` messages on
  that socket — a resize is answered with an error — so a phone never makes the agent repaint at 40
  columns. That width change is the cut-off case the engine test could not fix
  (`plan-ovis-1103/engine-test/report.md`); ovis, which resizes to the phone, would have hit it.
- **The phone attaches like a view, without making the Mac wait for it.**
  `TerminalManager.attachRemote` follows invariant 6 (flush, hold, snapshot, then later output only),
  but the server confirms at once and keeps the order itself — a phone on a slow network never holds
  the Mac's own output.
- **One page, two entries.** The phone page is a second Vite entry of the renderer (`phone.html`)
  and renders the desktop `ChatView` with a fetch + WebSocket `ChatTransport`. The server serves
  phone.html and only the chunks Vite's manifest says it loads.

## Consequences

- While on, a port listens on loopback and the Mac answers phones on the tailnet. The sidebar shows
  «Phone on · n connected» with a one-click off, so it is not forgotten. Quitting turns it off.
- Screen words the phone shows (a question line, a card's text) go through `maskSecrets`; the raw
  terminal stream does not — the phone sees the terminal as the Mac does.
- Alerts (Web Push, `web-push`, MPL-2.0) carry the session name and the question line to Apple's or
  Google's push service, encrypted for the device. Never while someone uses the app at the Mac; once a
  minute per session.
- Text the phone types goes in like typed keys; the session's event log records `phone-input` with
  what happened (never the text). Two people typing at once is not arbitrated — no more than today.
- An iPhone needs the Home Screen app and iOS 16.4+ for alerts.

## Reversal

- If the width-change cut-off is fixed (engine test e1 shows 0), add a «fit to phone» button that
  resizes while the phone types and shows «phone is using this» on the Mac — still never by default.
- If people without Tailscale need it, a relay (ovis `server/relay/`) is the next step; that brings a
  third party into the path and needs its own decision.
- If the Control API grows per-session scoped tokens, the phone could ride it instead of a second
  server — only if Funnel and the Control API's full reach stay unreachable from the phone.
