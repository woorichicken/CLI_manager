import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ApiErrorTails, lastTurnApiError } from '../../src/main/transcript/apiError'
import { SessionScreenStatusPoller } from '../../src/main/SessionScreenStatus'
import { answerForAgent } from '../../src/renderer/src/components/ChatView/chatLib'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { readPrompt } from '../../src/main/promptScreen'
import { maskSnapshot } from '../../src/main/phone/phoneApi'

/**
 * T164 — fb-1123 round 2 Chat reports, without Electron.
 *
 * f7bff999 «이런 부분이 GUI 로 안보임»: Claude Code's AskUserQuestion with four question tabs and option previews
 * (2.1.330 on the reporter's Mac). The screen copy is modelled on the reported screenshot with neutral words
 * (fixtures/prompts/claude-2.1.330-ask-four-tabs-preview-modelled.txt — not a capture: no turn was sent to a real
 * account). Today's parser reads that copy; what it left out was the preview (cut away on purpose in T120) and how
 * many tabs are answered. And any row above the dialog that reads like a turn in progress — the agent's own words
 * «… (esc to interrupt) …», a bullet «* 정리 중… (2개 남음)» — hid the card entirely: the whole screen was checked.
 *
 * 019248e1 «가끔 길어지면, 메세지 전송이 안된 상태로 없어져 있는게 있음»: a queued message that did not go
 * (left unsubmitted in the input box, or its agent gone) was dropped with a console line only. It now stays as a
 * «Not sent» row with the reason, Retry (through the guarded send) and ✕.
 */

const PROMPTS = path.join(__dirname, 'fixtures', 'prompts')
const FOUR_TABS = fs.readFileSync(path.join(PROMPTS, 'claude-2.1.330-ask-four-tabs-preview-modelled.txt'), 'utf8').replace(/\s+$/, '').split('\n')
/** the copy with `row` put in the conversation above the dialog (right under «Read 1 file») */
const withAbove = (row: string): string[] => {
    const at = FOUR_TABS.findIndex((line) => line.includes('Read 1 file'))
    return [...FOUR_TABS.slice(0, at + 1), row, ...FOUR_TABS.slice(at + 1)]
}

test.describe('T164 f7bff999 four question tabs with previews', () => {
    test('the card: the whole «│» question, three options, four tabs and Submit, the highlighted option’s preview', () => {
        const menu = readPrompt(FOUR_TABS, 'claude')!
        expect(menu).not.toBeNull()
        expect(menu.kind).toBe('question')
        expect(menu.question).toBe(
            '0a1b2c3d 메뉴 자리: 「딱 그 부분만 비우기」는 가능합니다. 다만 기본 폭(256px)에서는 표시등(약 70px)·제목·아이콘 5개가 한 줄에 다 안 들어갑니다. 어떻게 할까요?'
        )
        expect(menu.options.map((option) => [option.label, option.selected])).toEqual([
            ['표시등 옆만 비움 (Recommended)', true],
            ['목록 칸만 내림', false],
            ['지금처럼 전체 띠', false]
        ])
        expect(menu.steps?.map((step) => [step.label, step.answered, step.submit === true])).toEqual([
            ['메뉴 자리', false, false],
            ['줄 모양', false, false],
            ['0a1b2c3d', false, false],
            ['마무리', false, false],
            ['Submit', false, true]
        ])
        expect(menu.answerable).toBe(true)
        // the preview box's rows, without its own edges: what the terminal shows beside the options
        const preview = menu.preview ?? []
        expect(preview.length).toBeGreaterThanOrEqual(8)
        expect(preview[0]).toMatch(/^┌─+┬─+┐$/)
        expect(preview.join('\n')).toContain('‹ › proj > session')
        expect(preview.join('\n')).toContain('│ Search…')
        expect(preview).toContain('(넓힌 목록)')
        for (const row of preview) expect(row, 'no edge of the outer box').not.toMatch(/^│ │.*│ │$/)
        for (const option of menu.options) expect(option.label).not.toMatch(/Notes|[│┌└]/)
    })

    test('answered tabs are read from their marks', () => {
        const menu = readPrompt(FOUR_TABS.map((line) => line.replace('☐ 메뉴 자리  ☐ 줄 모양', '☒ 메뉴 자리  ☒ 줄 모양')), 'claude')!
        expect(menu.steps?.filter((step) => step.answered).map((step) => step.label)).toEqual(['메뉴 자리', '줄 모양'])
    })

    for (const [what, row] of [
        ['the agent’s words naming the spinner hint', '  The spinner row says (esc to interrupt) while a turn works.'],
        ['a bullet that reads like a spinner row', '* 정리 중… (2개 남음)']
    ] as const) {
        test(`a card even with ${what} in the conversation above the dialog`, () => {
            const menu = readPrompt(withAbove(row), 'claude')
            expect(menu, 'the dialog is the last thing drawn: the agent waits on it').not.toBeNull()
            expect(menu!.options).toHaveLength(3)
        })
    }

    test('still no card while a turn runs under dialog words (the spinner below them)', () => {
        const rule = '─'.repeat(98)
        expect(readPrompt([...FOUR_TABS, '✻ Working… (3s · esc to interrupt)', rule, '❯ ', rule], 'claude')).toBeNull()
        expect(readPrompt([...FOUR_TABS.slice(0, -1), '✳ Galloping… (8s · ↓ 527 tokens)', FOUR_TABS.at(-1)!], 'claude')).toBeNull()
    })

    test('a «Notes:» hint drawn beside the last option is not part of its label', () => {
        // a preview shorter than the options: the right column's notes hint lands on an option's row
        const box = '┌' + '─'.repeat(30) + '┐'
        const screen = [
            '─'.repeat(98),
            '←  ☐ 메뉴  ☐ 줄  ✔ Submit  →',
            '',
            '│ 어느 쪽이 좋을까요?',
            '',
            '❯ 1. 한 줄                       ' + box,
            '    (Recommended)                │ 한 줄 모양                   │',
            '  2. 두 줄                       └' + '─'.repeat(30) + '┘',
            '  3. 접기',
            '                                 Notes: press n to add notes',
            '',
            '─'.repeat(98),
            '  Chat about this',
            '',
            'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel'
        ]
        const beside = screen.map((line, row) => (row === 8 ? '  3. 접기                         Notes: press n to add notes' : row === 9 ? '' : line))
        for (const lines of [screen, beside]) {
            const menu = readPrompt(lines, 'claude')!
            expect(menu.options.map((option) => option.label)).toEqual(['한 줄 (Recommended)', '두 줄', '접기'])
            expect(menu.preview).toEqual(['한 줄 모양'])
        }
    })
})

