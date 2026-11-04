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
  The key bar's hold-to-repeat (`keyBar.ts`) is adapted from ovis `src/lib/keyRepeat.ts`, and the
  terminal's «Wrap to screen» rows — palette, cell styles and row runs (`src/renderer/src/phone/terminalFold.ts`)
  — from `src/lib/terminalFold.ts`. The in-app alert (`droplets.ts`) follows `src/lib/droplet.ts`'s rules, rewritten.
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


## Nanum Gothic Coding (font)

- Project: Nanum fonts by NAVER — Google Fonts `Nanum Gothic Coding` (fonts.googleapis.com, version 2.000)
- Used for: the phone page's terminal (`src/renderer/src/phone/fonts/clim-phone-mono-ksx1001.woff2`) —
  cut to printable ASCII and the 2,350 Hangul syllables of KS X 1001 by `scripts/subset-phone-font.py`.
  The cut font is a Modified Version under the license below. It is named `CLIM Phone Mono`, not by a Nanum
  name, so that no Reserved Font Name is its primary name (condition 3).
- License: SIL Open Font License 1.1 — Copyright © 2009 NHN Corporation. All rights reserved. Font designed
  by Sandoll Communications Inc.

```
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font
projects, to support the font creation efforts of academic and linguistic communities, and to provide a
free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they
are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved names are not used by derivative
works. The fonts and derivatives, however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any document created using the fonts
or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and
clearly marked as such. This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright statement(s).

"Original Version" refers to the collection of Font Software components as distributed by the Copyright
Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or substituting -- in part or in
whole -- any of the components of the Original Version, by changing formats or by porting the Font
Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed
to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use,
study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may
be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any
software, provided that each copy contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in the appropriate machine-readable
metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written
permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary
font name as presented to the users.

4) The name(s) of the Copyright Holder(s) and the Author(s) of the Font Software shall not be used to
promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this
license, and must not be distributed under any other license. The requirement for fonts to remain under
this license does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO
USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
```
