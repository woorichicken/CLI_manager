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

The problem is what happens when CLI Manager is not running. A hook fires on **every agent turn**.
If the target is a local HTTP server that is down, each hook waits out the connection timeout
before giving up. That cost lands on the user's agent session, not on us, and it lands whether or
not they are using our app at that moment.

Orca — the largest open-source tool in this category — writes hook state to a file
(`~/.config/orca/agent-hooks/last-status.json`) rather than serving a port. The same constraint
appears to have driven that choice.

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

## Consequences

- Delivery is not instant. A watch event usually arrives in milliseconds, but the 1s sweep is the
  guaranteed floor when directory watching drops an event.
- The spool can accumulate while the app is closed, so startup prunes entries older than 10
  minutes rather than replaying stale history.
- Events cannot carry a response back to the CLI. Blocking hook features — for example answering a
  `PermissionRequest` with an `allow` decision — are unreachable through this path.

## Reversal

If Claude Code gains a hook transport that fails fast when the target is absent (a unix socket with
a short connect timeout, or an explicit "skip if unreachable" flag), the latency argument goes away
and a socket becomes preferable. Revisit also if CLI Manager ever needs to *answer* a hook rather
than observe it — that requirement alone rules the spool out.