// ---- ConversationService with a fake terminal -------------------------------------------------

const IDLE = ['─'.repeat(20), '❯ ', '─'.repeat(20)]
const WORKING = ['✻ Working… (esc to interrupt)', ...IDLE]

/** A terminal the test sets the screen of; its last output is long ago (the queue's quiet time is over). */
function quietTerminal(first: string[]) {
    let screen = first
    let outputAt = Date.now() - 20_000
    return {
        /** what the agent's input box holds (a not-submitted message stays there) */
        box: '',
        set(lines: string[]): void {
            screen = lines
            outputAt += 1
        },
        /** output came (the agent redrew): the next refresh reads the screen again */
        tick(): void {
            outputAt += 1
        },
        screen: (): string[] => screen,
        lastOutputAt: (): number => outputAt
    }
}

function serviceOn(terminal: { screen(): string[]; lastOutputAt(): number; box?: string }, overrides: Partial<ConversationServiceDeps> = {}) {
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
            inputBox: () => ({ typed: terminal.box ?? '' }),
            codexInput: () => ({ typed: '' })
        },
        hasTerminal: () => true,
        writeInput: () => undefined,
        type: async (_id, text) => (typed.push(text), true),
        onChange: () => undefined,
        agentProcess: async () => '4242',
        ...overrides
    }
    return { conversations: new ConversationService(deps), typed }
}
const poll = (conversations: ConversationService): Promise<void> => (conversations as unknown as { pollRound(): Promise<void> }).pollRound()

test.describe('T164 f7bff999 a phone gets the preview masked, line by line', () => {
    test('maskSnapshot masks every preview row as it masks the question and options', () => {
        const menu = readPrompt(FOUR_TABS, 'claude')!
        const masked = maskSnapshot(
            { sessionId: 's', agent: 'claude', turns: [], totalTurns: 0, truncated: false, working: false, prompt: menu, queued: [], meta: null, revision: 1 },
            (line) => `[masked] ${line}`
        )
        expect(masked.prompt?.preview).toEqual(menu.preview!.map((line) => `[masked] ${line}`))
    })
})

test.describe('T164 f7bff999 the Chat reads the dialog, not words above it', () => {
    test('a card and not «working» when the conversation above names the spinner hint', async () => {
        const terminal = quietTerminal(withAbove('  The spinner row says (esc to interrupt) while a turn works.'))
        const { conversations } = serviceOn(terminal)
        const snapshot = await conversations.getConversation('s')
        expect(snapshot.prompt?.options).toHaveLength(3)
        expect(snapshot.working).toBe(false)
    })
})

