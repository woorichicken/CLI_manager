#!/usr/bin/env node
/**
 * A pretend OpenCode (`opencode`) for the Chat view tests (T195). It draws opencode 1.18.15's screen — the
 * layout copied from a real session recorded 2026-11-27 (tests/terminal/fixtures/opencode) — and keeps
 * OpenCode 1.x's records the way the real one does: `session` · `message` · `part` rows in a SQLite store
 * (`$XDG_DATA_HOME/opencode/opencode.db`, held open while it runs), and the terminal title `OC | <title>`
 * once a session has one.
 *
 * Run it as a program named `opencode` (a one-line launcher `require`s this file) with a Node that has
 * node:sqlite (22.5+).
 *
 *   --session <id> | -s <id> | --session=<id>   open that session (it must be in the store)
 *   OPENCODE_MOCK_ID        the id a new session gets (default: random); written with the first prompt
 *   OPENCODE_MOCK_WORK_MS   how long a turn works with the progress bar (default 1500)
 *
 * Prompts: anything → `ANSWER[n]: <prompt>` · ASK → its question panel (Enter prints `CHOSE: <label>`).
 * While a turn works the first Esc shows `esc again to interrupt`, the second interrupts (`interrupted`).
 * The first line printed is `ARGS: <arguments>`.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
// node:sqlite prints an ExperimentalWarning on load: it would land on the screen the tests read
process.removeAllListeners('warning')
const { DatabaseSync } = require('node:sqlite')

const args = process.argv.slice(2)
const WORK_MS = Number(process.env.OPENCODE_MOCK_WORK_MS) || 1500
// Enters swallowed while text is in the composer (a redraw eating the key): the text stays there
let loseEnters = Number(process.env.OPENCODE_MOCK_LOSE_ENTERS) || 0
let sessionId = null
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session' || args[i] === '-s') sessionId = args[i + 1]
    else if (/^--session=/.test(args[i])) sessionId = args[i].split('=')[1]
}
const dataDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode')
fs.mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(path.join(dataDir, 'opencode.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, revert text, model text, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`)
let title = null
if (sessionId) {
    const row = db.prepare('SELECT title FROM session WHERE id = ?').get(sessionId)
    title = row ? row.title : null
}

const cols = () => process.stdout.columns || 110
const MUTED = '\x1b[38;5;8m'
const RESET = '\x1b[m'
const lines = []
let box = ''
let working = false
let escOnce = false
let workTimer = null
let question = null
let answers = (sessionId ? db.prepare("SELECT count(*) AS n FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'").get(sessionId).n : 0)
let clock = Date.now()
const now = () => (clock = Math.max(clock + 1, Date.now()))
const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`

function setTitle() {
    process.stdout.write(`\x1b]0;${title ? `OC | ${title.length > 40 ? `${title.slice(0, 37)}…` : title}` : 'OpenCode'}\x07`)
}

function message(role, data) {
    const at = now()
    const mid = id('msg')
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(mid, sessionId, at, at, JSON.stringify({ role, time: { created: at, ...(role === 'assistant' ? { completed: at } : {}) }, ...data }))
    db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(at, sessionId)
    return mid
}

function part(messageId, data) {
    const at = now()
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(id('prt'), messageId, sessionId, at, at, JSON.stringify(data))
}

function draw() {
    const width = cols()
    const out = ['\x1b[H\x1b[2J', '  OpenCode (mock)', '']
    for (const line of lines.slice(-14)) out.push(line)
    if (question) {
        out.push('', `  ┃  ${question.text}`, '  ┃')
        question.options.forEach((option, index) => out.push(`  ┃  ${index === question.at ? '>' : ' '}${index + 1}. ${option}`))
        out.push('  ┃', '  ┃  ↑↓ select  enter submit  esc dismiss', '  ┃')
    } else {
        // a blank row above the composer, as the real screen has (fixtures/opencode): the last message's `┃` block
        // does not run into the composer's
        out.push('', '  ┃', box ? `  ┃  ${box}` : `  ┃  ${MUTED}Ask anything... "Fix broken tests"${RESET}`, '  ┃', `  ┃  Build ${MUTED}·${RESET} Mock Model ${MUTED}OpenCode${RESET}`, `  ╹${'▀'.repeat(Math.max(10, width - 6))}`)
        out.push(working ? `   ⬝■■■■■■⬝  ${escOnce ? 'esc again to interrupt' : 'esc interrupt'}     tab agents  ctrl+p commands` : `   ${process.cwd()}     ctrl+p commands`)
    }
    process.stdout.write(out.join('\r\n'))
}

function finish(text) {
    working = false
    escOnce = false
    workTimer = null
    answers++
    const answer = `ANSWER[${answers}]: ${text}`
    const step = message('assistant', { modelID: 'mock-model', providerID: 'mock', finish: 'stop', tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } })
    part(step, { type: 'step-start' })
    part(step, { type: 'text', text: answer })
    part(step, { type: 'step-finish', reason: 'stop' })
    lines.push('', `     ${answer}`, '     ▣  Build · Mock Model · 1.5s')
    if (!title) {
        title = `Mock: ${text}`.slice(0, 60)
        db.prepare('UPDATE session SET title = ? WHERE id = ?').run(title, sessionId)
        setTitle()
    }
    draw()
}

function submit(text) {
    if (!sessionId) {
        sessionId = process.env.OPENCODE_MOCK_ID || `ses_${crypto.randomBytes(12).toString('hex')}`
        const at = now()
        db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'mock', ?, ?, '1.18.15', ?, ?)").run(sessionId, fs.realpathSync(process.cwd()), `New session - ${new Date(at).toISOString()}`, at, at)
    }
    const prompt = message('user', { agent: 'build', model: { providerID: 'mock', modelID: 'mock-model' } })
    part(prompt, { type: 'text', text })
    lines.push('  ┃', `  ┃  ${text}`, '  ┃')
    if (text.trim() === 'ASK') {
        question = { text: 'Which colour do you prefer?', options: ['Red', 'Blue', 'Type your own answer'], at: 0 }
        draw()
        return
    }
    working = true
    draw()
    workTimer = setTimeout(() => finish(text), WORK_MS)
}

process.stdout.write(`ARGS: ${args.join(' ')}\r\n`)
setTitle()
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
            lines.push(`     CHOSE: ${chosen}`)
        } else if (text === '\x1b') {
            question = null
            lines.push('     CHOSE: dismiss')
        }
        draw()
        return
    }
    if (text === '\x03') {
        process.stdout.write('\r\n')
        process.exit(0)
    }
    if (working) {
        if (text === '\x1b') {
            if (!escOnce) {
                escOnce = true
            } else {
                clearTimeout(workTimer)
                working = false
                escOnce = false
                const step = message('assistant', { modelID: 'mock-model', providerID: 'mock', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } })
                part(step, { type: 'step-start' })
                lines.push('     ▣  Build · Mock Model · interrupted')
            }
            draw()
        }
        return
    }
    for (const char of text) {
        if (char === '\r') {
            if (box.trim() && loseEnters > 0) {
                loseEnters--
                continue
            }
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
