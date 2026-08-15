---
description: When a design choice looks arbitrary and you are about to change it
authority: Rationale for non-obvious architectural choices, and what would reverse them
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# Decisions

One file per decision, named `NNNN-short-slug.md`. A decision belongs here when the choice is not
self-evident from the code and a future reader could reasonably undo it — especially when the
obvious-looking alternative was tried and rejected.

Record what was decided, what it costs, and **what would reverse it**. A decision without a
reversal condition is dogma; the reversal condition is what makes it safe to revisit.

Do not record: routine choices, anything already enforced by a lint rule, or "we used X because we
know X".

## Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-hook-delivery-via-file-spool.md) | Agent hook events are delivered by file spool, not HTTP | active |
| [0002](0002-wrap-not-replace-user-config.md) | Third-party hook config is wrapped, never replaced | active |
| [0003](0003-keep-heuristic-as-fallback.md) | The screen heuristic stays alongside official hooks | active |

## Template

```markdown
---
description: When <the situation where this choice matters>
authority: Rationale for <the choice>
status: active
owner: maintainer
last-reviewed: YYYY-MM-DD
---

# NNNN. Title

## Context
What forced a choice.

## Decision
What we do.

## Consequences
What this costs, including what becomes harder.

## Reversal
The observation that would make this wrong.
```
