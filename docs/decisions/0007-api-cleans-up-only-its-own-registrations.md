---
description: When changing how the Control API registers, files or unregisters workspaces, or when tempted to let it remove one the user added
authority: Rationale for AI-registration ownership, sidebar folder placement and ephemeral workspaces in the Control API
status: active
owner: maintainer
last-reviewed: 2026-10-01
---

# 0007. The API cleans up only the workspaces it registered

## Context

Opening a session in an unregistered folder registers it as a workspace at the top level of the
sidebar. AI sessions open worktrees and `/tmp` folders all day, and nothing could take them away
again except the user: on 2026-10-01 eleven were deleted by hand.

Two easy fixes were rejected:

- **Let the API delete any workspace.** Since [0006](0006-control-api-reaches-every-session.md) the
  API reaches every *session*, but a workspace is the user's arrangement of their projects —
  folders, pins, order. Losing one is not undone by reopening a terminal.
- **Never register at all.** A session needs a workspace to appear in the sidebar, and the user
  wants to see where the AI works.

## Decision

- **Ownership is recorded at registration.** `Workspace.aiRegistration = { client, since }` is set
  only by the API, only when it registers the folder. A workspace **without** it is the user's —
  this makes every store written before the field existed safe by default.
- **The API may unregister only its own, and only when empty.** `403` for the user's, `409` while
  sessions or worktrees hang off it. Unregistering never touches files on disk.
- **Placement applies to new registrations only.** New ones go into a sidebar folder (Settings,
  default `AI Work`, or the call's `folder`). An existing workspace is never moved or flagged
  ephemeral by the API, even when the call asks — the call gets a note instead.
- **Ephemeral is opt-in per registration.** It is removed when its last session closes, by whoever
  closes it, plus a startup sweep for one left empty by a quit.

## What would reverse this

- Users asking the API to tidy *their* workspaces (e.g. "remove everything under ~/tmp"). That needs
  an explicit confirmation path in the app, not a wider API rule.
- Ephemeral registrations vanishing while the user still wanted them — then the auto-removal should
  move to an explicit "keep" action in the sidebar rather than being dropped.
