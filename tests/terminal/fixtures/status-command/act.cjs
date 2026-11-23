#!/usr/bin/env node
// T158 fixture — the action command. Records exactly the arguments it got (one JSON line per call) so the
// spec can prove the names arrived as arguments and that nothing ran when the app refused.
const fs = require('fs')
const path = require('path')
const dir = process.env.STATUS_FIXTURE_STATE
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'act.log'), JSON.stringify(args) + '\n')
const [, item] = args
if (item === 'fail') { console.error('queue refused: already started'); process.exit(5) }
fs.appendFileSync(path.join(dir, 'cancelled'), item + '\n')
console.log(`cancelled ${item}`)
