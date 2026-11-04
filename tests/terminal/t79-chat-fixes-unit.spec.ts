import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ConversationTurn } from '../../src/shared/conversation'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { readPrompt } from '../../src/main/promptScreen'
import { agentTaskResult } from '../../src/main/transcript/records'
import { taskNotification } from '../../src/main/transcript/subagents'

/**
 * T79 — Chat fixes from the 11-03 cross review (codex-xreview F03 · F04 · F09 · F10 · F11 · F12 · F18)
 * and the ovis comparison (가1 · 다1), without Electron. Each block was written against the code
 * before its fix and failed there first.
 */

/** Claude Code writes a subagent's `<task-notification>` XML-escaped (seen in real transcripts). */
function escapedNotification(summary: string, result: string): string {
    const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return [
        '<task-notification>',
        '<task-id>a1b2c3d4e5</task-id>',
        '<tool-use-id>toolu_01ABC</tool-use-id>',
        '<status>completed</status>',
        `<summary>${escape(summary)}</summary>`,
        `<result>${escape(result)}</result>`,
        '</task-notification>'
    ].join('\n')
}

test.describe('T79 subagent cards decode the XML entities of the notification (ovis 가1 · 다1)', () => {
    const title = 'Survey programs & keywords <draft>'
    const summary = `Agent "${title}" completed`
    const result = 'Tracker & Newbie > Share & Earn — a <b> tag stays text, &amp; stays as typed'

    test('가1: the card title has the summary’s own characters', () => {
        const notice = taskNotification(escapedNotification(summary, result))!
        expect(notice).not.toBeNull()
        expect(notice.agent).toBe(true)
        expect(agentTaskResult(notice, undefined).title).toBe(title)
    })

    test('다1: the result body has the subagent’s own characters', () => {
        const notice = taskNotification(escapedNotification(summary, result))!
        expect(agentTaskResult(notice, undefined).result).toBe(result)
    })
})

// ---- ConversationService with a fake terminal -------------------------------------------------

const PERMISSION_SCREEN = fs.readFileSync(path.join(__dirname, 'fixtures', 'prompts', 'claude-2.1.312-permission.txt'), 'utf8').replace(/\s+$/, '').split('\n')
const WORKING = ['✻ Working… (esc to interrupt)', '─'.repeat(20), '❯ ', '─'.repeat(20)]
const IDLE = ['─'.repeat(20), '❯ ', '─'.repeat(20)]
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A terminal whose "agent" reads keys a while after they are written, as a real one does: the
 * permission menu's highlight moves on ↓, Enter picks the highlighted option and the menu goes.
 * `flush` does not wait for the agent (the mirror only parses what was printed).
 */
function fakeAgentTerminal(keyDelayMs: number) {
    let selected = 0
    let picked: number | null = null
    let outputAt = 1
    const writes: string[] = []
    const menu = (): string[] =>
        PERMISSION_SCREEN.map((line) => {
            const option = /^ (?:❯| ) (\d)\. (.*)$/.exec(line)
            if (!option) return line
            return `${Number(option[1]) - 1 === selected ? ' ❯' : '  '} ${option[1]}. ${option[2]}`
        })
    const writeInput = (_id: string, data: string): void => {
        writes.push(data)
        setTimeout(() => {
            if (picked !== null) return
            if (data === '\x1b[B') selected = Math.min(3, selected + 1)
            else if (data === '\x1b[A') selected = Math.max(0, selected - 1)
            else if (data === '\r') picked = selected
            outputAt += 1
        }, keyDelayMs)
    }
    return {
        writes,
        picked: () => picked,
        screen: (): string[] => (picked === null ? menu() : IDLE),
        lastOutputAt: () => outputAt,
        writeInput
    }
}

function serviceOn(terminal: { screen(): string[]; lastOutputAt(): number; writeInput(id: string, data: string): void }, overrides: Partial<ConversationServiceDeps> = {}) {
    const typed: string[] = []
    const deps: ConversationServiceDeps = {
        session: () => ({ cwd: '/w', cliSessionId: 'c1', cliToolName: 'claude' }),
        reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
        mirror: {
            screen: () => terminal.screen(),
            flush: async () => undefined,
            lastOutputAt: () => terminal.lastOutputAt(),
            hasExited: () => false,
            showsAwaitingInput: () => false,
            inputBox: () => ({ typed: '' })
        },
        hasTerminal: () => true,
        writeInput: (id, data) => terminal.writeInput(id, data),
        type: async (_id, text) => (typed.push(text), true),
        onChange: () => undefined,
        ...overrides
    }
    return { conversations: new ConversationService(deps), typed, deps }
}

