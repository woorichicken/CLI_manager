import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { answerSteps, confirmTarget, KEYS, readPrompt } from '../../src/main/promptScreen'
import { ConversationService } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'

/**
 * T112 — question cards, round chat-gap-r3-1109 round 4. No Electron.
 *
 * Q-5 Claude Code's MCP elicitation with no fields (fb 58814f80): «MCP server "x" requests your input»,
 * the server's message, `❯ Accept    Decline` on one row, «Esc to cancel · ↑/↓ to navigate». Copied from
 * real Claude Code 2.1.319 screens (fixtures/prompts/claude-2.1.319-mcp-elicitation*.txt, a test MCP server
 * asking `elicitation/create` with an empty schema, 2026-11-09). The keys are the ones measured there, read
 * back from the server's log: Enter on the highlighted Accept → `accept`; ↓ moves to Decline (↑/↓ go round
 * the two) and Enter → `decline`; Esc → `cancel`.
 */

const screen = (name: string): string[] =>
    fs.readFileSync(path.join(__dirname, 'fixtures/prompts', name), 'utf8').replace(/\s+$/, '').split('\n')
const { up, down, enter, esc } = KEYS
const keys = (...list: string[]) => list.map((key) => ({ key }))

/** The screen in the report (fb 58814f80), the project id masked. */
const REPORTED = [
    '─────────────────────────────────────────────────────────────────────────────── session title ─',
    '',
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    '  MCP server “supabase-dev-hosted” requests your input',
    '',
    '  This SQL includes destructive operations (DROP, DELETE, TRUNCATE or UPDATE without WHERE).',
    '  It may permanently remove data, tables, schemas or other objects.',
    '  Run it on project abcdefghijklmnopqrst?',
    '',
    '  ❯ Accept    Decline',
    '',
    '  Esc to cancel · ↑/↓ to navigate'
]

test.describe('T112 Q-5 MCP elicitation Accept / Decline', () => {
    test('read off the real screen: the question, the server and its words, Accept · Decline · Cancel', () => {
        const menu = readPrompt(screen('claude-2.1.319-mcp-elicitation.txt'), 'claude')!
        expect(menu.kind).toBe('permission')
        expect(menu.answerable).toBe(true)
        expect(menu.question).toBe('Run it on project abcdefghijklmnopqrst?')
        expect(menu.context).toEqual(['MCP server “elicit-test” requests your input', 'This drops the demo table.', 'It may permanently remove data.'])
        expect(menu.options.map((option) => [option.label, option.selected, option.escape === true])).toEqual([
            ['Accept', true, false],
            ['Decline', false, false],
            ['Cancel', false, true]
        ])
    })

    test('the keys measured: Accept is Enter, Decline is ↓ then Enter, Cancel is Esc', () => {
        const menu = readPrompt(screen('claude-2.1.319-mcp-elicitation.txt'), 'claude')!
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 0 })).toEqual(keys(enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toEqual(keys(down, enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 2 })).toEqual(keys(esc))
        expect(confirmTarget(menu, { signature: menu.signature, optionIndex: 1 })).toBe(1)
        expect(confirmTarget(menu, { signature: menu.signature, optionIndex: 2 })).toBe(0)
    })

    test('Decline highlighted (↓ pressed in the terminal): Accept is ↑ then Enter', () => {
        const menu = readPrompt(screen('claude-2.1.319-mcp-elicitation-decline.txt'), 'claude')!
        expect(menu.options.map((option) => option.selected)).toEqual([false, true, false])
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 0 })).toEqual(keys(up, enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toEqual(keys(enter))
    })

    test('the reported screen (fb 58814f80) reads the same way', () => {
        const menu = readPrompt(REPORTED, 'claude')!
        expect(menu.question).toBe('Run it on project abcdefghijklmnopqrst?')
        expect(menu.context[0]).toBe('MCP server “supabase-dev-hosted” requests your input')
        expect(menu.options.map((option) => option.label)).toEqual(['Accept', 'Decline', 'Cancel'])
        expect(menu.answerable).toBe(true)
    })

    test('answered — something drawn under it — or a Codex screen: no card', () => {
        expect(readPrompt([...REPORTED, '', '⏺ The query ran.'], 'claude')).toBeNull()
        expect(readPrompt(REPORTED, 'codex')?.options.some((option) => option.label === 'Decline') ?? false).toBe(false)
    })

    test('a narrow pane wraps the message: still one question, the rest is context', () => {
        const narrow = [
            '────────────────────────────────────────',
            '  MCP server “supabase-dev-hosted”',
            '  requests your input',
            '',
            '  This SQL includes destructive',
            '  operations.',
            '  Run it on project abcdefghijklmnopqrst?',
            '',
            '  ❯ Accept    Decline',
            '',
            '  Esc to cancel · ↑/↓ to navigate'
        ]
        const menu = readPrompt(narrow, 'claude')!
        expect(menu.question).toBe('Run it on project abcdefghijklmnopqrst?')
        expect(menu.context).toEqual(['MCP server “supabase-dev-hosted” requests your input', 'This SQL includes destructive', 'operations.'])
        expect(menu.answerable).toBe(true)
    })
})

