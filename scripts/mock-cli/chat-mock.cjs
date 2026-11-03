#!/usr/bin/env node
/**
 * A pretend agent for the Chat view tests (T73). It draws a Claude Code (or
 * Codex) style screen AND writes the agent's transcript file the way the real
 * CLI does, so a test can check the whole loop: a message sent from the chat
 * reaches this terminal, the turn is recorded, the chat shows it.
 *
 *   --transcript <file>   jsonl to append (Claude: projects/<slug>/<id>.jsonl, Codex: rollout-…-<id>.jsonl)
 *   --agent claude|codex  record and screen format (default claude)
 *   --work-ms N           how long a turn "works" with the spinner (default 1200)
 *
 * Prompts:
 *   ASK       a permission question. The layout is copied from a real Claude Code 2.1.312 screen
 *             (fb-1029b evidence/permission-prompt-claude-2.1.312.txt): one rule on top, the command
 *             between dashed rules, "Do you want to proceed?", four options, "Esc to cancel · Tab to amend".
 *             Codex: its folder-trust dialog (the words CLI Manager already reads, TerminalMirror).
 *   QUESTION  an AskUserQuestion menu, copied from the real 2.1.312 screen (askuserquestion evidence):
 *             tab title, question, options with descriptions, "Type something.", a rule, "Chat about this".
 *   anything else: the turn works for --work-ms, then answers "Echo: <text>" with a small table.
 * Arrows move the highlighted option; Enter picks it and prints `CHOSE: <label>` (or `CHOSE: custom <text>`).
 * Every submitted prompt prints `ANSWER[n]: <text>`.
 */
const fs = require('fs')
const crypto = require('crypto')

const arg = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index > 0 ? process.argv[index + 1] : fallback
}
const TRANSCRIPT = arg('--transcript')
const AGENT = arg('--agent', 'claude')
const WORK_MS = Number(arg('--work-ms', '1200'))
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const FRAMES = ['✻', '✢', '✳', '∗']

const out = (text) => process.stdout.write(text)
const cols = () => Math.max(40, Math.min(process.stdout.columns || 100, 200))
const rows = () => Math.max(12, process.stdout.rows || 30)

let history = [] // lines above the input area
let input = ''
let inPaste = false
let pasteBuffer = ''
let submitted = 0
let busy = false
let spinner = 0
/** the open menu: { kind, options: [{label, description?, custom?}], selected, customText } */
let menu = null
let lastUuid = null

function record(entry) {
    if (!TRANSCRIPT) return
    fs.appendFileSync(TRANSCRIPT, JSON.stringify(entry) + '\n')
}
function now() {
    return new Date().toISOString()
}
function claudeEntry(type, message, extra = {}) {
    const uuid = crypto.randomUUID()
    const entry = { type, message, uuid, parentUuid: lastUuid, timestamp: now(), sessionId: 'mock', cwd: '/masked', ...extra }
    lastUuid = uuid
    record(entry)
}
function recordUser(text) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'user_message', message: text, kind: 'plain' } })
        record({ timestamp: now(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    } else {
        claudeEntry('user', { role: 'user', content: text })
    }
}
function recordAnswer(text) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } })
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'task_complete' } })
    } else {
        claudeEntry('assistant', { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' })
    }
}
function recordToolUse(id, command) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: command }), call_id: id } })
    } else {
        claudeEntry('assistant', { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Create a probe file' } }], stop_reason: 'tool_use' })
    }
}
function recordToolResult(id, output, isError) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } })
    } else {
        claudeEntry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] })
    }
}

function rule() {
    return '─'.repeat(cols() - 2)
}
function dashes() {
    return '╌'.repeat(cols() - 2)
}

function menuLines() {
    if (!menu) return []
    const lines = []
    if (menu.kind === 'permission') {
        lines.push(rule(), ' Bash command', ' Create a probe file', dashes(), ' touch /tmp/chat-mock-probe', dashes(), ' Do you want to proceed?')
        menu.options.forEach((option, index) => lines.push(`${index === menu.selected ? ' ❯' : '  '} ${index + 1}. ${option.label}`))
        lines.push('', ' Esc to cancel · Tab to amend')
    } else if (menu.kind === 'question') {
        lines.push(rule(), ' ☐ 색 선택 ', '', '어떤 색이 좋아?', '')
        menu.options.forEach((option, index) => {
            if (option.chat) lines.push(rule())
            const label = option.custom && menu.customText ? menu.customText : option.label
            lines.push(`${index === menu.selected ? '❯' : ' '} ${index + 1}. ${label}`)
            if (option.description) lines.push(`     ${option.description}`)
        })
        lines.push('', 'Enter to select · ↑/↓ to navigate · Esc to cancel')
    } else if (menu.kind === 'codex-trust') {
        lines.push('Do you trust the contents of this directory?')
        menu.options.forEach((option, index) => lines.push(`${index === menu.selected ? '›' : ' '} ${index + 1}. ${option.label}`))
        lines.push('Press enter to continue')
    }
    return lines
}

function boxLines() {
    if (menu) return menuLines()
    const status = busy ? [`${FRAMES[spinner % FRAMES.length]} Working… (${AGENT === 'codex' ? 'Esc' : 'esc'} to interrupt)`] : []
    if (AGENT === 'codex') return [...status, `› ${input}`, '  ? for shortcuts']
    return [...status, rule(), `❯ ${input}`, rule(), '  ⏵⏵ accept edits on']
}

