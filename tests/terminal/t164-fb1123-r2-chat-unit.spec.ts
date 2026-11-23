import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
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
        set(lines: string[]): void {
            screen = lines
            outputAt += 1
        },
        screen: (): string[] => screen,
        lastOutputAt: (): number => outputAt
    }
}

function serviceOn(terminal: { screen(): string[]; lastOutputAt(): number }, overrides: Partial<ConversationServiceDeps> = {}) {
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
            inputBox: () => ({ typed: '' }),
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
    test('left unsubmitted in the input box: a «Not sent» row; Retry goes through the guarded send; ✕ removes it', async () => {
        const terminal = quietTerminal(WORKING)
        let submits = false
        const { conversations, typed } = serviceOn(terminal, { type: async (_id, text) => (typed.push(text), submits) })
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

        // the next poll does not type it again on its own
        await poll(conversations)
        expect(typed).toHaveLength(1)
        // a new message is not held back by it
        submits = true
        expect(await conversations.send('s', 'another')).toEqual({ status: 'sent' })

        // Retry while it still does not go: refused, the row stays (same id)
        submits = false
        expect(await conversations.sendQueuedNow('s', row.id)).toMatchObject({ status: 'rejected', reason: 'not_submitted' })
        snapshot = await conversations.getConversation('s')
        expect(snapshot.unsent?.map((item) => item.id)).toEqual([row.id])
        // Retry refused before typing (a question on screen): nothing typed, the row stays
        const before = typed.length
        terminal.set(FOUR_TABS)
        expect(await conversations.sendQueuedNow('s', row.id)).toMatchObject({ status: 'rejected', reason: 'awaiting_input' })
        expect(typed).toHaveLength(before)
        expect((await conversations.getConversation('s')).unsent?.map((item) => item.id)).toEqual([row.id])
        // Retry that goes: sent, the row is gone
        terminal.set(IDLE)
        submits = true
        expect(await conversations.sendQueuedNow('s', row.id)).toEqual({ status: 'sent' })
        expect((await conversations.getConversation('s')).unsent).toEqual([])

        // ✕ (and Edit's withdrawal) on a row
        submits = false
        expect(await conversations.send('s', 'third')).toMatchObject({ status: 'rejected', reason: 'not_submitted' })
        terminal.set(WORKING)
        expect(await conversations.send('s', 'fourth')).toEqual({ status: 'queued' })
        terminal.set(IDLE)
        await poll(conversations)
        const [failed] = (await conversations.getConversation('s')).unsent!
        expect(failed.text).toBe('fourth')
        expect(conversations.discardQueued('s', failed.id)).toBe(true)
        expect((await conversations.getConversation('s')).unsent).toEqual([])
        conversations.unsubscribe('s')
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
        const { conversations } = serviceOn(terminal, { type: async () => false })
        expect(await conversations.send('s', 'from the Mac')).toEqual({ status: 'queued' })
        terminal.set(IDLE)
        await poll(conversations)
        const [row] = (await conversations.getConversation('s')).unsent!
        // a phone taps Retry and is disconnected by the time the send checks its access
        const result = await conversations.sendQueuedNow('s', row.id, { origin: 'device:abc', allowed: () => false })
        expect(result).toMatchObject({ status: 'rejected', reason: 'revoked' })
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
