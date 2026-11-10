#!/usr/bin/env node
// Prints a copied agent screen (a fixtures/prompts file) and stays, printing nothing more — the way Claude Code
// waits on a question (T120). `node show-screen.cjs <file>`; Ctrl+C or a signal ends it.
const fs = require('fs')
process.stdout.write('\x1b[2J\x1b[H' + fs.readFileSync(process.argv[2], 'utf8').replace(/\s+$/, '').replace(/\n/g, '\r\n'))
setInterval(() => undefined, 60_000)
