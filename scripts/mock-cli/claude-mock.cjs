#!/usr/bin/env node
/**
 * Synthetic Claude Code-like TUI generator for terminal stress testing.
 *
 * Emulates the rendering pattern of Claude Code / Codex CLI:
 *  - Streams numbered "history" lines (assistant output) above a live UI box
 *  - Redraws the bottom UI box every frame using cursor-up + erase-below (CSI 0J)
 *  - Wraps frames in synchronized output mode (CSI ?2026h/l)
 *  - Optionally emits periodic full clears (CSI 2J) to emulate resize repaints
 *
 * History lines are numbered (HIST-000123) so tests can mechanically verify
 * scrollback continuity and eviction.
 *
 * Usage (inside any terminal):
 *   node scripts/mock-cli/claude-mock.cjs --duration 10 --fps 10 --hist 30
 *
 * Options:
 *   --duration <sec>      total run time (default 10)
 *   --fps <n>             UI box redraw rate (default 10)
 *   --box <lines>         UI box height in lines (default 8)
 *   --hist <lines/sec>    history line emission rate (default 20)
 *   --clear-every <n>     full clear (CSI 2J) every n frames, 0 = never (default 0)
 *   --quiet-end           leave cursor clean at the end (default true)
 */

const args = process.argv.slice(2)
function opt(name, def) {
    const i = args.indexOf(`--${name}`)
    if (i === -1) return def
    const v = args[i + 1]
    return v === undefined ? true : Number.isNaN(Number(v)) ? v : Number(v)
}

const DURATION_SEC = opt('duration', 10)
const FPS = opt('fps', 10)
const BOX_LINES = opt('box', 8)
const HIST_PER_SEC = opt('hist', 20)
const CLEAR_EVERY = opt('clear-every', 0)

const ESC = '\x1b'
const CSI = `${ESC}[`
const SYNC_BEGIN = `${CSI}?2026h`
const SYNC_END = `${CSI}?2026l`
const HIDE_CURSOR = `${CSI}?25l`
const SHOW_CURSOR = `${CSI}?25h`
const ERASE_BELOW = `${CSI}0J`
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const LOREM = 'the quick brown fox jumps over the lazy dog while reviewing terminal scrollback behavior'

let histCounter = 0
let frameCounter = 0
let boxDrawn = false
const startTime = Date.now()

function historyLine() {
    histCounter++
    const id = String(histCounter).padStart(6, '0')
    return `HIST-${id} ${LOREM.slice(0, 40 + (histCounter % 40))}`
}

function buildBox() {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const spin = SPINNER[frameCounter % SPINNER.length]
    const lines = []
    lines.push(`╭${'─'.repeat(70)}╮`)
    lines.push(`│ ${spin} Thinking… (${elapsed}s · ${histCounter * 12} tokens · esc to interrupt)`.padEnd(71) + '│')
    for (let i = 0; i < BOX_LINES - 4; i++) {
        lines.push(`│   frame ${String(frameCounter).padStart(6)} line ${i} ${'▮'.repeat(frameCounter % 20)}`.padEnd(71) + '│')
    }
    lines.push(`╰${'─'.repeat(70)}╯`)
    lines.push(`  mock-claude · ? for shortcuts`)
    return lines
}

// Exact height of the previously drawn box — cursor-up must match precisely,
// or each frame would erase history lines above the box.
let lastBoxHeight = 0

function renderFrame(pendingHistory) {
    let out = SYNC_BEGIN
    if (boxDrawn) {
        // Move to the first line of the previously drawn box and erase it
        out += `${CSI}${lastBoxHeight}A\r${ERASE_BELOW}`
    }
    for (const h of pendingHistory) {
        out += h + '\n'
    }
    const box = buildBox()
    out += box.join('\n') + '\n'
    out += SYNC_END
    boxDrawn = true
    lastBoxHeight = box.length
    return out
}

function fullClearRepaint() {
    // Emulates the full repaint CLIs do on resize: clear screen + redraw
    let out = SYNC_BEGIN + `${CSI}2J${CSI}H`
    // Repaint a window of recent history (like a TUI restoring its viewport)
    const repaint = []
    for (let i = Math.max(1, histCounter - 10); i <= histCounter; i++) {
        const id = String(i).padStart(6, '0')
        repaint.push(`HIST-${id} ${LOREM.slice(0, 40 + (i % 40))}`)
    }
    out += repaint.join('\n') + '\n'
    const box = buildBox()
    out += box.join('\n') + '\n'
    out += SYNC_END
    boxDrawn = true
    lastBoxHeight = box.length
    return out
}

process.stdout.write(HIDE_CURSOR)
process.stdout.write(`mock-claude starting (duration=${DURATION_SEC}s fps=${FPS} box=${BOX_LINES} hist=${HIST_PER_SEC}/s clearEvery=${CLEAR_EVERY})\n`)

const frameIntervalMs = 1000 / FPS
let histAccumulator = 0

const timer = setInterval(() => {
    frameCounter++
    histAccumulator += HIST_PER_SEC / FPS
    const pending = []
    while (histAccumulator >= 1) {
        pending.push(historyLine())
        histAccumulator -= 1
    }

    if (CLEAR_EVERY > 0 && frameCounter % CLEAR_EVERY === 0) {
        process.stdout.write(fullClearRepaint())
    } else {
        process.stdout.write(renderFrame(pending))
    }

    if (Date.now() - startTime >= DURATION_SEC * 1000) {
        clearInterval(timer)
        process.stdout.write(SHOW_CURSOR)
        process.stdout.write(`\nmock-claude done: frames=${frameCounter} histLines=${histCounter} LAST-HIST=${histCounter}\n`)
        process.exit(0)
    }
}, frameIntervalMs)

process.on('SIGINT', () => {
    clearInterval(timer)
    process.stdout.write(SHOW_CURSOR + '\nmock-claude interrupted\n')
    process.exit(0)
})