/**
 * Q-7 Codex's request_user_input — copies of real codex-cli 0.166.0 screens (2026-11-09, run with
 * `--enable default_mode_request_user_input`, the folder path masked). The keys are the ones pressed while
 * capturing them, checked against what Codex recorded (`function_call_output`): ↓ then Enter answered «Blue»
 * and went to question 2; ↓ ↓ to «None of the above», Tab, «Medium please», Enter recorded
 * `["None of the above", "user_note: Medium please"]`.
 */
const { tab } = KEYS

test.describe('T112 Q-7 Codex request_user_input', () => {
    test('question 1 of 2: the question, its options with their descriptions, the typed answer row', () => {
        const menu = readPrompt(screen('codex-0.166-question-q1.txt'), 'codex')!
        expect([menu.kind, menu.answerable, menu.multi]).toEqual(['question', true, false])
        expect(menu.question).toBe('Which color?')
        expect(menu.context).toEqual(['Question 1 of 2'])
        expect(menu.options.map((option) => [option.label, option.description ?? null, option.selected, option.custom === true])).toEqual([
            ['Red', 'Choose red.', true, false],
            ['Blue', 'Choose blue.', false, false],
            ['None of the above', 'Optionally, add details in notes (tab)', false, true]
        ])
    })

    test('the keys measured: ↓ then Enter for Blue; Enter alone for the highlighted one', () => {
        const menu = readPrompt(screen('codex-0.166-question-q1.txt'), 'codex')!
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 1 })).toEqual(keys(down, enter))
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 0 })).toEqual(keys(enter))
        const moved = readPrompt(screen('codex-0.166-question-q1-down.txt'), 'codex')!
        expect(moved.options.map((option) => option.selected)).toEqual([false, true, false])
        expect(answerSteps(moved, { signature: moved.signature, optionIndex: 0 })).toEqual(keys(up, enter))
    })

    test('typed words: to «None of the above», Tab, the words, Enter', () => {
        const menu = readPrompt(screen('codex-0.166-question-q2.txt'), 'codex')!
        expect(menu.question).toBe('Which size?')
        expect(menu.context).toEqual(['Question 2 of 2'])
        expect(answerSteps(menu, { signature: menu.signature, customText: 'Medium please' })).toEqual([{ key: down }, { key: down }, { key: tab }, { text: 'Medium please' }, { key: enter }])
        expect(confirmTarget(menu, { signature: menu.signature, customText: 'Medium please' })).toBe(2)
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndex: 2 })).toThrow()
    })

    test('one question: no «Question 1 of 1» line', () => {
        const menu = readPrompt(screen('codex-0.166-question-single.txt'), 'codex')!
        expect([menu.question, menu.context, menu.answerable]).toEqual(['Which language?', [], true])
        expect(menu.options.map((option) => option.label)).toEqual(['Korean', 'English', 'None of the above'])
    })

    test('the notes line open, or the questions answered: no card to answer', () => {
        const notes = readPrompt(screen('codex-0.166-question-q2-notes.txt'), 'codex')
        expect(notes?.answerable ?? false).toBe(false)
        expect(readPrompt(screen('codex-0.166-question-answered.txt'), 'codex')).toBeNull()
    })

    test('Codex approvals still read as before (fixtures of round 1)', () => {
        const approval = readPrompt(screen('codex-0.166-exec-approval.txt'), 'codex')!
        expect([approval.kind, approval.answerable]).toEqual(['permission', true])
        expect(approval.options.some((option) => option.description !== undefined)).toBe(false)
    })
})

