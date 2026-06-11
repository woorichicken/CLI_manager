#!/usr/bin/env node
/**
 * Replays a JSONL recording (from record-claude.cjs) to stdout with timing.
 *
 * Runs in any terminal with plain node (no native deps), so it can be executed
 * inside the app's terminal to push the exact recorded byte stream through the
 * real pty → IPC → xterm.js pipeline without spending tokens.
 *
 * Usage:
 *   node scripts/mock-cli/replay.cjs <file.jsonl> [--speed 4] [--loop 1] [--max-delay 200]
 *
 *   --speed <n>       time compression factor (default 1 = original timing)
 *   --loop <n>        replay the whole file n times (default 1)
 *   --max-delay <ms>  cap a single inter-chunk delay (default 1000)
 */

const fs = require('fs')

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
if (!file) {
    console.error('usage: node replay.cjs <file.jsonl> [--speed n] [--loop n] [--max-delay ms]')
    process.exit(1)
}
function opt(name, def) {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? def : Number(args[i + 1])
}
const SPEED = opt('speed', 1)
const LOOP = opt('loop', 1)
const MAX_DELAY = opt('max-delay', 1000)

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const chunks = []
for (const line of lines) {
    const obj = JSON.parse(line)
    if (obj.meta) continue
    chunks.push({ t: obj.t, data: Buffer.from(obj.b, 'base64') })
}

if (chunks.length === 0) {
    console.error('recording has no chunks')
    process.exit(1)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function playOnce(iteration) {
    let prevT = 0
    for (const chunk of chunks) {
        const delay = Math.min((chunk.t - prevT) / SPEED, MAX_DELAY)
        prevT = chunk.t
        if (delay > 1) await sleep(delay)
        process.stdout.write(chunk.data)
    }
    process.stdout.write(`\n\x1b[0m\x1b[?25h[replay] iteration ${iteration} done (${chunks.length} chunks)\n`)
}

;(async () => {
    for (let i = 1; i <= LOOP; i++) {
        await playOnce(i)
    }
    process.stdout.write(`[replay] REPLAY-COMPLETE loops=${LOOP}\n`)
})()
