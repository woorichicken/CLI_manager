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
 * Options that reproduce what real agents do to the API:
 *   --box            draw a Claude Code style input box (two rules around "❯ input"),
 *                    with a dim next-prompt suggestion after each answer
 *   --drop-enters N  ignore the first N Enters on a non-empty box (a CLI under heavy load)
 *   --codex-trust    start with Codex's "Do you trust the contents of this directory?" dialog
 *   --claude-trust   start with Claude Code's folder-trust dialog: unnumbered options, cursor on
 *                    "No, exit" (arrows move it), Enter on "No" prints EXITED and quits —
 *                    the way the real one behaves (checked against Claude Code 2.1.286)
 * Always: ESC followed by a character within 500ms is read as Alt+character and
 * dropped, the way terminal programs parse it.
 *
 * Usage: node scripts/mock-cli/agent-mock.cjs [--work-ms 1500] [--box] [--drop-enters N] [--codex-trust]
 */

const argValue = (name) => {
    const index = process.argv.indexOf(name)
    return index > 0 ? process.argv[index + 1] : undefined
}
const WORK_MS = Number(argValue('--work-ms') ?? 1500)
const BOX = process.argv.includes('--box')
let enterDropsLeft = Number(argValue('--drop-enters') ?? 0)
const CODEX_TRUST = process.argv.includes('--codex-trust')
const CLAUDE_TRUST = process.argv.includes('--claude-trust')
const META_WINDOW_MS = 500
const RULE = '─'.repeat(30)
const SUGGESTION = 'run the tests next'
const TRUST_DIALOG =
    'Do you trust the contents of this directory?\r\n› 1. Yes, continue\r\n  2. No, quit\r\nPress enter to continue\r\n'
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
let trusting = CODEX_TRUST
let claudeTrusting = CLAUDE_TRUST
let claudeTrustChoice = 0  // 0 = "No, exit" (where Claude Code puts the cursor), 1 = "Yes"
let escapeAt = 0
let inCsi = false
let boxDrawn = false
let showSuggestion = false

const out = (text) => process.stdout.write(text)

// --box: the box is always the last three rows, and the cursor sits on its bottom rule.
function clearBox() {
    if (boxDrawn) out('\x1b[2A\r\x1b[J')
    boxDrawn = false
}
function drawBox() {
    clearBox()
    const content = input || !showSuggestion ? input : `\x1b[2m${SUGGESTION}\x1b[22m`
    out(`${RULE}\r\n❯ ${content}\r\n${RULE}`)
    boxDrawn = true
}
const prompt = () => (BOX ? drawBox() : out('> '))

function submit() {
    const text = input
    input = ''
    submitted++
    if (BOX) {
        clearBox()
        showSuggestion = false
        // Like Claude Code, the submitted prompt stays in the transcript above the box.
        out(`> ${text}\r\n`)
    } else {
        out('\r\n')
    }

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
        showSuggestion = true
        prompt()
    }, WORK_MS)
}

const CLAUDE_TRUST_LINES = 4
function drawClaudeTrust(redraw) {
    if (redraw) out(`\x1b[${CLAUDE_TRUST_LINES}A\r\x1b[J`)
    out(' Quick safety check: Is this a project you created or one you trust?\r\n')
    out(`${claudeTrustChoice === 0 ? ' ❯' : '  '} No, exit\r\n`)
    out(`${claudeTrustChoice === 1 ? ' ❯' : '  '} Yes, I trust this folder\r\n`)
    out(' Enter to confirm · Esc to cancel\r\n')
}

function handleChar(ch) {
    // Terminal key parsing: ESC then a character soon after is Alt+character.
    if (inCsi) {
        if (/[A-Za-z~]/.test(ch)) {
            inCsi = false
            if (claudeTrusting && (ch === 'A' || ch === 'B')) {
                claudeTrustChoice = ch === 'B' ? 1 : 0
                drawClaudeTrust(true)
            }
        }
        return
    }
    if (ch === '\x1b') {
        escapeAt = Date.now()
        return
    }
    if (escapeAt) {
        const meta = Date.now() - escapeAt < META_WINDOW_MS
        escapeAt = 0
        if (meta && ch === '[') {
            inCsi = true
            return
        }
        if (meta) return
    }

    if (claudeTrusting) {
        if (ch === '\r') {
            claudeTrusting = false
            out(`\x1b[${CLAUDE_TRUST_LINES}A\r\x1b[J`)
            if (claudeTrustChoice === 0) {
                out('EXITED\r\n')
                process.exit(0)
            }
            out('TRUSTED\r\n')
            prompt()
        }
        return
    }
    if (trusting) {
        if (ch === '1' || ch === '\r') {
            trusting = false
            out('\x1b[4A\r\x1b[J')
            out('TRUSTED\r\n')
            prompt()
        }
        return
    }
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
    if (BOX) {
        if (ch === '\r') {
            if (!input) return
            if (enterDropsLeft > 0) {
                enterDropsLeft--
                return
            }
            return submit()
        }
        input = ch === '\x7f' ? input.slice(0, -1) : input + ch
        drawBox()
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
if (trusting) out(TRUST_DIALOG)
else if (claudeTrusting) drawClaudeTrust(false)
else prompt()
