#!/usr/bin/env node
/**
 * Minimal interactive agent for the Control API tests (T15).
 *
 * Behaves like an agent TUI in the three ways the API depends on:
 *   - asks for bracketed paste, so multi-line prompts arrive as one paste
 *   - redraws a spinner line containing "esc to interrupt" while it "works"
 *   - "ASK" shows an approval question that waits for a key ("1" / Enter / "2")
 *
 * Every answer is printed as `ANSWER[n]: <prompt>` (or `lines=N` for a
 * multi-line prompt) so a test can check exactly what was submitted, and how
 * many times.
 *
 * Usage: node scripts/mock-cli/agent-mock.cjs [--work-ms 1500]
 */

const argIndex = process.argv.indexOf('--work-ms')
const WORK_MS = argIndex > 0 ? Number(process.argv[argIndex + 1]) : 1500
const SPINNER_FRAME_MS = 100
const FRAMES = ['✻', '✢', '✳', '∗']
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const QUESTION = 'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n'
const QUESTION_LINES = 3

let input = ''
let inPaste = false
let busy = false
let asking = false
let submitted = 0

const out = (text) => process.stdout.write(text)
const prompt = () => out('> ')

function submit() {
    const text = input
    input = ''
    submitted++
    out('\r\n')

    if (text.trim() === 'ASK') {
        asking = true
        out(QUESTION)
        return
    }

    busy = true
    const started = Date.now()
    let frame = 0
    const timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000)
        out(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} Working… (${seconds}s · esc to interrupt)`)
    }, SPINNER_FRAME_MS)

    setTimeout(() => {
        clearInterval(timer)
        const lines = text.split('\n')
        out(`\r\x1b[2KANSWER[${submitted}]: ${lines.length > 1 ? `lines=${lines.length}` : text}\r\n`)
        busy = false
        prompt()
    }, WORK_MS)
}

function handleChar(ch) {
    if (asking) {
        if (ch === '1' || ch === '\r' || ch === '2') {
            asking = false
            // Like a real agent TUI, the dialog is replaced by its outcome.
            out(`\x1b[${QUESTION_LINES}A\r\x1b[J`)
            out(ch === '2' ? 'DENIED\r\n' : 'APPROVED\r\n')
            prompt()
        }
        return
    }
    if (busy) return
    if (ch === '\x03') {
        out('\r\nBye!\r\n')
        process.exit(0)
    }
    if (inPaste) {
        const normalized = ch === '\r' ? '\n' : ch
        input += normalized
        out(normalized === '\n' ? '\r\n  ' : normalized)
        return
    }
    if (ch === '\r') return submit()
    if (ch === '\x7f') {
        input = input.slice(0, -1)
        out('\b \b')
        return
    }
    input += ch
    out(ch)
}

process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
    let rest = data
    while (rest.length > 0) {
        if (rest.startsWith(PASTE_START)) {
            inPaste = true
            rest = rest.slice(PASTE_START.length)
        } else if (rest.startsWith(PASTE_END)) {
            inPaste = false
            rest = rest.slice(PASTE_END.length)
        } else {
            handleChar(rest[0])
            rest = rest.slice(1)
        }
    }
})
process.stdin.resume()

out('\x1b[?2004h')
out('agent-mock ready\r\n')
prompt()
