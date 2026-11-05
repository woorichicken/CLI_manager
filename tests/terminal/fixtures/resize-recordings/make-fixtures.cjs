#!/usr/bin/env node
/**
 * Turns pty recordings of a real `claude` session into the fixtures T86 replays.
 *
 * The recordings (day-1023, `claude` 2.1.309, record.cjs) hold the recorder's home
 * directory in Claude's banner and status line. It is replaced by a placeholder
 * of the same length, so every line keeps its width and the replay draws the same
 * screens. Output between two events is merged into one chunk: the VT parser is a
 * stream, so where a chunk ends does not change what it draws — only where the
 * resizes fall does, and those stay where they were.
 *
 *   node make-fixtures.cjs <recording.jsonl> <out-name> [--home <dir name>]
 *
 * Fails if the home name is still in the output.
 */
const fs = require('fs')
const path = require('path')

const [input, outName] = process.argv.slice(2)
const homeIndex = process.argv.indexOf('--home')
const home = homeIndex === -1 ? path.basename(require('os').homedir()) : process.argv[homeIndex + 1]
if (!input || !outName) {
    console.error('usage: make-fixtures.cjs <recording.jsonl> <out-name> [--home <dir name>]')
    process.exit(2)
}
const placeholder = 'someone-xxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, home.length)
if (placeholder.length !== home.length) throw new Error('home name longer than the placeholder')

// Each part of the name and its leading parts down to 5 letters, longest first.
const pieces = home
    .split(/[-_.]/)
    .flatMap((part) => Array.from({ length: Math.max(0, part.length - 4) }, (_, i) => part.slice(0, part.length - i)))
    .sort((a, b) => b.length - a.length)

const records = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const [meta, ...rest] = records
const out = [{ meta: true, cols: meta.cols, rows: meta.rows, cmd: meta.cmd }]
let pending = null
const flush = () => {
    if (!pending) return
    let text = Buffer.concat(pending.chunks).toString('utf8').split(home).join(placeholder)
    // Claude redraws a line by its changed cells, so a path can arrive in pieces
    // ("…-jeong-gyeong" + cursor move + "un-"). Mask each piece of the name too.
    for (const piece of pieces) text = text.split(piece).join('x'.repeat(piece.length))
    out.push({ t: pending.t, d: text })
    pending = null
}
for (const record of rest) {
    if (record.event) {
        flush()
        if (record.event === 'resize') out.push({ t: record.t, event: 'resize', cols: record.cols, rows: record.rows })
        continue
    }
    if (!pending) pending = { t: record.t, chunks: [] }
    pending.chunks.push(Buffer.from(record.b, 'base64'))
}
flush()

const body = out.map((record) => JSON.stringify(record)).join('\n') + '\n'
for (const piece of [home, ...pieces]) {
    if (body.includes(piece)) throw new Error(`"${piece}" is still in the output`)
}
fs.writeFileSync(path.join(__dirname, `${outName}.jsonl`), body)
console.log(`${outName}.jsonl: ${out.length - 1} records, ${body.length} bytes`)
