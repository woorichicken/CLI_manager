---
description: When changing how the Mac app draws an HTML report (the preview window or a split pane), the `climanager-doc:` scheme, the window's `frame-src`, or what a document's page may reach
authority: Rationale for drawing reports in a sandboxed frame on a custom scheme, with the phone's rules (0011)
status: active
owner: maintainer
last-reviewed: 2026-11-16
---

# 0013. The Mac draws a report in a sandboxed frame on a custom scheme

## Context

A report the Chat names opened in the browser (90043d9d), because the text preview reads 500 KB at most and shows HTML as its
source. Reports are larger (a Fork review page was 925 KB, the phone measured 42.6 MB) and carry scripts. The person asked to see
them in the app — in the preview window first, and beside a session in split view (backlog 「앱 안 브라우저」, decided 2026-11-16).

The window's renderer holds `window.api`: every IPC the app has, terminals included. A report's code on the renderer's origin
could type into any session. The phone met the same problem and answered it with a sandboxed frame (0011); the Mac has no server
to serve the page from.

## Decision

- **A privileged custom scheme, `climanager-doc://doc/<token>/<file>`, answered by `protocol.handle` in main.** Not `file://`
  (the renderer's own origin in a packaged app) and not `srcdoc` (it inherits the window's policy, and a page's pictures and
  scripts beside it would not load). Standard and secure so relative addresses work; CORS-enabled for fonts and modules beside
  the page; **not** `supportFetchAPI`, **not** `bypassCSP`. The token is in the path: a standard scheme lowercases its host.
- **The frame: `sandbox="allow-scripts allow-forms allow-modals"`, and the same flags in a `Content-Security-Policy: sandbox`
  header** — the phone's, never `allow-same-origin`. The page gets an opaque origin, so `parent.api` throws. The preload does not
  run in subframes (`nodeIntegrationInSubFrames` is off).
- **The page's policy is the phone's:** `connect-src 'none'`, `form-action 'none'`, every other source limited to its own token's
  folder. No fetch, beacon, XHR, socket or form leaves the frame.
- **The window's policy gains `frame-src climanager-doc:`** and nothing else. It also keeps the frame from navigating to the web;
  main's `will-frame-navigate` holds the same rule where no page can reach it.
- **A token names one document's folder**, minted by `doc-preview-open` when the person opens a page: the document itself, plus the
  file types a page loads (the phone's list — no `.json`, `.env`, dot files), and nothing beside a document kept directly in home,
  `~/Downloads` or a temp folder. 32 tokens in memory, gone on quitting. The renderer is the app, so the token is not kept from the
  person; it is kept from other pages.
- **The phone's 64 MB limit, streamed.** The 500 KB of `read-file-content` stays for reading words (the Source view uses it).
- **A small script in front of the page** (`DOC_PREVIEW_BRIDGE`): storage that lives in the page (an opaque origin's
  `localStorage` throws and stops a kit's script), a press passed up (make a pane active), a link
  to another page of the folder handed to the window — which opens it like any page, so the path shown, Source and Browser
  follow — and other links do nothing. It adds no power: the page could post the same messages, and the window takes only a
  plain relative `.html` path (`docPreviewSibling`). Escape stays the page's — it is not passed up (fb-1117 b6a75106: a review
  page closes its enlarged photo with Escape, and passing it up closed the preview and the comments kept in the page). The
  window's × closes, or Escape with the focus outside the page.
- **A split pane holds a document by a `doc:` id in the split's list.** It takes a place like a session; places that look a
  session up by id find none, and the grid window, the recent list and the Related dialog skip it. Not saved: the split is not.

## Consequences

- A report's web fonts and web pictures do not load, as on the phone. Its links to the web do nothing; the Browser button opens
  the whole page where they work.
- A kit's comments do not reach a session from the Mac frame (the phone's send sheet is not here). Kept comments last as long as
  the frame.
- The Source view of a page over 500 KB says it is too large; Browser or an editor reads it.
- A page can make the preview show another page of its own folder (or below it) without a click — even in `~/Downloads`, where
  its token serves nothing beside it. It is a page the person could open; the new page gets its own token and frame.
- A page can still send itself out over WebRTC, which CSP cannot stop (as 0011). It holds no API answer and no cookie.

## Reversal

- If reports need to send comments to a session from the Mac, add the phone's send sheet and its messages to the bridge (0011).
- If a real browser tab is wanted (any site, login, downloads), that is the backlog's (b): a `WebContentsView` with its own
  session, decided separately — not a loosening of this frame.
- If web fonts turn out common, add their hosts to `style-src`/`font-src`, knowing each open then tells that host.
