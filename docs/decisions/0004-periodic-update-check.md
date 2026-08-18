---
description: When changing how or how often the app checks for updates
authority: Rationale for re-checking for updates on a timer rather than once at startup
status: active
owner: maintainer
last-reviewed: 2026-08-18
---

# 0004. Update checks repeat on a timer, not only at startup

## Context

The app checked for updates once, two seconds after launch, and never again.

That is a reasonable default for an application people quit. CLI Manager is not one: it exists to
keep terminal sessions alive, so it is normally left running for weeks. In that usage pattern a
startup-only check is functionally equivalent to no check at all.

The evidence was on the maintainer's own machine. v1.6.0 shipped on 2026-06-23; the installed copy
was still 1.5.1 two months later. Every part of the update chain was healthy — the manifest
resolved, the build was signed and notarized by the same team — and the release still did not
arrive, because nothing ever asked.

## Decision

Three triggers, in `src/renderer/src/App.tsx`:

- 2 seconds after launch (unchanged);
- every 6 hours while the app runs;
- on window focus, throttled to once per 30 minutes.

Focus is included because returning to the app is when a user is most willing to accept an update
prompt, and it costs one request. The throttle keeps alt-tabbing from turning into a request per
switch.

## Consequences

- Users on 1.6.0 or older still need one manual restart to see 1.7.0; their build has no timer.
  Every release after 1.7.0 reaches them without that step.
- A background request every six hours per running instance. Negligible, and the check is the same
  one the app already made at startup.

## Reversal

If update checking ever becomes expensive — a paid API, a rate limit, telemetry the user objects to
— reconsider the interval before reconsidering the feature. The startup-only behaviour is not a
safe fallback; it is the bug this replaced.
