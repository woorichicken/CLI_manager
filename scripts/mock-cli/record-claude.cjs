#!/usr/bin/env node
/**
 * Records a real CLI TUI session (claude / codex) into a JSONL file.
 *
 * Spawns the CLI in a real pty, drives it with scripted prompts, and records
 * every output chunk with timing so it can be replayed deterministically
 * (see replay.cjs) without spending tokens again.
 *
 * node-pty here is built for Electron's ABI, so run via:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/mock-cli/record-claude.cjs \
 *     --out scripts/mock-cli/recordings/claude.jsonl
 *
 * Options:
 *   --cmd <cli>        command to record (default: claude)
 *   --out <file>       output JSONL path (default: scripts/mock-cli/recordings/<cmd>-<ts>.jsonl)
 *   --prompt <text>    first prompt (default: cheap short prompt)
 *   --prompt2 <text>   optional second prompt
 *   --cols / --rows    pty size (default 100x30)
 *   --idle <sec>       idle seconds to consider a turn finished (default 6)
 *   --timeout <sec>    hard kill timeout (default 240)
 *
 * JSONL format: first line = meta, then { t: <ms since start>, b: <base64 chunk> }
 */

const fs = require('fs')
const path = require('path')
const pty = require(path.join(__dirname, '../../node_modules/node-pty'))

const args = process.argv.slice(2)
function opt(name, def) {
    const i = args.indexOf(`--${name}`)
    if (i === -1) return def
    const v = args[i + 1]
    return v === undefined ? true : v
}

const CMD = opt('cmd', 'claude')
const COLS = Number(opt('cols', 100))
const ROWS = Number(opt('rows', 30))
const IDLE_SEC = Number(opt('idle', 6))
const TIMEOUT_SEC = Number(opt('timeout', 240))
const PROMPT = opt('prompt', 'Reply with exactly a numbered list of 5 fruits, one per line. Do not use any tools.')
const PROMPT2 = opt('prompt2', 'Now reply with a numbered list of 3 vegetables. Do not use any tools.')
const OUT = opt('out', path.join(__dirname, 'recordings', `${CMD}-${Date.now()}.jsonl`))

fs.mkdirSync(path.dirname(OUT), { recursive: true })
const outStream = fs.createWriteStream(OUT)

const startTime = Date.now()
outStream.write(JSON.stringify({ meta: true, cmd: CMD, cols: COLS, rows: ROWS, startedAt: new Date().toISOString() }) + '\n')

console.log(`[record] spawning '${CMD}' (${COLS}x${ROWS}) → ${OUT}`)

const child = pty.spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', CMD], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: process.env.HOME,
    encoding: 'utf8',
    env: { ...process.env }
})

let totalBytes = 0
let chunkCount = 0
let lastDataTime = Date.now()

child.onData((data) => {
    lastDataTime = Date.now()
    totalBytes += Buffer.byteLength(data)
    chunkCount++
    outStream.write(JSON.stringify({ t: Date.now() - startTime, b: Buffer.from(data).toString('base64') }) + '\n')
})

// State machine: wait-ready → prompt1 → wait-idle → prompt2 → wait-idle → exit
const steps = []
steps.push({ desc: 'send prompt 1', text: PROMPT })
if (PROMPT2) steps.push({ desc: 'send prompt 2', text: PROMPT2 })
if (args.includes('--resize-test')) {
    // Capture what the CLI emits on SIGWINCH — the repaint pattern is the
    // suspected source of scrollback pollution in the app
    steps.push({ desc: 'resize 100x30 → 84x24', resize: [84, 24] })
    steps.push({ desc: 'resize 84x24 → 110x34', resize: [110, 34] })
    steps.push({ desc: 'resize 110x34 → 100x30', resize: [100, 30] })
}
// Double Ctrl+C exits Claude Code reliably (slash commands open autocomplete menus)
steps.push({ desc: 'exit CLI (double ctrl+c)', raw: '\x03', rawAgain: '\x03' })

let stepIndex = -1 // -1 = waiting for initial ready
let finished = false

function typeSlowly(text, done) {
    // Type in small bursts to look like a human and avoid paste-mode handling
    let i = 0
    const iv = setInterval(() => {
        child.write(text.slice(i, i + 8))
        i += 8
        if (i >= text.length) {
            clearInterval(iv)
            done()
        }
    }, 30)
}

function runStep(step, onDone) {
    if (step.resize) {
        const [cols, rows] = step.resize
        outStream.write(JSON.stringify({ event: 'resize', t: Date.now() - startTime, cols, rows }) + '\n')
        child.resize(cols, rows)
        onDone()
        return
    }
    if (step.raw) {
        child.write(step.raw)
        if (step.rawAgain) {
            setTimeout(() => { child.write(step.rawAgain); onDone() }, 300)
        } else {
            onDone()
        }
        return
    }
    typeSlowly(step.text, () => {
        // Enter must arrive as a distinct keypress after a pause — if it rides
        // in the same burst as the text, the CLI treats it as a pasted newline
        // and the prompt never submits.
        setTimeout(() => {
            child.write('\r')
            // Second Enter after a beat: if the first one was swallowed as a
            // pasted newline, this one submits. On empty input it is a no-op.
            setTimeout(() => { child.write('\r'); onDone() }, 1200)
        }, 600)
    })
}

const ticker = setInterval(() => {
    const idleMs = Date.now() - lastDataTime
    const elapsed = (Date.now() - startTime) / 1000

    if (elapsed > TIMEOUT_SEC) {
        console.log('[record] hard timeout, killing')
        finish(1)
        return
    }

    // Initial ready: CLI splash settled (idle 3s and we got some output)
    const requiredIdle = stepIndex === -1 ? 3000 : IDLE_SEC * 1000
    if (chunkCount > 0 && idleMs >= requiredIdle) {
        stepIndex++
        if (stepIndex >= steps.length) {
            // Exit already requested but pty did not die — force finish
            console.log('[record] CLI did not exit after final step, forcing finish')
            finish(0)
            return
        }
        const step = steps[stepIndex]
        console.log(`[record] ${step.desc} (t=${elapsed.toFixed(1)}s, chunks=${chunkCount})`)
        lastDataTime = Date.now() // reset idle clock while typing
        runStep(step, () => { lastDataTime = Date.now() })
    }
}, 500)

function finish(code) {
    if (finished) return
    finished = true
    clearInterval(ticker)
    try { child.kill() } catch { /* already dead */ }
    outStream.end(() => {
        console.log(`[record] saved: ${OUT}`)
        console.log(`[record] chunks=${chunkCount} bytes=${totalBytes} duration=${((Date.now() - startTime) / 1000).toFixed(1)}s`)
        process.exit(code)
    })
}

child.onExit(({ exitCode }) => {
    console.log(`[record] CLI exited with code ${exitCode}`)
    finish(0)
})
