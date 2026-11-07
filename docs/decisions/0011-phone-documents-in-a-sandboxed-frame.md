---
description: When changing how a phone opens an HTML report, what the frame's code can reach, the `/doc/` route, or how a document's comments reach a session
authority: Rationale for the sandboxed document frame, its token route, the injected bridge and the send sheet
status: active
owner: maintainer
last-reviewed: 2026-11-07
---

# 0011. A phone opens a report in a sandboxed frame; only the person's press sends its comments

## Context

Agents leave HTML reports, and the person wants to read one on the phone and answer from there. A report is code: 52 of 120
measured reports carry scripts, and all four comment kits are scripts, so a frame without `allow-scripts` shows a dead or blank
page. Such a page on the phone page's origin could read the session list and type into any terminal. Most reports hold nothing of
the kind. The case to cover is words copied in from the web.

The kits were written for a browser tab: comments in `localStorage`, handed over through the clipboard or a saved file. In an
opaque origin the storage throws, and copying behaves differently by kit and engine (html-feedback-kit fails in Chromium and works
in WebKit).

Reports can be large: median 20 KB, 90th percentile 9.4 MB, largest measured 42.6 MB, because before-after puts its pictures in
the file.

## Decision

- **`<iframe sandbox="allow-scripts allow-forms allow-modals">`, and the same flags in a `Content-Security-Policy: sandbox`
  header.** The header is not redundant: opened on its own at the top level, a page without it runs on the phone page's origin
  and reads the API, posts and opens sockets with the cookie (measured). `allow-forms` is there because a `<form method="dialog">`
  closes the point-feedback editor and is dead without it in Chromium; `form-action 'none'` keeps it from sending anything.
  `allow-modals` is there for the kits' «clear» confirmation. **Never `allow-same-origin`.**
- **`connect-src 'none'`, and every other source limited to `<origin>/doc/<token>/`.** With `'self'`, `<img src="/api/…">` reaches
  the server. The parent's `default-src 'self'` also stops the frame from navigating to another host. The phone page's own CSP does
  not change.
- **Neither SameSite nor the cookie is the defence.** WebKit sends the Strict cookie with a sandboxed page's no-cors POST; Chromium
  does not. Tailscale's owner needs no cookie at all. What holds is `connect-src 'none'` and `sameOrigin('null') === false`, which
  refuses a request from an opaque origin before it is looked at. Both are pinned by tests (T101, T102).
- **A route outside `/api/`, `GET /doc/<token>/<path>`.** Chromium sends no cookie with a sandboxed page's pictures, so `/api/`'s
  gate would break every report for a paired device. `POST /api/phone/doc/open` (a POST, so a page cannot mint one with an `<img>`)
  judges the path with `openGrantedFile`, then gives a token for that document's folder: 32 random bytes, memory only, half an hour
  from its last request, eight per device, gone on switching off or disconnecting. Each request asks what `decidePhoneAccess` asks
  first (Funnel, loopback) and whether the device may still ask, then goes through `openGrantedFile` again with the token as step 4.
  Only the file types a page loads leave the folder, and nothing beside a document kept directly in home, `~/Downloads` or a temp folder.
- **A script put in front of the page (`phoneDocBridge.ts`), not a change to the kits.** It replaces `localStorage`,
  `navigator.clipboard`, `execCommand('copy')` and `a.download` with messages to the phone page, so reports already on disk work. It
  adds no power: the page's code could post the same messages. It also keeps a height-only `resize` from the page while a field has
  the focus: that is the keyboard, and before-after redraws on resize, replacing the field being typed in (found on a real phone). Comments live in the phone page's `localStorage`, per page of the
  folder, and come back through the address's fragment, which never reaches the server.
- **Only Send sends.** Whatever the page posts becomes the text of a sheet in the phone page: all of it shown, the frame `inert`
  meanwhile, later messages ignored so the words cannot change while being read, Send disabled for 600 ms so a finger that pressed the
  page's button does not land on it. It posts to the chat's own route, so there is no new way to type into a session; a question on
  screen or text in the Mac's box refuses it as it refuses a typed message.
- **Links in a page move nothing but the frame.** Inside the folder they replace the page, so the panel's back is one press. To the web
  they become a real link in a sheet. To a file of the Mac they go to the file panel, which judges the path like any other.
- **`.html` opens as a document unless the link names a line.** `report.html:42` is a place in the source: the code view.

## Consequences

- A report's web fonts and web pictures do not load (person's decision). The panel counts what failed to load.
- A page reached by a link or a script arrives without its kept comments, so it loads a second time with them. A flash, on the pages that have some.
- Words stay in the document after Send: kits store them differently and the phone page cannot tell them apart. The kit's «clear» is
  the way to start a new round.
- HTML is not masked: like a picture, it is shown as it is. Text reaching the session is recorded as `phone-input`, length only.
- A page can send its own contents and token out over WebRTC, which CSP cannot stop (not measured). The token is worthless outside the
  tailnet and covers one folder's files; the frame holds no cookie and no API answer.
- A page can move its frame to `/api/phone/sessions`: the JSON shows, and the page's code is gone by then, so it cannot read it.
- Each `/doc/` request is a real read of a real file while main draws terminals, so bytes stream and are never read whole.

## Reversal

- If the phone gets a second origin for documents (a separate hostname through `tailscale serve`), the token and the sandbox's
  opaque-origin workarounds could go: cookies would simply not apply and `/api/` could not be reached across origins.
- If kits grow a real way to hand comments to a host page, the bridge's stand-ins for browser objects can shrink to that.
- If reports needing web fonts turn out common, add the font hosts to `style-src`/`font-src`, knowing each open then tells that host.
