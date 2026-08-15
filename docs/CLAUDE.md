---
description: When writing, moving, or retiring a document in this repository
authority: Documentation authoring and lifecycle rules for docs/
status: active
owner: maintainer
last-reviewed: 2026-08-16
---

# docs/ Authoring Rules

This file is for readers who are **writing** documentation. Readers looking for a document use the
generated index in the root [`CLAUDE.md`](../CLAUDE.md) instead — routing is one hop, never a walk
down this tree.

## Frontmatter

Every routable document starts with:

```yaml
---
description: When a reader needs this, stated as a situation
authority: What this document is the source of truth for
status: active | review-needed | superseded | archived
owner: maintainer
last-reviewed: YYYY-MM-DD
---
```

`description` becomes the left column of the root routing index, so write it as a **trigger**, not a
topic. "Codex hook payload format" is a topic; "when adding or debugging a CLI hook integration" is
a trigger — only the second lets a reader decide without opening the file.

Documents without `description` are omitted from the index and reported by the structural audit.

## Where things go

| Directory | Holds | Does not hold |
|---|---|---|
| `decisions/` | Why a non-obvious choice was made, and what would reverse it | How-to steps |
| `integrations/` | External CLI/API behaviour we depend on and cannot control | Our own implementation detail (that lives in code comments) |
| `operations/` | Release, publish, and distribution procedures with side effects | Day-to-day dev commands (root `CLAUDE.md` owns those) |
| `legacy/` | Completed-work narratives kept for context | Anything still true and actionable |
| `assets/` | Images referenced by `README.md` | Anything a reader is meant to read |
| `backlog.md` | Work seen here, evidenced, and consciously deferred | Wishlist items with no observation behind them |

## Lifecycle

- `active` — current truth.
- `review-needed` — suspected stale; still routed so a reader is warned rather than misled.
- `superseded` — replaced; must name its replacement. Excluded from routing.
- `archived` — history only. Excluded from routing. Lives under `legacy/`.

Never delete a document to "clean up". Move it to `legacy/` with `status: archived` so the evidence
survives, or delete it in the same change that proves it is wrong.

## Update triggers

Update this file when the directory set changes or the frontmatter contract changes. Update a scoped
`CLAUDE.md` when its directory gains a document, a rule, or a new safety constraint.

Advance `last-reviewed` only after checking the document against current code — not because the file
was touched.

## Deferred work

Anything discovered while doing something else goes to [`backlog.md`](backlog.md) `## Open` with a
concrete path, a reason it was deferred, and a trigger that makes it actionable. An entry without a
trigger is a wish, not a backlog item.

## What must not be committed

- Dated evidence: capture output, metrics snapshots, test reports. `tests/terminal/results/` is
  local-only.
- Credentials of any kind, including R2 and GitHub tokens. See
  [`operations/CLAUDE.md`](operations/CLAUDE.md).
- Personal absolute paths in examples. Use `~/` or a placeholder.