test.describe('T79 F04 a question card’s keys go one answer at a time per session', () => {
    for (const keyDelayMs of [20, 200]) {
        test(`two devices answer option 2 of the same card at once: one answers, the other is refused (agent reads keys after ${keyDelayMs}ms)`, async () => {
            const terminal = fakeAgentTerminal(keyDelayMs)
            const { conversations } = serviceOn(terminal)
            const menu = readPrompt(terminal.screen(), 'claude')!
            expect(menu.options[0].selected).toBe(true)
            const answer = { signature: menu.signature, optionIndex: 1 }
            const results = await Promise.all([conversations.answerPrompt('s', answer), conversations.answerPrompt('s', answer)])
            await sleep(keyDelayMs * 4 + 200)
            expect(results.map((result) => result.status).sort()).toEqual(['answered', 'rejected'])
            expect(terminal.picked()).toBe(1)
            expect(terminal.writes).toEqual(['\x1b[B', '\r'])
        })
    }

    test('two Send now taps never type into the terminal at the same time', async () => {
        const terminal = { screen: () => WORKING, lastOutputAt: () => 1, writeInput: () => undefined }
        let typing = 0
        let overlapped = false
        const { conversations, typed } = serviceOn(terminal, {
            type: async (_id, text) => {
                typing += 1
                if (typing > 1) overlapped = true
                await sleep(80)
                typed.push(text)
                typing -= 1
                return true
            }
        })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'one')).toEqual({ status: 'queued' })
        expect(await conversations.send('s', 'two')).toEqual({ status: 'queued' })
        const queued = (await conversations.getConversation('s')).queued
        const results = await Promise.all(queued.map((item) => conversations.sendQueuedNow('s', item.id)))
        expect(results).toEqual([{ status: 'sent' }, { status: 'sent' }])
        expect(overlapped).toBe(false)
        expect(typed).toEqual(['one', 'two'])
        conversations.unsubscribe('s')
        conversations.cancelQueued('s')
    })
})

test.describe('T79 F09 text left unsubmitted in the input box is not reported as sent', () => {
    // ControlApiService.typeForChat returns false when the prompt is provably still in the box after the Enter retries
    const unsubmitted = { type: async () => false }

    test('a send at rest', async () => {
        const { conversations } = serviceOn({ screen: () => IDLE, lastOutputAt: () => 1, writeInput: () => undefined }, unsubmitted)
        expect(await conversations.send('s', 'hello')).toMatchObject({ status: 'rejected', reason: 'not_submitted' })
    })

    test('Send now: refused, and not queued again (the text already sits in the terminal’s box)', async () => {
        const { conversations } = serviceOn({ screen: () => WORKING, lastOutputAt: () => 1, writeInput: () => undefined }, unsubmitted)
        conversations.subscribe('s')
        expect(await conversations.send('s', 'later')).toEqual({ status: 'queued' })
        const [queued] = (await conversations.getConversation('s')).queued
        expect(await conversations.sendQueuedNow('s', queued.id)).toMatchObject({ status: 'rejected', reason: 'not_submitted' })
        expect((await conversations.getConversation('s')).queued).toEqual([])
        conversations.unsubscribe('s')
    })
})

