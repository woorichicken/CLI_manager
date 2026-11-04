import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
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