test.describe('T164 019248e1 a queued message that did not go stays, with the reason', () => {
    test('left unsubmitted in the input box: a «Not sent» row, never typed again; gone from the box → «left the input line», Retry refused', async () => {
        const terminal = quietTerminal(WORKING)
        const PLACEHOLDER = '[Pasted text #1 +2 lines]'
        let submits = false
        const { conversations, typed } = serviceOn(terminal, {
            type: async (_id, text) => {
                typed.push(text)
                // left in the box as Claude Code folds a long paste
                if (!submits) terminal.box = PLACEHOLDER
                return submits
            }
        })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'line one\nline two\nline three')).toEqual({ status: 'queued' })
        terminal.set(IDLE)
        await poll(conversations)
        expect(typed).toEqual(['line one\nline two\nline three'])
        let snapshot = await conversations.getConversation('s')
        expect(snapshot.queued).toEqual([])
        expect(snapshot.unsent).toHaveLength(1)
        const [row] = snapshot.unsent!
        expect(row.text).toBe('line one\nline two\nline three')
        expect(row.reason).toBe('not_submitted')
        expect(row.message).toMatch(/not submitted/i)

        // later polls never type it again, and the row stays while the box holds it
        terminal.tick()
        await poll(conversations)
        terminal.tick()
        await poll(conversations)
        expect(typed).toHaveLength(1)
        expect((await conversations.getConversation('s')).unsent?.map((item) => item.reason)).toEqual(['not_submitted'])
        // Retry while it sits there: refused by the guarded send (the box has text), the row stays (same id)
        expect(await conversations.sendQueuedNow('s', row.id)).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(typed).toHaveLength(1)
        expect((await conversations.getConversation('s')).unsent?.map((item) => item.id)).toEqual([row.id])

        // the person presses Enter in the terminal: the box empties — after two reads the row says so
        terminal.box = ''
        terminal.tick()
        await poll(conversations)
        terminal.tick()
        await poll(conversations)
        snapshot = await conversations.getConversation('s')
        expect(snapshot.unsent?.map((item) => [item.id, item.reason])).toEqual([[row.id, 'left_input']])
        // Retry now would send it a second time: refused, nothing typed
        submits = true
        expect(await conversations.sendQueuedNow('s', row.id)).toMatchObject({ status: 'rejected', reason: 'empty' })
        expect(typed).toHaveLength(1)
        // a new message is not held back by it
        expect(await conversations.send('s', 'another')).toEqual({ status: 'sent' })
        // ✕ (and Edit's withdrawal) removes it
        expect(conversations.discardQueued('s', row.id)).toBe(true)
        expect((await conversations.getConversation('s')).unsent).toEqual([])
        conversations.unsubscribe('s')
    })

    test('Retry checks the box first: words that left it since are not sent again', async () => {
        const terminal = quietTerminal(WORKING)
        const { conversations, typed } = serviceOn(terminal, { type: async (_id, text) => (typed.push(text), (terminal.box = '[Pasted text #1 +3 lines]'), false) })
        expect(await conversations.send('s', 'a\nb\nc\nd')).toEqual({ status: 'queued' })
        terminal.set(IDLE)
        await poll(conversations)
        const [row] = (await conversations.getConversation('s')).unsent!
        // sent from the terminal while no view watched (no reads since)
        terminal.box = ''
        expect(await conversations.sendQueuedNow('s', row.id)).toMatchObject({ status: 'rejected', reason: 'empty' })
        expect(typed).toHaveLength(1)
        expect((await conversations.getConversation('s')).unsent?.map((item) => item.reason)).toEqual(['left_input'])
    })

    test('at most 50 rows are kept, the oldest go first', async () => {
        const terminal = quietTerminal(WORKING)
        let front: string | null = '4242'
        const { conversations } = serviceOn(terminal, { agentProcess: async () => front })
        for (let n = 0; n < 52; n++) expect(await conversations.send('s', `m${n}`)).toEqual({ status: 'queued' })
        terminal.set(['$ '])
        front = null
        await poll(conversations)
        const texts = (await conversations.getConversation('s')).unsent!.map((item) => item.text)
        expect(texts).toHaveLength(50)
        expect([texts[0], texts.at(-1)]).toEqual(['m2', 'm51'])
    })

    test('the agent it was written for exited: a «Not sent» row (never typed into the shell)', async () => {
        const terminal = quietTerminal(WORKING)
        let front: string | null = '4242'
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => front })
        expect(await conversations.send('s', 'touch /tmp/queue-proof')).toEqual({ status: 'queued' })
        terminal.set(['$ '])
        front = null
        await poll(conversations)
        expect(typed).toEqual([])
        const snapshot = await conversations.getConversation('s')
        expect(snapshot.queued).toEqual([])
        expect(snapshot.unsent?.map((item) => [item.text, item.reason])).toEqual([['touch /tmp/queue-proof', 'no_agent']])
        // Retry is the guarded send: still no agent, nothing typed
        expect(await conversations.sendQueuedNow('s', snapshot.unsent![0].id)).toMatchObject({ status: 'rejected', reason: 'no_agent' })
        expect(typed).toEqual([])
    })

    test('a sender that lost access: its message is dropped, not kept for others to send', async () => {
        const terminal = quietTerminal(WORKING)
        let allowed = true
        const { conversations, typed } = serviceOn(terminal)
        expect(await conversations.send('s', 'from the phone', { origin: 'device:abc', allowed: () => allowed })).toEqual({ status: 'queued' })
        allowed = false
        terminal.set(IDLE)
        await poll(conversations)
        expect(typed).toEqual([])
        const snapshot = await conversations.getConversation('s')
        expect(snapshot.queued).toEqual([])
        expect(snapshot.unsent ?? []).toEqual([])
    })

    test('Retry from a device that lost access meanwhile leaves the row to its owner', async () => {
        const terminal = quietTerminal(WORKING)
        const { conversations } = serviceOn(terminal, { type: async (_id, text) => ((terminal.box = text), false) })
        expect(await conversations.send('s', 'from the Mac')).toEqual({ status: 'queued' })
        terminal.set(IDLE)
        await poll(conversations)
        const [row] = (await conversations.getConversation('s')).unsent!
        // a phone taps Retry and is disconnected by the time the send checks its access
        const result = await conversations.sendQueuedNow('s', row.id, { origin: 'device:abc', allowed: () => false })
        // refused (the box holds it, or the tapper's access is gone) — and the row is still the Mac's
        expect(result).toMatchObject({ status: 'rejected' })
        expect((await conversations.getConversation('s')).unsent?.map((item) => [item.id, item.text])).toEqual([[row.id, 'from the Mac']])
    })

    test('a phone disconnecting drops its «Not sent» rows too', async () => {
        const terminal = quietTerminal(WORKING)
        const { conversations } = serviceOn(terminal, { type: async () => false })
        expect(await conversations.send('s', 'from the phone', 'device:abc')).toEqual({ status: 'queued' })
        terminal.set(IDLE)
        await poll(conversations)
        expect((await conversations.getConversation('s')).unsent).toHaveLength(1)
        expect(conversations.dropQueuedFrom('device:abc')).toBe(1)
        expect((await conversations.getConversation('s')).unsent).toEqual([])
    })
})

