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
 *   --user-delay-ms N     write a submitted prompt to the transcript N ms late (default 0)
 *   --name <text>         a session renamed with /rename: Claude Code writes the name into the input box's top rule
 *
 * Prompts:
 *   ASK       a permission question. The layout is copied from a real Claude Code 2.1.312 screen
 *             (fb-1029b evidence/permission-prompt-claude-2.1.312.txt): one rule on top, the command
 *             between dashed rules, "Do you want to proceed?", four options, "Esc to cancel · Tab to amend".
 *             Codex: its folder-trust dialog (the words CLI Manager already reads, TerminalMirror).
 *   QUESTION  an AskUserQuestion menu, copied from the real 2.1.312 screen (askuserquestion evidence):
 *             tab title, question, options with descriptions, "Type something.", a rule, "Chat about this".
 *   anything else: the turn works for --work-ms, then answers "Echo: <text>" with a small table.
 *   PLAN      a TodoWrite call (3 steps, 1 done, 1 in progress), then an answer.
 *   TABLE     answers with a five-column table wider than a phone (Korean cells).
 *   /model X  (Claude) records the command and "Set model to `X 5`", as Claude Code 2.1.3xx does; the next
 *             answers name that model. Bare `/model`, `/config`: a panel only the terminal shows (Esc closes it).
 *   anything else: the turn works for --work-ms, then answers "Echo: <text>" with a small table.
 * Arrows move the highlighted option; Enter picks it and prints `CHOSE: <label>` (or `CHOSE: custom <text>`).
 * Every submitted prompt prints `ANSWER[n]: <text>`. Enter while a turn works holds the text (`HELD: <text>`)
 * and submits it when the turn ends, as Claude Code queues it. Esc while a turn works stops it (`INTERRUPTED`),
 * recording "[Request interrupted by user]" as Claude Code does.
 * Answers record a model (`claude-opus-5-5`, effort `high`, usage) — Codex: a turn_context (gpt-6-luna,
 * medium) and a token_count with its window.
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
/** how long a submitted prompt takes to reach the transcript (Claude Code writes it at once; a slow disk does not) */
const USER_DELAY_MS = Number(arg('--user-delay-ms', '0'))
const NAME = arg('--name')
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
/** a panel only the terminal shows (bare /model, /config), closed by Esc */
let panel = null
/** text submitted while a turn works, sent when it ends */
const held = []
let workTimer = null
let workSpin = null
let claudeModel = 'claude-opus-5-5'
const CLAUDE_NAMES = { opus: ['Opus 5.5', 'claude-opus-5-5'], sonnet: ['Sonnet 5', 'claude-sonnet-5'], haiku: ['Haiku 4.5', 'claude-haiku-4-5'], default: ['Opus 5.5', 'claude-opus-5-5'] }

