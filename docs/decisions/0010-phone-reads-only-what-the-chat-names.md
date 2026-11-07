---
description: When changing which files a phone may read, the protected list, what a view-only device may open, or how the phone's file panel opens and closes
authority: Rationale for the phone's file routes — the chat's links as the grant, the eight steps, the protected list and who is left out
status: active
owner: maintainer
last-reviewed: 2026-11-07
---

# 0010. A phone reads only the files its chat names

## Context

Agents answer with paths: a capture, a report, the line of code they changed. On the phone those paths were words
(`openFile` did nothing), so a person away from the Mac could not see what the agent made. A phone that can type
can already run `cat` in the terminal; a door for reading files adds no power to that device, but it is a door that
answers with bytes, it stays open while the phone connection is on, and what it answers is what a prompt injection
would ask for. So the question is not «can this be done» but «which path is it allowed to name».

Measured on this Mac (220 sessions, 11-07): the chats named about 3,456 paths; 1,418 of those files exist, 1,302 in
home, 116 in the temp folder, none elsewhere. 2,037 (59%) no longer exist. 6 of the 1,418 (0.4%) hit the protected list.

## Decision

- **The grant is the chat's own links.** `mentionedPaths` (`ChatView/chatMentions.ts`) walks the parts the screen draws
  with the functions that draw them. A link the phone shows cannot be refused for not being named, and a path the
  person never saw as a link is not a way in. Worked out afresh for each request (median 0.14 ms a session): there is
  no list to keep in step.
- **Eight steps, the first refusal ends it** (`phone/phoneFiles.ts` `openGrantedFile`): role → `Sec-Fetch-Site` →
  well-formed absolute path, `..` gone → the source grants it → `realpath` → inside home, temp or the session's folder →
  not on the protected list (both the asked path and the real one) → opened non-blocking and a regular file.
  Step 4 comes before the disk, so nothing tells a phone what exists that it was not given.
- **Native `realpath`, comparing in lower case and composed form.** `~/.SSH` is `~/.ssh` on a Mac disk; the JavaScript
  `realpathSync` hands `~/.SSH` back unchanged and it would slip past a case-sensitive list.
- **Symlinks are not refused; they are judged by where they lead.** Ordinary links exist (`~/.claude/skills → ~/skills/…`).
  `report.png → ~/.ssh/id_rsa` fails at step 7.
- **Devices that can only watch get no files**, no links either: a tool's file is already in the chat, but a file only
  mentioned in words would become newly readable. Lifting this is one line.
- **The bytes cannot act as the page.** `CSP: sandbox`, `CORP: same-origin`, `no-store`, `nosniff`. Only pictures are
  `inline`; everything else, HTML included, is `attachment`. Owner devices come in with no cookie (serve's headers), so
  `SameSite` protects nothing here — `Sec-Fetch-Site` and CORP do. A document in a sandboxed frame cannot reach this route
  for the same reason.
- **Asynchronous, all of it.** Main draws every terminal's output; a slow disk must not stop it.
- **The panel lies over the chat.** It does not replace it: scroll and draft stay. Opening adds a history entry with the
  **same address**, so the phone's Back closes it, a file's path never lands in the browser's history, and `PhoneApp`,
  which reads its route from the address, sees nothing change.

## Consequences

- A protected name costs a trip to the Mac even when it was harmless: a Keynote `.key`, a `credentials.md`.
- The masking on text (`maskSecretLines`, `joinLines: false` so line numbers stay true) is a courtesy, not a boundary:
  pictures and downloads are not masked, and a downloaded file stays on the phone.
- A link stays even when its file is gone (59% today). Tapping says which path was looked for. Checking ahead would
  mean asking the disk for every link drawn.
- Not covered: the typing device itself (it has a terminal), a link swapped between `realpath` and `open` (only a process on
  this Mac can, and it can read the file directly), hard links, a secret file whose name is not on the list.
- A tool output read whole (`Show all`) holds links the turns do not: `ConversationService` remembers those paths per
  session, in memory. After a restart, a page still showing such a link is refused until the output is read again.

## Reversal

- If people want to browse their files from a phone: drop step 4 for a folder picker. That reads everything off the list
  in home, so it needs its own decision.
- If a watching device needs files: the role check at step 1, and `canOpenFiles` in `SessionScreen`.
- If a video should play in place: range requests on the raw route (there are none; `<video>` needs them).