// ---- 3239a243: a turn that ended on an API error is a red dot ---------------------------------

/** Records shaped as Claude Code 2.1.330 writes them (read from real transcripts; words and ids synthetic). */
const claudeRecord = (type: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type, timestamp: '2026-11-23T10:44:20.358Z', message: { role: type, ...(type === 'assistant' ? { model: 'claude-opus-5-5' } : {}), content: [{ type: 'text', text }] }, ...extra })
const DROPPED = 'API Error: Connection dropped (ECONNRESET). A VPN, firewall, or security software can cause this. Check those or switch networks, then try again.'
const apiErrorRecord = (text = DROPPED): string =>
    JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T10:44:20.358Z',
        message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', type: 'message', content: [{ type: 'text', text }] },
        apiError: 'connection_failed',
        error: 'server_error',
        isApiErrorMessage: true
    })

test.describe('T164 3239a243 the last turn’s API error, from the transcript', () => {
    test('an error record last (other records after it) is the error; a prompt after it ends it', async () => {
        const snapshot = JSON.stringify({ type: 'file-history-snapshot', snapshot: {} })
        expect(lastTurnApiError([claudeRecord('user', 'hello'), claudeRecord('assistant', 'Hi.'), claudeRecord('user', 'go on'), apiErrorRecord()].join('\n'))).toBe(DROPPED)
        expect(lastTurnApiError([claudeRecord('user', 'go on'), apiErrorRecord(), snapshot, JSON.stringify({ type: 'system', subtype: 'turn_duration' }), ''].join('\n'))).toBe(DROPPED)
        // the next prompt: over
        expect(lastTurnApiError([apiErrorRecord(), snapshot, claudeRecord('user', 'try again')].join('\n'))).toBeNull()
        // answered after: over
        expect(lastTurnApiError([apiErrorRecord(), claudeRecord('user', 'try again'), claudeRecord('assistant', 'Done.')].join('\n'))).toBeNull()
        // an answer that only quotes the words is no error
        expect(lastTurnApiError([claudeRecord('user', 'what is this?'), claudeRecord('assistant', `It says «${DROPPED}»`)].join('\n'))).toBeNull()
        // a subagent's error (sidechain) is not the session's turn; a cut first line is skipped
        expect(lastTurnApiError([claudeRecord('assistant', 'Fine.'), JSON.stringify({ ...JSON.parse(apiErrorRecord()), isSidechain: true })].join('\n'))).toBeNull()
        expect(lastTurnApiError(['ated":"cut"}', apiErrorRecord('API Error: The response stopped arriving')].join('\n'))).toBe('API Error: The response stopped arriving')
    })

    test('ApiErrorTails reads a file again only when it changed', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t164-')), 'c.jsonl')
        fs.writeFileSync(file, [claudeRecord('user', 'go'), apiErrorRecord()].join('\n') + '\n')
        const tails = new ApiErrorTails()
        expect(tails.read(file)).toBe(DROPPED)
        fs.appendFileSync(file, claudeRecord('user', 'try again') + '\n')
        expect(tails.read(file)).toBeNull()
        expect(tails.read(path.join(path.dirname(file), 'missing.jsonl'))).toBeNull()
    })

    test('the poller: red while idle after the error; working, a question and the next turn win', async () => {
        let screen = { busy: false, question: null as string | null }
        let error: string | null = DROPPED
        const published: unknown[] = []
        const poller = new SessionScreenStatusPoller({
            mirror: { ids: () => ['s1'], hasExited: () => false, lastOutputAt: () => Date.now(), screenStatus: () => screen },
            hookStatus: () => null,
            lastTurnError: () => error,
            publish: (message) => published.push(message)
        })
        expect(poller.tick()).toEqual([{ sessionId: 's1', state: 'error', error: DROPPED }])
        expect(poller.tick()).toEqual([])
        screen = { busy: true, question: null }
        expect(poller.tick()).toEqual([{ sessionId: 's1', state: 'working' }])
        screen = { busy: false, question: 'Do you want to proceed?' }
        expect(poller.tick()).toEqual([{ sessionId: 's1', state: 'waiting', question: 'Do you want to proceed?' }])
        screen = { busy: false, question: null }
        error = null
        expect(poller.tick()).toEqual([{ sessionId: 's1', state: 'idle' }])
        // what the renderer is told: the first change carries the error's words for the tooltip
        expect(published[0]).toEqual({ enabled: true, reset: false, changes: [{ sessionId: 's1', state: 'error', error: DROPPED }] })
    })
})

