---
description: When adding or debugging an integration with an external AI CLI (hooks, status line, usage data)
authority: Observed behaviour of external CLIs that CLI Manager depends on and cannot control
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# External CLI Integrations

What belongs here: behaviour of **someone else's** CLI that we depend on — event names, payload
shapes, config file formats, and the limits of what each tool will tell us. These facts are what
break when a vendor ships an update, so they are worth stating once with the date they were checked.

What does not belong here: how CLI Manager reacts to those events. That lives in code, next to the
implementation (`src/main/AgentHookBridge.ts`, `AgentStatusResolver.ts`, `UsageTracker.ts`), and the
invariants live in the root [`CLAUDE.md`](../../CLAUDE.md).

## Current integrations

| Tool | Status signal | Usage signal | Config file we edit |
|---|---|---|---|
| Claude Code | 6 lifecycle hooks | `statusLine` stdin payload | `~/.claude/settings.json` |
| Codex | `notify` → `agent-turn-complete` only | `~/.codex/sessions/**/rollout-*.jsonl` | `~/.codex/config.toml` |
| Gemini CLI | not integrated | not integrated | — |

### Claude Code (verified 2026-08-15)

- Hook events used: `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`,
  `Notification`, `SessionEnd`.
- Payload arrives on **stdin** as JSON. Key fields: `session_id`, `cwd`, `hook_event_name`,
  `tool_name` (permission events), `transcript_path`.
- `session_id` is the reliable join key because CLI Manager injects `--session-id` itself
  (`src/main/CLISessionTracker.ts`).
- **Rate limits are exposed only through the status line**, not through hooks: the statusLine
  command receives `rate_limits.five_hour.{used_percentage,resets_at}` and `.seven_day.*` plus
  `context_window.used_percentage`. They appear only for subscription plans, and only after the
  session's first API response.
- Configuring any status line suppresses most of Claude Code's built-in footer hints. That is a
  visible side effect of enabling usage tracking and is stated in the Settings copy.

### Codex (verified 2026-08-15)

- Only one event exists: `agent-turn-complete`. There is no turn-*start* signal — see
  [`../backlog.md`](../backlog.md).
- The payload is passed as **argv[1]**, not stdin. Fields: `type`, `thread-id`, `turn-id`, `cwd`,
  `last-assistant-message`.
- `notify` is a **root key** in `config.toml`, so it must stay above the first `[table]` header.
- `thread-id` is not something CLI Manager can set, so Codex events are matched by `cwd` and tool
  name instead.
- Rate limits need no hook: they are written into the session rollout file as a `rate_limits`
  object. `primary`/`secondary` slots are **not stable across plans** — on a Pro account the weekly
  window was observed in `primary` with `secondary: null`. Identify a window by `window_minutes`
  (10080 = weekly), never by slot position.
- Rollout files are appended to when a session is resumed, so the newest limits are regularly in a
  file whose **name** is days old. Select by modification time.

## Research notes

Background material gathered before the integration was built. Kept because it records what was
checked and when, but it is **not** authoritative — the tables above are.

- [`hooks-codex-research.md`](hooks-codex-research.md) — hook/notification systems across Claude
  Code, Gemini CLI, and Codex CLI.
- [`hooks-gemini-research.md`](hooks-gemini-research.md),
  [`hooks-gemini-research-2.md`](hooks-gemini-research-2.md) — Gemini CLI specifics, for the
  integration that has not been built yet.

## Update triggers

Update this file when a vendor changes an event name or payload shape, when a new CLI is
integrated, or when a verification date is more than a release cycle old. Re-verify by reading the
vendor's current docs **and** by observing a real payload — the two have disagreed before.
