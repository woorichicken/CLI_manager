#!/usr/bin/env node
/**
 * Analyzes a JSONL recording: counts ANSI escape sequences relevant to
 * scrollback pollution and viewport behavior.
 *
 * Used to validate hypotheses about how Claude Code / Codex actually render
 * (e.g. how often they emit erase-in-display, whether they use the alternate
 * screen, synchronized output, etc.) and to calibrate claude-mock.cjs.
 *
 * Usage:
 *   node scripts/mock-cli/analyze-recording.cjs <file.jsonl>
 */

const fs = require('fs')

const file = process.argv[2]
if (!file) {
    console.error('usage: node analyze-recording.cjs <file.jsonl>')
    process.exit(1)
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
let stream = ''
let totalBytes = 0
let chunkCount = 0
let durationMs = 0
let meta = null

for (const line of lines) {
    const obj = JSON.parse(line)
    if (obj.meta) { meta = obj; continue }
    const data = Buffer.from(obj.b, 'base64').toString('utf8')
    stream += data
    totalBytes += data.length
    chunkCount++
    durationMs = obj.t
}

const patterns = {
    'ED0 erase below (CSI 0J / CSI J)': /\x1b\[0?J/g,
    'ED1 erase above (CSI 1J)': /\x1b\[1J/g,
    'ED2 erase display (CSI 2J)': /\x1b\[2J/g,
    'ED3 erase scrollback (CSI 3J)': /\x1b\[3J/g,
    'EL erase line (CSI K variants)': /\x1b\[[012]?K/g,
    'CUP cursor position (CSI H/f)': /\x1b\[[0-9;]*[Hf]/g,
    'CUU cursor up (CSI A)': /\x1b\[[0-9]*A/g,
    'CUD cursor down (CSI B)': /\x1b\[[0-9]*B/g,
    'SU scroll up (CSI S)': /\x1b\[[0-9]*S/g,
    'SD scroll down (CSI T)': /\x1b\[[0-9]*T/g,
    'IL insert lines (CSI L)': /\x1b\[[0-9]*L/g,
    'DL delete lines (CSI M)': /\x1b\[[0-9]*M/g,
    'DECSTBM scroll region (CSI r)': /\x1b\[[0-9;]*r/g,
    'Sync output begin (?2026h)': /\x1b\[\?2026h/g,
    'Sync output end (?2026l)': /\x1b\[\?2026l/g,
    'Alt screen enter (?1049h)': /\x1b\[\?1049h/g,
    'Alt screen leave (?1049l)': /\x1b\[\?1049l/g,
    'Cursor hide (?25l)': /\x1b\[\?25l/g,
    'Cursor show (?25h)': /\x1b\[\?25h/g
}

console.log(`file: ${file}`)
if (meta) console.log(`meta: cmd=${meta.cmd} size=${meta.cols}x${meta.rows} started=${meta.startedAt}`)
console.log(`chunks=${chunkCount} bytes=${totalBytes} duration=${(durationMs / 1000).toFixed(1)}s`)
console.log(`newlines=${(stream.match(/\n/g) || []).length}`)
console.log('--- escape sequence counts ---')
for (const [name, regex] of Object.entries(patterns)) {
    const count = (stream.match(regex) || []).length
    if (count > 0) console.log(`${String(count).padStart(7)}  ${name}`)
}
