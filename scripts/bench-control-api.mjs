/**
 * What the AI Control API costs while it runs.
 *
 * Three questions, because they have very different answers:
 *   1. the lifecycle events every terminal now emits, with nobody listening
 *      (this is what an app with the API switched OFF pays)
 *   2. parsing one AI session's output into its screen mirror
 *   3. one poll of a `wait` call, and the memory a full mirror holds
 *
 * Feed it a real recording when there is one — synthetic output under-reports,
 * because agent TUIs spend their bytes on cursor moves and redraws:
 *
 *   node scripts/bench-control-api.mjs [scripts/mock-cli/recordings/claude.jsonl]
 *
 * Run with --expose-gc for trustworthy memory numbers.
 */

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')

const REPEATS = 8
const POLLS = 2000
const COLS = 120
const ROWS = 40
const BUSY = /esc to interrupt/i

/** Output of a TUI that redraws a spinner line and streams an answer. */
function synthesize() {
    const frames = ['✻', '✢', '✳', '∗']
    const out = []
    for (let i = 0; i < 400; i++) {
        out.push(`\r\x1b[2K${frames[i % 4]} Working… (${i / 10 | 0}s · esc to interrupt)`)
        if (i % 20 === 0) out.push(`\r\n⏺ answer line ${i} ${'x'.repeat(70)}\r\n`)
    }
    return out
}

function load(file) {
    if (!file || !existsSync(file)) {
        console.log('recording: none — using synthetic output (real recordings cost more)')
        return synthesize()
    }
    const chunks = readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => typeof entry.b === 'string')
        .map((entry) => Buffer.from(entry.b, 'base64').toString('utf-8'))
    console.log(`recording: ${path.basename(file)} — ${chunks.length} chunks`)
    return chunks
}

const base = load(process.argv[2] ?? 'scripts/mock-cli/recordings/claude.jsonl')
const chunks = Array.from({ length: REPEATS }, () => base).flat()
const kb = chunks.reduce((n, c) => n + c.length, 0) / 1024
console.log(`sample: ${chunks.length} chunks · ${kb.toFixed(0)}KB\n`)

const now = () => process.hrtime.bigint()
const sinceMs = (start) => Number(now() - start) / 1e6
const heapMb = () => process.memoryUsage().heapUsed / 1024 / 1024
const mirror = (scrollback) => new Terminal({ cols: COLS, rows: ROWS, scrollback, allowProposedApi: true })
const flush = (term) => new Promise((resolve) => term.write('', resolve))

// 1 — what an app with the API off pays: an emit nobody listens to.
const bus = new EventEmitter()
const emitStart = now()
for (const chunk of chunks) bus.emit('output', 'terminal-id', chunk)
const emitUs = (sinceMs(emitStart) * 1000) / chunks.length
console.log(`[1] terminal event, no listener : ${emitUs.toFixed(2)}µs per chunk (API off pays only this)`)

// 2 — parsing into a mirror. write() queues, so the cost only lands after flush.
//     Repeated: a single run on a loaded machine has been seen 10x off.
const runs = []
let term = mirror(2000)
for (let i = 0; i < 5; i++) {
    const fresh = mirror(2000)
    const parseStart = now()
    for (const chunk of chunks) fresh.write(chunk)
    await flush(fresh)
    runs.push(sinceMs(parseStart))
    if (i === 4) term = fresh
    else fresh.dispose()
}
runs.sort((a, b) => a - b)
const parseUs = (runs[Math.floor(runs.length / 2)] * 1000) / chunks.length
const bestUs = (runs[0] * 1000) / chunks.length
const mbPerSec = kb / 1024 / (runs[0] / 1000)
console.log(`[2] mirror parse               : median ${parseUs.toFixed(1)}µs · best ${bestUs.toFixed(1)}µs per chunk · ${mbPerSec.toFixed(1)}MB/s`)
console.log(`    → a real Claude session emits ~0.5KB/s (peak 4KB/s): ${((0.5 / 1024 / mbPerSec) * 100).toFixed(3)}% CPU, peak ${((4 / 1024 / mbPerSec) * 100).toFixed(3)}%`)

// 3 — one wait poll: read the screen, test the busy and question patterns.
const screen = () => {
    const buffer = term.buffer.active
    const lines = []
    for (let row = 0; row < ROWS; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    return lines
}
const pollStart = now()
for (let i = 0; i < POLLS; i++) {
    const lines = screen()
    lines.some((line) => BUSY.test(line))
    lines.filter((line) => line.trim()).slice(-15).join('\n')
}
const pollUs = (sinceMs(pollStart) * 1000) / POLLS
console.log(`[3] wait poll                  : ${pollUs.toFixed(1)}µs → ${((pollUs / 1000 / 200) * 100).toFixed(4)}% CPU while one wait is in flight`)

// 4 — memory of mirrors whose scrollback is completely full.
const MIRRORS = 5
for (const scrollback of [2000, 5000]) {
    global.gc?.()
    global.gc?.()
    const before = heapMb()
    const terms = []
    for (let i = 0; i < MIRRORS; i++) {
        const t = mirror(scrollback)
        for (let line = 0; line < scrollback + 200; line++) t.write(`line ${line} ${'x'.repeat(110)}\r\n`)
        terms.push(t)
    }
    await Promise.all(terms.map(flush))
    global.gc?.()
    global.gc?.()
    const each = (heapMb() - before) / MIRRORS
    terms.forEach((t) => t.dispose())
    console.log(`[4] mirror memory (scrollback ${scrollback}, full): ${each.toFixed(2)}MB each`)
}
