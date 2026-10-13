---
description: When changing where terminal history is kept, how a terminal view attaches to a pty, or when tempted to switch the screen mirror off while the Control API is off
authority: Rationale for keeping every terminal's history in the main process (mirror + disk snapshots) and the attach protocol a terminal view follows
status: active
owner: maintainer
last-reviewed: 2026-10-13
---

# 0008. Terminal history lives in the main process

## Context

A terminal's history existed only in the renderer's xterm. The ptys live in the main process and
outlive the renderer, so every way the renderer goes away left a running session with a blank
screen:

- **The renderer crashes.** Under memory pressure the window turns white. Nothing reloaded it.
- **The window is closed and reopened** while the app keeps running (macOS default). On
  2026-10-12 the running app's main process was 2 days old and its renderer 40 minutes old.
- **The app is force-quit.** The ptys die too; Claude's `--resume` reprints its own conversation,
  but nothing else — shell output, earlier conversations in the tab, messages before a compaction.

A new view also could not tell that its pty was already running, so it typed the session's start
or resume command again. On 2026-10-12 a reopened window typed `cldy --resume <id>` into four live
Claude sessions, which sent it as part of the next prompt (found in their transcripts).

## Decision

- **Every terminal is mirrored, always** — not only while the Control API is on
  ([0006](0006-control-api-reaches-every-session.md) attached mirrors only then). The mirror
  (`TerminalMirror`, headless xterm, 2000 lines) is the source of history.
- **A view attaches; it does not just listen.** `terminal-create` spawns the pty if needed and
  returns `{ existed, snapshot, attachToken }`. Main holds that terminal's output, serializes the
  mirror inside a write callback (so the snapshot holds exactly the output before the hold), and
  releases the held output when the view sends `terminal-attached`. One attach per terminal at a
  time; a view that never confirms is released after 3s. A view that gets `existed: true` never
  types the start or resume command.
- **A crashed renderer is reloaded** (at most 3 times a minute) and redraws from the mirror.
- **Snapshots go to disk** (`userData/scrollback/<id>.ans`) every 30s for terminals that printed,
  and on the quit/update paths. A new pty starts with the saved history laid into its mirror,
  followed by a "Restored from previous session" marker. Files follow sidebar sessions: deleting a
  session deletes its file, and startup removes orphans.

Rejected:

- *Snapshot the renderer's xterm.* It is exactly what disappears in the cases above, and output
  printed while the window is white never reaches it.
- *Append raw pty output to a log and replay it.* Cheaper, but TUIs draw with relative cursor
  movement at whatever size the pty had; replaying across resizes and from a truncated start
  produces garbage.

## Consequences

- Mirror memory is paid with the API off too. Measured 2026-10-13 (fully-filled mirror): heap
  0.86MB plus line buffers that scale with width — RSS ~2.5MB at 80 columns, ~8MB at 200. Mirrors
  only fill as terminals print; a user with the API on already paid this.
- Each disk save serializes the mirror: ~14ms and ~370KB for a full 200-column mirror. At one save
  per 30s per terminal that printed, a busy session costs ~0.05% CPU and ~44MB/h of writes.
- A restart lays every saved history into its mirror at once. Measured 2026-10-13 with 40 sessions,
  each a full 2000-line history (270KB file), hidden terminals at 80 columns: terminals registered
  0.6s later (2.0s vs 1.4s), restored history on screen before the shells print (2.1s vs 4.1s), main
  RSS 461MB vs 240MB and still there 18s later (line buffers +93MB, heap +48MB) — ~5.5MB per session.
  That is what a mirror costs once its terminal has printed 2000 lines anyway; the restore only
  pays it up front.
- A force-quit loses at most the last 30s of output.
- A restarted Claude session shows its conversation twice: the restored history, then the marker,
  then Claude's own `--resume` reprint. Accepted (user decision 2026-10-12) — the restored copy is
  the only one that has everything.
- Cmd+K clears the mirror too, so cleared output does not come back in a new window or a restart.

## Reversal

- If mirror memory becomes a problem, shrink `MIRROR_SCROLLBACK` before going back to API-only
  mirrors; without a mirror a crashed or reopened window starts blank again.
- If the disk writes matter (many always-busy sessions), lengthen the interval or skip saves whose
  scrollback did not grow — do not drop disk snapshots, which are the only history after a force-quit.