function draw() {
    const bottom = boxLines()
    const room = Math.max(0, rows() - bottom.length - 1)
    const top = history.slice(-room)
    // Home + erase below: redraws in place without pushing the screen into scrollback.
    out('\x1b[H\x1b[J' + [...top, ...bottom].map((line) => line.slice(0, cols())).join('\r\n'))
}

function say(line) {
    for (const part of String(line).split('\n')) history.push(part)
}

function answerTurn(text) {
    busy = true
    draw()
    const timer = setInterval(() => {
        spinner++
        draw()
    }, 100)
    setTimeout(() => {
        clearInterval(timer)
        busy = false
        const answer = `Echo: ${text}\n\n| key | value |\n| --- | --- |\n| length | ${text.length} |`
        recordAnswer(answer)
        say(`⏺ Echo: ${text}`)
        draw()
    }, WORK_MS)
}

function openMenu(kind) {
    if (kind === 'permission') {
        menu = {
            kind,
            selected: 0,
            options: [
                { label: 'Yes' },
                { label: 'Yes, and always allow access to /tmp from this project' },
                { label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' },
                { label: 'No' }
            ]
        }
        recordToolUse('toolu_mock_1', 'touch /tmp/chat-mock-probe')
        say('⏺ Bash(touch /tmp/chat-mock-probe)')
        say('  ⎿  Waiting…')
    } else if (kind === 'question') {
        menu = {
            kind,
            selected: 0,
            customText: '',
            options: [
                { label: '빨강', description: '빨간색을 선택합니다' },
                { label: '파랑', description: '파란색을 선택합니다' },
                { label: 'Type something.', custom: true },
                { label: 'Chat about this', chat: true }
            ]
        }
    } else {
        menu = { kind: 'codex-trust', selected: 0, options: [{ label: 'Yes, continue' }, { label: 'No, quit' }] }
    }
    draw()
}

function choose() {
    const option = menu.options[menu.selected]
    const label = option.custom ? `custom ${menu.customText}` : option.label
    const kind = menu.kind
    menu = null
    say(`CHOSE: ${label}`)
    if (kind === 'permission') {
        const denied = label === 'No'
        recordToolResult('toolu_mock_1', denied ? "The user doesn't want to proceed with this tool use." : '', denied)
        recordAnswer(denied ? 'Understood — I did not run it.' : 'Created the probe file.')
    } else if (kind === 'question') {
        recordAnswer(`You picked ${label}.`)
    }
    draw()
}

function submit(text) {
    submitted++
    say(`> ${text}`)
    say(`ANSWER[${submitted}]: ${text.includes('\n') ? `lines=${text.split('\n').length}` : text}`)
    recordUser(text)
    if (text === 'ASK') openMenu(AGENT === 'codex' ? 'codex-trust' : 'permission')
    else if (text === 'QUESTION') openMenu('question')
    else answerTurn(text)
}

let escape = ''
function handleKey(key) {
    if (menu) {
        if (key === '\x1b[A') menu.selected = Math.max(0, menu.selected - 1)
        else if (key === '\x1b[B') menu.selected = Math.min(menu.options.length - 1, menu.selected + 1)
        else if (key === '\r') return choose()
        else if (menu.kind === 'question' && menu.options[menu.selected].custom) {
            if (key === '\x7f') menu.customText = menu.customText.slice(0, -1)
            else if (key >= ' ') menu.customText += key
        }
        return draw()
    }
    if (key === '\r') {
        if (input.length === 0 || busy) return draw()
        const text = input
        input = ''
        submit(text)
        return draw()
    }
    if (key === '\x7f') input = input.slice(0, -1)
    else if (key === '\x15') input = ''
    else if (key === '\x03') process.exit(0)
    else if (key >= ' ') input += key
    draw()
}

function feed(chunk) {
    let data = chunk
    while (data.length > 0) {
        if (inPaste) {
            const end = data.indexOf(PASTE_END)
            if (end < 0) {
                pasteBuffer += data
                return
            }
            pasteBuffer += data.slice(0, end)
            data = data.slice(end + PASTE_END.length)
            inPaste = false
            input += pasteBuffer
            pasteBuffer = ''
            draw()
            continue
        }
        if (data.startsWith(PASTE_START)) {
            inPaste = true
            data = data.slice(PASTE_START.length)
            continue
        }
        if (escape || data[0] === '\x1b') {
            escape += data[0]
            data = data.slice(1)
            if (/^\x1b\[[0-9;]*[A-Za-z~]$/.test(escape) || (escape.length === 2 && escape[1] !== '[')) {
                const key = escape
                escape = ''
                handleKey(key)
            }
            continue
        }
        handleKey(data[0])
        data = data.slice(1)
    }
}

process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
// Bracketed paste, as Claude Code and Codex ask for it.
out('\x1b[?2004h')
say(AGENT === 'codex' ? '>_ OpenAI Codex (mock)' : ' ▐▛███▜▌   Claude Code (mock)')
say('')
draw()
process.stdin.on('data', feed)
process.stdout.on('resize', draw)