// ---- 45127b82: an answer copied for another agent ---------------------------------------------

test.describe('T164 45127b82 «Copy for agent» on an answer', () => {
    /** the local time with its UTC offset, as the copy writes it (computed, not typed) */
    const localWhen = (at: string): string => {
        const date = new Date(at)
        const pad = (n: number): string => String(n).padStart(2, '0')
        const offset = -date.getTimezoneOffset()
        const zone = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} (${zone})`
    }

    test('the session’s name and link, which answer it is and when, then the answer', () => {
        const at = '2026-11-23T09:15:00.000Z'
        expect(answerForAgent({ sessionName: 'Review: header', sessionId: '0123abcd-ffff-4000-8000-000000000000', at, answerNumber: 2, answerTotal: 3, answer: '\nHere is the plan.\n\n- one\n' })).toBe(
            ['From "Review: header" in CLI Manager · climanager://session/0123abcd', `Answer 2 of 3 · answered ${localWhen(at)}`, '', 'Here is the plan.\n\n- one'].join('\n')
        )
        expect(localWhen(at)).toMatch(/\(UTC[+-]\d\d:\d\d\)$/)
    })

    test('not all of the conversation read: the time alone; no time either: just the session', () => {
        const at = '2026-11-23T09:15:00.000Z'
        expect(answerForAgent({ sessionName: 'A', sessionId: 'abcdef0123456789', at, answer: 'Done.' })).toBe(
            ['From "A" in CLI Manager · climanager://session/abcdef01', `answered ${localWhen(at)}`, '', 'Done.'].join('\n')
        )
        expect(answerForAgent({ sessionId: 'abcdef0123456789', at: null, answer: 'Done.' })).toBe(['From a session in CLI Manager · climanager://session/abcdef01', '', 'Done.'].join('\n'))
    })
})