test.describe('T79 F03 a queued message belongs to the agent it was written for, and to the device that sent it', () => {
    /** a terminal that printed long ago (the queue's quiet time is over) and whose screen the test sets */
    function quietTerminal() {
        let screen = WORKING
        let outputAt = Date.now() - 20_000
        // a new screen comes with output — printed long enough ago that the queue's quiet time is over
        const state = {
            set screen(lines: string[]) {
                screen = lines
                outputAt += 1
            }
        }
        return { state, terminal: { screen: () => screen, lastOutputAt: () => outputAt, writeInput: () => undefined } }
    }
    const poll = (conversations: ConversationService): Promise<void> => (conversations as unknown as { pollRound(): Promise<void> }).pollRound()

    test('the agent exits while the message waits: the shell left behind never gets it', async () => {
        const { state, terminal } = quietTerminal()
        let front: string | null = '4242'
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => front })
        expect(await conversations.send('s', 'touch /tmp/queue-proof')).toEqual({ status: 'queued' })
        state.screen = ['$ ']
        front = null
        await poll(conversations)
        expect(typed).toEqual([])
        expect((await conversations.getConversation('s')).queued).toEqual([])
    })

    test('another agent process took its place: not sent to it either', async () => {
        const { state, terminal } = quietTerminal()
        let front: string | null = '4242'
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => front })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'for the first one')).toEqual({ status: 'queued' })
        state.screen = IDLE
        front = '5151'
        await poll(conversations)
        expect(typed).toEqual([])
        expect((await conversations.getConversation('s')).queued).toEqual([])
        conversations.unsubscribe('s')
    })

    test('the same agent finished its turn: the message goes', async () => {
        const { state, terminal } = quietTerminal()
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => '4242' })
        expect(await conversations.send('s', 'next step')).toEqual({ status: 'queued' })
        state.screen = IDLE
        await poll(conversations)
        expect(typed).toEqual(['next step'])
    })

    test('Send now after the agent exited: refused and dropped', async () => {
        const { terminal } = quietTerminal()
        let front: string | null = '4242'
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => front })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'rm -rf build')).toEqual({ status: 'queued' })
        const [queued] = (await conversations.getConversation('s')).queued
        front = null
        expect(await conversations.sendQueuedNow('s', queued.id)).toMatchObject({ status: 'rejected', reason: 'no_agent' })
        expect(typed).toEqual([])
        expect((await conversations.getConversation('s')).queued).toEqual([])
        conversations.unsubscribe('s')
    })

    test('a send with no agent in front is refused instead of typed into the shell', async () => {
        const { conversations, typed } = serviceOn({ screen: () => ['$ '], lastOutputAt: () => 1, writeInput: () => undefined }, { agentProcess: async () => null })
        expect(await conversations.send('s', 'ls')).toMatchObject({ status: 'rejected', reason: 'no_agent' })
        expect(typed).toEqual([])
    })

    test('a device disconnected (or the phone turned off): what it queued is dropped, in every session; the rest stays', async () => {
        const { terminal } = quietTerminal()
        const { conversations } = serviceOn(terminal, { agentProcess: async () => '4242' })
        for (const id of ['s1', 's2']) conversations.subscribe(id)
        expect(await conversations.send('s1', 'from the Mac')).toEqual({ status: 'queued' })
        expect(await conversations.send('s1', 'from the phone', 'device:abc')).toEqual({ status: 'queued' })
        expect(await conversations.send('s2', 'also from the phone', 'device:abc')).toEqual({ status: 'queued' })
        expect(await conversations.send('s2', 'from another phone', 'device:xyz')).toEqual({ status: 'queued' })
        expect(conversations.dropQueuedFrom('device:abc')).toBe(2)
        expect((await conversations.getConversation('s1')).queued.map((item) => item.text)).toEqual(['from the Mac'])
        expect((await conversations.getConversation('s2')).queued.map((item) => item.text)).toEqual(['from another phone'])
        expect(conversations.dropQueuedFrom((origin) => origin !== undefined)).toBe(1)
        expect((await conversations.getConversation('s2')).queued).toEqual([])
        for (const id of ['s1', 's2']) {
            conversations.unsubscribe(id)
            conversations.cancelQueued(id)
        }
    })
})

test.describe('T79 F18 a terminal-only `/` command sent off the queue tells the view to show the terminal', () => {
    test('/config queued while working: once typed, the snapshot names it; a plain message does not', async () => {
        let screen = WORKING
        let outputAt = Date.now() - 20_000
        const terminal = { screen: () => screen, lastOutputAt: () => outputAt, writeInput: () => undefined }
        const { conversations, typed } = serviceOn(terminal, {
            listCommands: () => [{ name: 'config', description: '', source: 'builtin', terminal: 'always' }]
        })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'plain words')).toEqual({ status: 'queued' })
        expect(await conversations.send('s', '/config')).toEqual({ status: 'queued' })
        screen = IDLE
        outputAt += 1
        const poll = (): Promise<void> => (conversations as unknown as { pollRound(): Promise<void> }).pollRound()
        await poll()
        expect(typed).toEqual(['plain words'])
        expect((await conversations.getConversation('s')).terminalOpened ?? null).toBeNull()
        outputAt += 1
        await poll()
        expect(typed).toEqual(['plain words', '/config'])
        const opened = (await conversations.getConversation('s')).terminalOpened
        expect(opened?.command).toBe('/config')
        conversations.unsubscribe('s')
    })

    test('Send now of a queued /config names it too', async () => {
        const { conversations } = serviceOn({ screen: () => WORKING, lastOutputAt: () => 1, writeInput: () => undefined }, {
            listCommands: () => [{ name: 'model', description: '', source: 'builtin', terminal: 'bare' }]
        })
        conversations.subscribe('s')
        expect(await conversations.send('s', '/model')).toEqual({ status: 'queued' })
        const [queued] = (await conversations.getConversation('s')).queued
        expect(await conversations.sendQueuedNow('s', queued.id)).toEqual({ status: 'sent' })
        expect((await conversations.getConversation('s')).terminalOpened?.command).toBe('/model')
        conversations.unsubscribe('s')
    })
})

