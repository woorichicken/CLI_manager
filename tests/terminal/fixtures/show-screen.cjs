#!/usr/bin/env node
// Prints a copied agent screen (a fixtures/prompts file) and stays, printing nothing more — the way Claude Code
// waits on a question (T120). `node show-screen.cjs <file>`; Ctrl+C or a signal ends it. When the file is
// written again the screen is drawn again from it (T125: the count under the box changes).
const fs = require('fs')
const file = process.argv[2]
const draw = () => process.stdout.write('\x1b[2J\x1b[H' + fs.readFileSync(file, 'utf8').replace(/\s+$/, '').replace(/\n/g, '\r\n'))
draw()
fs.watchFile(file, { interval: 200 }, (now, before) => {
    if (now.mtimeMs !== before.mtimeMs) draw()
})
setInterval(() => undefined, 60_000)