test.describe('T112 a menu closed in two writes within one millisecond', () => {
    test('the card goes: the screen is read again when another chunk came, whatever the clock says', async () => {
        // found by T113: Accept answered, the terminal clean, the card still up — the screen had been read
        // between two chunks that arrived in the same millisecond, and the time compared equal after
        let screenNow = REPORTED
        let count = 1
        const service = new ConversationService({
            session: () => ({ cwd: '/w', cliSessionId: 'c1', cliToolName: 'claude' }),
            reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
            mirror: {
                screen: () => screenNow,
                flush: async () => undefined,
                lastOutputAt: () => 1000,
                outputCount: () => count,
                hasExited: () => false,
                showsAwaitingInput: () => false,
                inputBox: () => ({ typed: '' })
            },
            hasTerminal: () => true,
            writeInput: () => undefined,
            type: async () => true,
            onChange: () => undefined
        })
        service.subscribe('s1') // a chat open on it: the entry (and what it last read) stays
        expect((await service.getConversation('s1')).prompt?.question).toBe('Run it on project abcdefghijklmnopqrst?')
        screenNow = ['CHOSE: accept', '─'.repeat(40), '❯ ', '─'.repeat(40)]
        count = 2
        expect((await service.getConversation('s1')).prompt).toBeNull()
        service.unsubscribe('s1')
    })
})

test.describe('T112 a menu a view read is announced when it goes', () => {
    test('a read that finds a new menu bumps the revision and tells the views', async () => {
        // found by T113: the view fetched the card itself (rev 7), the poll never saw the card, so when it
        // closed the poll compared «no menu» with «no menu» and told nobody — the card stayed up
        let screenNow = ['$ ', '─'.repeat(40), '❯ ', '─'.repeat(40)]
        let count = 1
        const changes: number[] = []
        const service = new ConversationService({
            session: () => ({ cwd: '/w', cliSessionId: 'c1', cliToolName: 'claude' }),
            reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
            mirror: {
                screen: () => screenNow,
                flush: async () => undefined,
                lastOutputAt: () => count,
                outputCount: () => count,
                hasExited: () => false,
                showsAwaitingInput: () => false,
                inputBox: () => ({ typed: '' })
            },
            hasTerminal: () => true,
            writeInput: () => undefined,
            type: async () => true,
            onChange: (_id, revision) => changes.push(revision)
        })
        service.subscribe('s1')
        await service.getConversation('s1')
        changes.length = 0
        screenNow = REPORTED
        count = 2
        const opened = await service.getConversation('s1')
        expect(opened.prompt).not.toBeNull()
        expect(changes, 'the views hear of the menu').toEqual([opened.revision])
        screenNow = ['CHOSE: accept', '─'.repeat(40), '❯ ', '─'.repeat(40)]
        count = 3
        const closed = await service.getConversation('s1')
        expect(closed.prompt).toBeNull()
        expect(changes.at(-1), 'and of its going').toBe(closed.revision)
        expect(closed.revision).toBeGreaterThan(opened.revision)
        service.unsubscribe('s1')
    })
})
