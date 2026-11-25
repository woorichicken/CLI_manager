#!/usr/bin/env node
/**
 * A pretend Antigravity CLI (`agy`) for the Chat view tests (T168). It draws agy 1.5.16's screen —
 * the layout copied from a real session recorded 2026-11-25 (tests/terminal/fixtures/agy) — and
 * keeps agy's records the way the real CLI does, under ANTIGRAVITY_APP_DATA_DIR:
 *
 *   presence/<id>.lock                                      held open while it runs (AgySessionSync reads it with lsof)
 *   brain/<id>/.system_generated/logs/transcript_full.jsonl  one JSON line per step
 *
 * Run it as a program named `agy` (a one-line launcher `require`s this file), so `ps` shows `node …/agy`.
 *
 *   --conversation <id> | --conversation=<id> | -r <id>   resume that conversation (its lock is taken at once)
 *   AGY_MOCK_ID        the id a new conversation gets (default: random); its lock is taken with the first prompt
 *   AGY_MOCK_WORK_MS   how long a turn works with the spinner (default 1500)
 *
 * Prompts: anything → `ANSWER[n]: <prompt>` · ASK → agy's question dialog (↑/↓, Enter prints `CHOSE: <label>`).
 * Esc while a turn works cancels it (`Cancelled.`). The first line printed is `ARGS: <arguments>`.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const args = process.argv.slice(2)
const dataDir = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(require('os').homedir(), '.gemini', 'antigravity-cli')
const WORK_MS = Number(process.env.AGY_MOCK_WORK_MS) || 1500
let id = null
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--conversation' || args[i] === '-r' || args[i] === '--resume') id = args[i + 1]
    else if (/^--(?:conversation|resume)=/.test(args[i])) id = args[i].split('=')[1]
}
const resumed = id !== null
id = id || process.env.AGY_MOCK_ID || crypto.randomUUID()

const cols = () => process.stdout.columns || 100
const rule = () => '─'.repeat(cols())
const lines = []
let box = ''
let working = false
let workTimer = null
let question = null
let lockFd = null
let answers = 0
const ledgerPath = path.join(dataDir, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl')
let step = 0
if (fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
        try {
            const value = JSON.parse(line)
            step = Math.max(step, value.step_index + 1)
            if (value.type === 'PLANNER_RESPONSE') answers++
        } catch {
            // a blank or cut line
        }
    }
}

function takeLock() {
    if (lockFd !== null) return
    fs.mkdirSync(path.join(dataDir, 'presence'), { recursive: true })
    lockFd = fs.openSync(path.join(dataDir, 'presence', `${id}.lock`), 'w')
}

function record(type, content, extra = {}) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    fs.appendFileSync(ledgerPath, JSON.stringify({ step_index: step++, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status: 'DONE', created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ...extra, content }) + '\n')
}

function footer() {
    if (question) return ['  ↑/↓ Navigate · enter Select · esc Skip', 'esc to cancel']
    return [working ? 'esc to cancel' : '? for shortcuts']
}

function draw() {
    const out = ['\x1b[H\x1b[2J', '  Antigravity CLI (mock)', '']
    for (const line of lines.slice(-12)) out.push(line)
    if (question) {
        out.push('', 'Question', rule(), '', `Question 1/1: ${question.text}`, '')
        question.options.forEach((option, index) => out.push(`${index === question.at ? '>' : ' '} ${index + 1}. ${option}`))
        out.push('')
    } else {
        if (working) out.push('⡿  Generating...')
        // agy's empty box shows a grey hint (SGR 90, not dim — recorded 2026-11-25)
        out.push(rule(), box ? `> ${box}` : '> \x1b[90mAuto mode: edits & safe commands auto-approved (shift+tab to cycle)\x1b[m', rule())
    }
    out.push(...footer())
    process.stdout.write(out.join('\r\n'))
}

function finish(text) {
    working = false
    workTimer = null
    answers++
    const answer = `ANSWER[${answers}]: ${text}`
    record('PLANNER_RESPONSE', answer, { model: 'gemini-3.8-flash-low', input_tokens: 10, output_tokens: 3 })
    lines.push('', `  ${answer}`, '')
    draw()
}

function submit(text) {
    takeLock()
    record('USER_INPUT', `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmock\n</ADDITIONAL_METADATA>`)
    lines.push(`> ${text}`)
    if (text.trim() === 'ASK') {
        question = { text: 'Which color do you like?', options: ['(Recommended) red', 'green', 'blue', 'Write-in...'], at: 0 }
        draw()
        return
    }
    working = true
    draw()
    workTimer = setTimeout(() => finish(text), WORK_MS)
}

process.stdout.write(`ARGS: ${args.join(' ')}\r\n`)
if (resumed) takeLock()
setTimeout(draw, 100)
process.stdout.on('resize', draw)
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (data) => {
    const text = data.toString('utf8')
    if (question) {
        if (text === '\x1b[B') question.at = Math.min(question.at + 1, question.options.length - 1)
        else if (text === '\x1b[A') question.at = Math.max(question.at - 1, 0)
        else if (text === '\r') {
            const chosen = question.options[question.at]
            question = null
            record('GENERIC', `A1: ${chosen}`)
            lines.push(`  CHOSE: ${chosen}`)
        } else if (text === '\x1b') {
            question = null
            lines.push('  CHOSE: skip')
        }
        draw()
        return
    }
    if (text === '\x03') {
        process.stdout.write(`\r\n\r\nResume with -c (or command below):\r\nagy --conversation=${id}\r\n`)
        process.exit(0)
    }
    if (working) {
        if (text === '\x1b') {
            clearTimeout(workTimer)
            working = false
            lines.push('  Cancelled.')
            draw()
        }
        return
    }
    for (const char of text) {
        if (char === '\r') {
            const sent = box
            box = ''
            if (sent.trim()) submit(sent)
            else draw()
        } else if (char === '\x7f') {
            box = box.slice(0, -1)
            draw()
        } else if (char === '\x15' || char === '\x0b') {
            box = ''
            draw()
        } else if (char >= ' ') {
            box += char
            draw()
        }
    }
})
