---
description: When changing what `/v1/queues` may run, the Status panel's action command, or how a queue row is marked read only or manageable
authority: Rationale for queue actions through the Control API — only an action the status report offers on a row right now, names as arguments
status: active
owner: maintainer
last-reviewed: 2026-11-23
---

# 0014. A queue action runs only what the report offers, with the names as arguments

## Context

The Status panel (fb-1120b) shows the machine's queues and locks from the user's own status command,
read only. The author then asked to manage them from the Control API as well — 「/v1/queues 로 Control API 에
넣는 방향 좋아 + 읽기도 하는데, 구분만 가능하면 좋겠어」 (2026-11-23): reading stays, acting is added, and
which is which must be visible.

The queues are not the app's. Each belongs to another tool (a render queue, a lock directory, a remote job
runner) and the app ships to people whose queues it has never heard of. Two easy designs were rejected:

- **The report carries the command to run per row.** Then anything that can shape the report's output can
  make the app run text in a login shell — and the API hands that to whoever holds the token.
- **Interpolate the names into a command template.** A row id with `;` or `$(…)` becomes shell text.

## Decision

- **Two settings, the second off by default.** `statusCommand` reads; `statusActionCommand` (e.g.
  `queues act`) acts. Without the second every queue is read only — the API says `404 actions_off` and runs nothing.
- **The report declares, per queue, what it can do (`actions: [{ id, label }]`) and, per row, what it offers
  now (`actions: [id]`).** Empty means read only. A row may only offer what its queue lists; ids are plain names
  (`[A-Za-z0-9][A-Za-z0-9._:-]{0,79}`) or they are dropped. Missing fields read as read only, so a report from
  before this change stays version 1.
- **Acting re-reads first.** `POST /v1/queues/:source/:item/:action` runs a fresh report (not a shared one in
  flight) and runs the action command only if that row still offers that action — otherwise `404`/`409` and nothing runs.
- **One at a time per row.** A second call for the same queue, row and action while the first runs gets
  `409 action_in_progress`. Calls for different rows are not serialized — the action command must tolerate that.
- **Names are arguments, never text.** The shell gets `<actionCommand> "$@"` with the three names as positional
  parameters.
- **The panel only reads.** It badges each queue `Read only` or `Manage · <labels>` and each row with what it
  offers. Buttons in the app would be a second way to act; they wait until the API path has been used.

## What would reverse this

- Wanting to act from the panel: add a confirmation in the app that calls the same `act`, never a second rule.
- A queue whose actions need parameters (reorder to a position): extend the action shape, still validated
  against the report, rather than passing free text.