// ---- TranscriptReader ---------------------------------------------------------------------------

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t79-'))
const prompts = (turns: ConversationTurn[]): string[] =>
    turns.filter((turn) => turn.role === 'user').flatMap((turn) => turn.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])))
let uuidSequence = 0
const uuid = (): string => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`
/** One Claude prompt and its answer, as Claude Code writes them; `parent` is what the prompt hangs from. */
function claudeExchange(prompt: string, answer: string, parent: string | null): { lines: string[]; last: string } {
    const user = uuid()
    const assistant = uuid()
    const ts = new Date(Date.UTC(2026, 10, 5, 1, 0, uuidSequence)).toISOString()
    return {
        last: assistant,
        lines: [
            JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'user', uuid: user, timestamp: ts, message: { role: 'user', content: prompt } }),
            JSON.stringify({ parentUuid: user, isSidechain: false, type: 'assistant', uuid: assistant, timestamp: ts, message: { id: `msg_${assistant}`, type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } })
        ]
    }
}
function claudeHome(id: string): { reader: TranscriptReader; file: string } {
    const home = scratch()
    const dir = path.join(home, 'projects', 'p')
    fs.mkdirSync(dir, { recursive: true })
    return { reader: new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => home }), file: path.join(dir, `${id}.jsonl`) }
}

test.describe('T79 F12 a transcript replaced by another file is read again, not by its size alone', () => {
    const id = '00000000-0000-4000-8000-0000000000f1'

    test('replaced (a new file under the same name) with one of the same length: the new words show', () => {
        const { reader, file } = claudeHome(id)
        const apple = claudeExchange('apple', 'Apple noted.', null)
        fs.writeFileSync(file, apple.lines.join('\n') + '\n')
        expect(prompts(reader.read('s', 'claude', id)!.turns)).toEqual(['apple'])
        const replaced = apple.lines.join('\n').replace('"apple"', '"berry"').replace('Apple noted.', 'Berry noted.') + '\n'
        expect(Buffer.byteLength(replaced)).toBe(fs.statSync(file).size)
        fs.writeFileSync(`${file}.new`, replaced)
        fs.renameSync(`${file}.new`, file)
        expect(prompts(reader.read('s', 'claude', id)!.turns)).toEqual(['berry'])
    })

    test('rewritten in place, longer: the old start is not kept under the new end', () => {
        const { reader, file } = claudeHome(id)
        const apple = claudeExchange('apple', 'Apple noted.', null)
        fs.writeFileSync(file, apple.lines.join('\n') + '\n')
        expect(prompts(reader.read('s', 'claude', id)!.turns)).toEqual(['apple'])
        const berry = claudeExchange('berry', 'Berry noted.', null)
        const cherry = claudeExchange('cherry', 'Cherry noted.', berry.last)
        fs.writeFileSync(file, [...berry.lines, ...cherry.lines].join('\n') + '\n')
        expect(prompts(reader.read('s', 'claude', id)!.turns)).toEqual(['berry', 'cherry'])
    })

    test('an append is still read as an append (no start over)', () => {
        const { reader, file } = claudeHome(id)
        const apple = claudeExchange('apple', 'Apple noted.', null)
        fs.writeFileSync(file, apple.lines.join('\n') + '\n')
        reader.read('s', 'claude', id)
        const banana = claudeExchange('banana', 'Banana noted.', apple.last)
        fs.appendFileSync(file, banana.lines.join('\n') + '\n')
        const next = reader.read('s', 'claude', id)!
        expect(next.changed).toBe(true)
        expect(prompts(next.turns)).toEqual(['apple', 'banana'])
    })
})
