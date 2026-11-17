import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { ConversationService, chatSuggestion, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'

/**
 * T142 — the Chat box shows Claude's dim next-prompt suggestion (ba2ae0cb, spec 2026-11-16).
 *
 *  - `chatSuggestion`: the conditions the snapshot carries it under (empty box · typed · clipped ·
 *    working · asking · Codex · blank)
 *  - through a real TerminalMirror and ConversationService: the row chat-mock `--suggest` draws (the
 *    cursor inverse on the first letter, the rest dim — Claude Code's own drawing, T88 edge-audit 2)
 *    reaches `snapshot.suggestion`; typed text, a clipped box, a working turn and Codex do not
 *  - a changed or gone suggestion bumps the revision, so a subscribed view fetches it
 */

const COLS = 100
const ROWS = 24
const RULE = '─'.repeat(COLS - 2)

/** chat-mock's suggestionRow(): what Claude Code 2.1.3xx writes for a suggestion in the empty box */
const suggestionRow = (text: string): string => `\x1b[7m${text[0]}\x1b[27m\x1b[2m${text.slice(1)}\x1b[22m`

function screen(boxRow: string, above: string[] = []): string {
    return [' ▐▛███▜▌   Claude Code (mock)', '', '⏺ Done.', ...above, RULE, `❯ ${boxRow}`, RULE, '  ⏵⏵ accept edits on'].join('\r\n')
}

function fakeTerminals() {
    const events = new EventEmitter()
    return { events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true }
}

async function mirrorShowing(output: string): Promise<{ mirror: TerminalMirror; show(next: string): Promise<void> }> {
    const terminals = fakeTerminals()
    const mirror = new TerminalMirror(terminals as never)
    terminals.events.emit('created', 's1', COLS, ROWS)
    const show = async (next: string): Promise<void> => {
        // Home + erase below, as the mock redraws
        terminals.events.emit('output', 's1', `\x1b[H\x1b[J${next}`)
        await mirror.flush('s1')
    }
    await show(output)
    return { mirror, show }
}

function deps(mirror: TerminalMirror, tool: 'claude' | 'codex', changes: number[] = []): ConversationServiceDeps {
    return {
        session: () => ({ cwd: '/w', cliToolName: tool }),
        reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
        mirror,
        hasTerminal: () => true,
        writeInput: () => undefined,
        type: async () => true,
        onChange: (_id, revision) => changes.push(revision),
        idleKeepMs: 50
    }
}

test.describe('T142 chatSuggestion — when the snapshot carries it', () => {
    const idle = { agent: 'claude' as const, working: false, asking: false }
    const rows: Array<[string, Parameters<typeof chatSuggestion>[0], Parameters<typeof chatSuggestion>[1], string | null]> = [
        ['an empty box with a suggestion', { typed: '', suggestion: 'run the tests' }, idle, 'run the tests'],
        ['spaces around it are trimmed', { typed: '', suggestion: '  run the tests ' }, idle, 'run the tests'],
        ['typed text in the box', { typed: 'my own words', suggestion: 'run the tests' }, idle, null],
        ['typed spaces only count as empty', { typed: '   ', suggestion: 'run the tests' }, idle, 'run the tests'],
        ['only the bottom rule on screen (clipped)', { typed: '', suggestion: '', clipped: true }, idle, null],
        ['clipped even with a suggestion read', { typed: '', suggestion: 'run the tests', clipped: true }, idle, null],
        ['no suggestion', { typed: '', suggestion: '' }, idle, null],
        ['blank suggestion', { typed: '', suggestion: '   ' }, idle, null],
        ['no input box', null, idle, null],
        ['the agent works', { typed: '', suggestion: 'run the tests' }, { ...idle, working: true }, null],
        ['a question on screen', { typed: '', suggestion: 'run the tests' }, { ...idle, asking: true }, null],
        ['Codex', { typed: '', suggestion: 'run the tests' }, { ...idle, agent: 'codex' }, null],
        ['no agent', { typed: '', suggestion: 'run the tests' }, { ...idle, agent: null }, null]
    ]
    for (const [name, box, state, expected] of rows) {
        test(name, () => {
            expect(chatSuggestion(box, state)).toBe(expected)
        })
    }
})

test.describe('T142 the snapshot through a real mirror', () => {
    test('chat-mock’s suggestion row reaches snapshot.suggestion; the mirror reads it as a suggestion, not typed', async () => {
        const { mirror } = await mirrorShowing(screen(suggestionRow('run the tests and show me what failed')))
        expect(mirror.inputBox('s1')).toMatchObject({ typed: '', suggestion: 'run the tests and show me what failed' })
        const service = new ConversationService(deps(mirror, 'claude'))
        const snapshot = await service.getConversation('s1')
        expect(snapshot.suggestion).toBe('run the tests and show me what failed')
    })

    test('typed text, a working turn, a clipped box, Codex: no suggestion', async () => {
        const typed = await mirrorShowing(screen('my own words'))
        expect((await new ConversationService(deps(typed.mirror, 'claude')).getConversation('s1')).suggestion).toBeNull()

        const working = await mirrorShowing(screen(suggestionRow('run the tests'), ['✻ Working… (esc to interrupt)']))
        const busy = await new ConversationService(deps(working.mirror, 'claude')).getConversation('s1')
        expect(busy.working).toBe(true)
        expect(busy.suggestion).toBeNull()

        // a draft taller than the screen: only the bottom rule is left
        const clipped = await mirrorShowing([...Array.from({ length: ROWS - 2 }, (_, i) => `draft line ${i}`), RULE, '  ⏵⏵ accept edits on'].join('\r\n'))
        expect(clipped.mirror.inputBox('s1')?.clipped).toBe(true)
        expect((await new ConversationService(deps(clipped.mirror, 'claude')).getConversation('s1')).suggestion).toBeNull()

        const codex = await mirrorShowing(screen(suggestionRow('run the tests')))
        expect((await new ConversationService(deps(codex.mirror, 'codex')).getConversation('s1')).suggestion).toBeNull()
    })

    test('a changed or gone suggestion bumps the revision a subscribed view waits on', async () => {
        const { mirror, show } = await mirrorShowing(screen(suggestionRow('run the tests')))
        const changes: number[] = []
        const service = new ConversationService(deps(mirror, 'claude', changes))
        service.subscribe('s1')
        try {
            const first = await service.getConversation('s1')
            expect(first.suggestion).toBe('run the tests')

            await show(screen(suggestionRow('check the logs')))
            const second = await service.getConversation('s1')
            expect(second.suggestion).toBe('check the logs')
            expect(second.revision).toBeGreaterThan(first.revision)

            // typed at the terminal: the suggestion goes
            await show(screen('c'))
            const third = await service.getConversation('s1')
            expect(third.suggestion).toBeNull()
            expect(third.revision).toBeGreaterThan(second.revision)
            expect(changes.length).toBeGreaterThanOrEqual(2)

            // nothing changed on screen but the output count: no bump
            await show(screen('c'))
            const fourth = await service.getConversation('s1')
            expect(fourth.revision).toBe(third.revision)
        } finally {
            service.unsubscribe('s1')
        }
    })
})
