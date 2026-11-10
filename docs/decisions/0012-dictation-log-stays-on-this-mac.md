---
description: When changing what the dictation log keeps, where, for how long, or when tempted to send it anywhere (a report, a phone, the Control API, a server)
authority: Rationale for keeping the dictation log local, off by default, masked and short-lived
status: active
owner: maintainer
last-reviewed: 2026-11-09
---

# 0012. The dictation log stays on this Mac, off by default, and expires

## Context

Chat dictation (11-08) types what the recognizer heard into the message box; the person fixes it and sends. To make dictation
better, the useful signal is the gap between the two: words people keep correcting can become hints for the recognizer
(`SFSpeechRecognitionRequest.contextualStrings`). That signal exists only if someone keeps both texts.

What it would keep is what people say to their agents: project names, file paths, sometimes credentials read aloud, and — with
sound — their voice. The recognizer itself runs on the device (`requiresOnDeviceRecognition`); a log must not undo that.

## Decision

- **Off by default.** Settings › Terminal › Chat view › «Keep dictation log». «Also keep audio» is a second switch, off, usable
  only with the log on; turning the log off turns it off too.
- **This Mac only.** `userData/dictation-log/YYYY-MM-DD.jsonl` and `audio/<id>.wav`, folders 0700, files 0600. Nothing reads it
  back into the app: not the feedback widget's report, not the phone server, not the Control API.
- **Masked before it is written** with the same rules as feedback reports (`maskSecrets.ts`; the home folder becomes `~`).
  Sound cannot be masked — one more reason it is a separate, off switch.
- **Short-lived.** Text 30 days, sound 7 days, removed at start and once a day — also while the log is off, so turning it off
  does not freeze old files in place. «Delete all» (one confirming click) removes the folder at once.
- **The setting is read again at write time.** Turning it off mid-run keeps nothing of that run, its sound included.
- **One line per run, written when its fate is known**: `sent` with the whole box as sent, or why not (`edited-away`, `cancelled`,
  `discarded`, `empty`, `failed`). A run that never listened (permission refused) leaves nothing.

## Consequences

- To learn from the log, someone on this Mac reads it (or hands it to an agent). There is no aggregation across people — that
  would need consent and a place to send it, which this decision rules out.
- `sentText` is the message box, not the dictated span: the diff has to find the span. It also includes text typed before
  or after dictation. Kept simple on purpose; the span can be derived later from `finalText`.
- A report that never arrives (crash, window gone) shows as `discarded` after 30 minutes — no line is lost silently, but the
  person's real outcome is unknown.

## What would reverse this

- People ask to share logs for a shared word list → a separate, explicit export the person triggers and sees, not a change to
  where the log lives.
- 30 / 7 days proves too short to collect enough corrections → lengthen the text period first; sound stays shortest.
