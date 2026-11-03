# Third-party notices

CLI Manager includes code from the projects below. Each keeps its own license; the full text is
reproduced here as the license requires. The same text is shown in the app (Settings → the version
under the menu → **licenses**).

## ovis

- Project: https://github.com/devswha/ovis (commit `3e51902`)
- Used for: the Chat view — Claude Code and Codex transcript parsers and the model / effort / context
  reader (`src/main/transcript/`), the Claude Code and Codex slash-command tables
  (`src/main/chatCommands.ts`), the Markdown parser and renderer, code highlighting helpers,
  work-block folding, and file-path, line-diff, message-fold, model-name and todo helpers
  (`src/renderer/src/components/ChatView/`). Every file taken from ovis starts with
  `From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.`
- Also used for the phone page (Settings › Phone): the key bar's keys, labels and sequences
  (`src/renderer/src/phone/keyBar.ts`) and the iOS keyboard height fix
  (`src/renderer/src/phone/viewport.ts`) are adapted from ovis `src/lib/keyBar.ts`, `src/lib/keys.ts`
  and `src/lib/viewport.ts`; the service worker (`src/renderer/public/phone/sw.js`) follows
  `public/sw.js`. The phone's access and pairing rules (`src/main/phone/phoneAccess.ts`,
  `PhoneDevices.ts`) follow ovis `server/access.ts` and `server/devices.ts`, rewritten.
- License: MIT

```
MIT License

Copyright (c) 2026 devswha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## TanStack Highlight

- Project: https://github.com/TanStack/highlight (`@tanstack/highlight` 1.0.0, npm)
- Used for: syntax colors in the Chat view's code blocks
- License: MIT

```
MIT License

Copyright (c) 2026-present Tanner Linsley

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ws

- Project: https://github.com/websockets/ws (`ws` 8.22.0, npm)
- Used for: the phone connection's WebSocket server (terminal stream, chat change notices), bundled
  into the app's main process
- License: MIT

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## web-push

- Project: https://github.com/web-push-libs/web-push (`web-push` 3.6.7, npm — unmodified)
- Used for: encrypting and signing the phone's alerts (Web Push, RFC 8291 / 8292), bundled into the
  app's main process. Its source is the npm package `web-push@3.6.7` as published.
- License: Mozilla Public License 2.0

```
Copyright 2015 Marco Castelluccio

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at http://mozilla.org/MPL/2.0/.
```

It brings `asn1.js`, `http_ece`, `https-proxy-agent`, `jws` and `minimist` (all MIT).

## QR Code Generator for JavaScript

- Project: https://github.com/kazuhikoarase/qrcode-generator (`qrcode-generator` 2.0.4, npm)
- Used for: the phone address QR code in Settings › Phone
- License: MIT — Copyright (c) 2009 Kazuhiko Arase. The word "QR Code" is a registered trademark of
  DENSO WAVE INCORPORATED.