function record(entry) {
    if (!TRANSCRIPT) return
    fs.appendFileSync(TRANSCRIPT, JSON.stringify(entry) + '\n')
}
function now() {
    return new Date().toISOString()
}
let tokens = 12000
function usage() {
    tokens += 3500
    return { input_tokens: 4, cache_creation_input_tokens: 500, cache_read_input_tokens: tokens, output_tokens: 120 }
}
function claudeEntry(type, message, extra = {}) {
    const uuid = crypto.randomUUID()
    const entry = { type, message, uuid, parentUuid: lastUuid, timestamp: now(), sessionId: 'mock', cwd: '/masked', ...extra }
    lastUuid = uuid
    record(entry)
}
function recordUser(text) {
    if (USER_DELAY_MS > 0) return void setTimeout(() => writeUser(text), USER_DELAY_MS)
    writeUser(text)
}
function writeUser(text) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'user_message', message: text, kind: 'plain' } })
        record({ timestamp: now(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    } else {
        claudeEntry('user', { role: 'user', content: text })
    }
}
function recordAnswer(text) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'turn_context', payload: { cwd: '/masked', model: 'gpt-6-luna', effort: 'medium', summary: 'none' } })
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } })
        tokens += 3500
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: tokens }, model_context_window: 200000 } } })
        record({ timestamp: now(), type: 'event_msg', payload: { type: 'task_complete' } })
    } else {
        claudeEntry('assistant', { role: 'assistant', model: claudeModel, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usage() }, { effort: 'high' })
    }
}
function recordToolUse(id, command) {
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: command }), call_id: id } })
    } else {
        claudeEntry('assistant', { role: 'assistant', model: claudeModel, content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Create a probe file' } }], stop_reason: 'tool_use', usage: usage() }, { effort: 'high' })
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
/** the input box's top rule: `──── name ─` for a renamed session (Claude Code 2.1.318) */
function topRule() {
    if (!NAME) return rule()
    return '─'.repeat(Math.max(3, cols() - 2 - NAME.length - 3)) + ` ${NAME} ─`
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
    if (panel) return [rule(), ` ${panel}`, '', ' (mock panel — only the terminal shows it)', '', ' Esc to close']
    const status = busy ? [`${FRAMES[spinner % FRAMES.length]} Working… (${AGENT === 'codex' ? 'Esc' : 'esc'} to interrupt)`] : []
    if (AGENT === 'codex') return [...status, `› ${input}`, '  ? for shortcuts']
    return [...status, topRule(), `❯ ${input}`, rule(), '  ⏵⏵ accept edits on']
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

function endWork() {
    clearInterval(workSpin)
    clearTimeout(workTimer)
    workSpin = null
    workTimer = null
    busy = false
}

function answerTurn(text, answer = null) {
    busy = true
    draw()
    workSpin = setInterval(() => {
        spinner++
        draw()
    }, 100)
    workTimer = setTimeout(() => {
        endWork()
        const said = answer ?? `Echo: ${text}\n\n| key | value |\n| --- | --- |\n| length | ${text.length} |`
        recordAnswer(said)
        say(`⏺ ${said.split('\n')[0]}`)
        draw()
        // what was typed during the turn goes next
        if (held.length > 0) setTimeout(() => (submit(held.shift()), draw()), 50)
    }, WORK_MS)
}

function interrupt() {
    endWork()
    held.length = 0
    say('  ⎿  Interrupted · What should Claude do instead?')
    say('INTERRUPTED')
    if (AGENT === 'codex') record({ timestamp: now(), type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } })
    else claudeEntry('user', { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] })
    draw()
}

function recordPlan() {
    const todos = [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { content: 'Write the fix', status: 'in_progress', activeForm: 'Writing the fix' },
        { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' }
    ]
    if (AGENT === 'codex') {
        record({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: todos.map((t) => ({ step: t.content, status: t.status })) }), call_id: 'call_plan' } })
        record({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_plan', output: 'Plan updated' } })
    } else {
        claudeEntry('assistant', { role: 'assistant', model: claudeModel, content: [{ type: 'tool_use', id: 'toolu_plan', name: 'TodoWrite', input: { todos } }], stop_reason: 'tool_use', usage: usage() }, { effort: 'high' })
        claudeEntry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_plan', content: 'Todos have been modified successfully.' }] })
    }
}

/** Claude Code's record of a slash command and its answer. */
function recordCommand(name, args, stdout) {
    claudeEntry('user', { role: 'user', content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>` })
    claudeEntry('user', { role: 'user', content: `<local-command-stdout>${stdout}</local-command-stdout>` })
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
    const model = /^\/model(?:\s+(\S+))?\s*$/.exec(text)
    if (model || text.trim() === '/config') {
        if (model && model[1] && AGENT !== 'codex') {
            const [label, id] = CLAUDE_NAMES[model[1]] ?? [model[1], model[1]]
            claudeModel = id
            recordCommand('model', model[1], `Set model to \`${label}\``)
            say(`  ⎿  Set model to ${label}`)
            say(`MODEL: ${model[1]}`)
        } else {
            panel = model ? 'Select model (mock picker)' : 'Settings (mock /config panel)'
            say(`PANEL: ${text.trim()}`)
        }
        return
    }
    recordUser(text)
    if (text === 'ASK') openMenu(AGENT === 'codex' ? 'codex-trust' : 'permission')
    else if (text === 'QUESTION') openMenu('question')
    else if (text === 'PLAN') {
        recordPlan()
        answerTurn(text, 'Planned three steps.')
    } else if (text === 'TABLE') answerTurn(text, WIDE_TABLE)
    else answerTurn(text)
}

/** a report-style table wider than a phone, like the one in fb 2be8b580 (Korean words, long cells) */
const WIDE_TABLE = [
    'Here is the summary.',
    '',
    '| 대상 | 줄 | 화면 변화 | 확인한 것 | 남은 일 |',
    '| --- | --- | --- | --- | --- |',
    '| lightsoft | 11/6 월차 1 (입사 6개월) | 기본부여 5 → 6 | 운영 DB 조회만 했고 실제로 넣지는 않음 | 없음 |',
    '| 박원호 | 바뀐 입사일 2016-02-01 기준으로 다시 계산 | 없음 — 올해 숫자는 기초잔여로 대신함 | 이력에만 쌓임 | 다음 달 확인 |'
].join('\n')

let escape = ''
let escapeTimer = null
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
    if (panel) {
        if (key === '\x1b') {
            panel = null
            say('PANEL CLOSED')
        }
        return draw()
    }
    if (key === '\x1b') {
        if (busy) interrupt()
        return draw()
    }
    if (key === '\r') {
        if (input.length === 0) return draw()
        const text = input
        input = ''
        if (busy) {
            held.push(text)
            say(`HELD: ${text}`)
            return draw()
        }
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
            clearTimeout(escapeTimer)
            if (/^\x1b\[[0-9;]*[A-Za-z~]$/.test(escape) || (escape.length === 2 && escape[1] !== '[')) {
                const key = escape
                escape = ''
                handleKey(key)
            } else if (escape === '\x1b' && data.length === 0) {
                // a lone Esc: nothing follows it within a moment
                escapeTimer = setTimeout(() => {
                    if (escape === '\x1b') {
                        escape = ''
                        handleKey('\x1b')
                    }
                }, 40)
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
