---
description: When editing a config file the user owns, or when a shared entry point already has a value
authority: Rationale for chaining to pre-existing hook commands instead of overwriting them
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# 0002. Third-party hook config is wrapped, never replaced

## Context

`~/.claude/settings.json` `statusLine` and `~/.codex/config.toml` `notify` each hold exactly **one**
command. Both are popular extension points: the maintainer's own machine already had a status line
HUD and a Codex notifier installed before this feature existed.

Writing our command into either slot silently deletes whatever was there. The user would see their
HUD disappear with no error and no obvious cause.

## Decision

On install we capture the existing command, persist it to `~/.climanager/hook-state.json`, and
render it into our script as a delegate. Our script records what it needs and then executes the
original, passing stdin through (`statusLine`) or arguments through (`notify`).

Uninstall restores the captured command. Lifecycle hook **arrays** are additive, so there we append
our entry and remove only our own on uninstall.

Two guards make repeat installs safe:

- We refuse to capture a delegate that is already one of our scripts, so re-installing cannot chain
  a script to itself and recurse.
- Our entries are identified by script path, so a re-install replaces rather than duplicates them.

## Consequences

- The delegate command is baked into the script text, so scripts are re-rendered on every app start
  to survive an app move or update.
- A slow or broken third-party command now runs inside our wrapper. Failures are swallowed
  (`|| true`) so they cannot take down the capture or the agent, which means a genuinely broken
  delegate fails silently.
- Enabling usage tracking on a machine with **no** status line still configures one, which
  suppresses Claude Code's built-in footer hints. This is disclosed in the Settings copy rather
  than hidden.

## Reversal

If either vendor changes these single-value slots to accept a list, the wrapping machinery becomes
unnecessary complexity and should be replaced with a plain append.
