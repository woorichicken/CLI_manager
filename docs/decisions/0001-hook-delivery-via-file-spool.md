---
description: When changing how agent hook events reach the app, or when tempted to replace the spool with a local server
authority: Rationale for delivering CLI hook events through a file spool
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# 0001. Agent hook events are delivered by file spool, not HTTP

## Context

Claude Code supports an `http` hook type, which looks like the cleaner option: no script to
install, no PATH concerns, JSON arrives as a request body.

The problem is what happens when CLI Manager is not running. Hooks are registered **globally** in
`~/.claude/settings.json`, so they fire for every Claude Code session on the machine — including
sessions in the user's own terminal, which CLI Manager knows nothing about. If those hooks target a
local HTTP server that is down, each one waits out the connection timeout before giving up, on
every turn. That cost lands on the user's agent session.

### What Orca actually does (checked against source, 2026-08-16)

An earlier draft of this record claimed Orca had settled on files. That was wrong, and the
correction matters because it changes what the alternative looks like.

Orca posts over HTTP — `curl -sS -X POST http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/<agent>`
with a token header (`src/main/*/hook-service.ts`). It avoids the timeout problem with an
**environment guard**: every managed script begins with

```sh
if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then
  exit 0
fi
```

Those variables exist only inside a pty Orca spawned. A hook firing in the user's own terminal sees
nothing and exits immediately, and if the app is closed its panes are gone, so no guarded hook can
fire at all. `~/.config/orca/agent-hooks/last-status.json` — which the earlier draft mistook for the
transport — is a persistence cache used to rehydrate status after a restart.

Orca's `ORCA_PANE_KEY` also carries an exact pane identity in the request, so no session-id or
working-directory matching is needed at all.

## Decision

Hook scripts write one file per event into `~/.climanager/events/` and exit. The app watches that
directory (`AgentHookBridge`) and deletes what it consumes.

Supporting rules:

- Scripts are POSIX `sh`, not Node: they must start instantly and must not need a `node` binary on
  `PATH`, which is not guaranteed when the app is launched from Finder.
- Scripts never parse JSON. They wrap the payload verbatim in an envelope and let the app decode
  it, so a payload-shape change from a vendor cannot break the bridge.
- Every script ends with `exit 0`. A broken bridge must never break the agent.
- Files are drained in **modification-time order**. `mktemp` names are random, so without sorting a
  `turn-start` can be processed after its `turn-end` and the status is reported backwards.

The spool reaches the same "never block the agent" guarantee as Orca's env guard without adding a
listening port, a token, or a request-authentication path to the app.

## Consequences

- Delivery is not instant. A watch event usually arrives in milliseconds, but the 1s sweep is the
  guaranteed floor when directory watching drops an event.
- The spool accumulates while the app is closed, so startup prunes entries older than 10 minutes
  rather than replaying stale history.
- Events cannot carry a response back to the CLI. Blocking hook features — answering a
  `PermissionRequest` with an `allow` decision, for example — are unreachable through this path.
- **No exact pane identity.** Because there is nothing to bind an event to a specific terminal,
  `AgentStatusResolver` matches on session id where possible and working directory otherwise, and
  refuses to guess when a directory holds several candidate terminals. Codex sessions are the ones
  that suffer, since Codex reports a `thread-id` we cannot set.

## Reversal

The pane-key design is the concrete alternative, and CLI Manager already meets its prerequisite —
`TerminalManager` spawns every pty, so it can inject a per-pane token and port the same way. Adopt
it when either of these holds:

- ambiguous-directory matching starts producing wrong or missing status in practice, since a pane
  key removes that failure mode entirely rather than mitigating it; or
- a feature needs the hook's **response** (answering a permission prompt from the app), which the
  spool cannot express at all.

Tracked in [`../backlog.md`](../backlog.md).
