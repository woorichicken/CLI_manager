---
description: When tempted to delete the screen-hash status detection now that official hooks exist
authority: Rationale for running the legacy heuristic alongside official hook events
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# 0003. The screen heuristic stays alongside official hooks

## Context

Session status used to be inferred by hashing terminal output and calling a changed screen
"running" — the approach claude-squad uses. Official hooks are strictly more accurate, so deleting
the heuristic was the obvious cleanup.

It would have been wrong. The heuristic still covers cases hooks do not:

- the user has not opted into the integration (it is off by default, because it edits their files);
- installation failed on their machine, or another tool overwrote the config;
- the CLI in the terminal is not one we have an integration for.

Deleting it would turn "less accurate" into "nothing at all" for every one of those users.

## Decision

Both paths stay live. `AgentStatusResolver` ranks sources `hook > osc > heuristic` and a
lower-ranked source cannot overwrite a higher-ranked one while the higher one is fresh
(30 minutes for hooks, sized against a long-running agent turn).

The renderer no longer applies heuristic results directly; it reports them to the main process and
the resolver decides. That keeps one arbiter instead of two components racing.

Precedence expires. If hooks are uninstalled mid-session, the heuristic takes over once the
authority window lapses rather than leaving the session frozen on its last hook value.

## Consequences

- Two detection paths to keep working, and the heuristic's polling cost remains.
- Status can come from different sources on different sessions in the same window. `source` is
  carried on every update so this is inspectable rather than mysterious.
- The heuristic deliberately skips the visible session; hooks do not. Status coverage is therefore
  better for hooked sessions in a way that is not obvious from the UI.

## Reversal

Drop the heuristic when official hooks cover every CLI the app supports **and** telemetry shows
the integration enabled for effectively all sessions. Neither holds today: the integration is
opt-in and defaults to off.
