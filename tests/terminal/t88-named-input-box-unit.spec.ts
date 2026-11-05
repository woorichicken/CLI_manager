import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { ConversationService } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { isInputBoxRule, lastMeaningfulLine, screenSummary } from '../../src/main/screenLines'
import { readPrompt } from '../../src/main/promptScreen'

/**
 * T88 — a session renamed with /rename (phone-fixes-1105 A).
 *
 * Claude Code then writes the session's name into its input box's top rule:
 * `──────── my-session ─`. The rule test used to want only dashes, so the box
 * was read from an earlier rule in the transcript and the answer above it
 * counted as typed text: every Chat send was refused with input_busy.
 *
 * The screens are synthetic, shaped after a real mirror snapshot (2 of 62
 * sessions in the app were in this state); the snapshot itself holds a
 * conversation and is not committed.
 */

const COLS = 100
const ROWS = 24

/** The top rule as Claude Code draws it for a named session: dashes, the name, one dash. */
function namedRule(name: string, cols = COLS): string {
    const tail = ` ${name} ─`
    // Korean letters take two cells; the rule fills the row in cells, not characters.
    const width = [...tail].reduce((sum, ch) => sum + (/[가-힣]/.test(ch) ? 2 : 1), 0)
    return '─'.repeat(cols - width) + tail
}

const PLAIN = '─'.repeat(COLS)

function namedIdleScreen(name: string, typed = ''): string[] {
    return [
        '⏺ 정리했습니다.',
        '',
        // A markdown rule in the answer: a plain run of dashes, shorter than the screen.
        '  ' + '─'.repeat(40),
        '',
        '  ─── 결과 ─',
        '  - 시험 3건 통과',
        '',
        namedRule(name),
        `❯ ${typed}`,
        PLAIN,
        '  ⏵⏵ accept edits on (shift+tab to cycle)'
    ]
}

function fakeTerminals() {
    const events = new EventEmitter()
    return { events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true }
}

async function mirrorShowing(rows: string[]): Promise<TerminalMirror> {
    const terminals = fakeTerminals()
    const mirror = new TerminalMirror(terminals as never)
    terminals.events.emit('created', 's1', COLS, ROWS)
    terminals.events.emit('output', 's1', rows.join('\r\n'))
    await mirror.flush('s1')
    return mirror
}

function conversations(mirror: TerminalMirror) {
    const sent: string[] = []
    const service = new ConversationService({
        session: () => ({ cwd: '/w', cliSessionId: undefined, cliToolName: 'claude' }),
        reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
        mirror,
        hasTerminal: () => true,
        writeInput: () => undefined,
        type: async (_id, text) => (sent.push(text), true),
        onChange: () => undefined
    })
    return { service, sent }
}

test.describe('T88 the rule test', () => {
    test('a plain rule and a rule carrying the session name are input box rules', () => {
        expect(isInputBoxRule(PLAIN)).toBe(true)
        expect(isInputBoxRule(namedRule('클매-챗뷰-폰-v1.26.0'))).toBe(true)
        expect(isInputBoxRule(namedRule('fix login flow'))).toBe(true)
        // the shape from the real snapshot, cut down
        expect(isInputBoxRule('──────────────────────────────────────── 클매-챗뷰-폰-v1.26.0 ─')).toBe(true)
    })

    test('headings and labelled dividers in an answer are not', () => {
        expect(isInputBoxRule('─── 결과 ─')).toBe(false)
        expect(isInputBoxRule('──────────── 결과 ────────────')).toBe(false)
        expect(isInputBoxRule('─'.repeat(30) + ' a ' + '─'.repeat(30))).toBe(false)
        expect(isInputBoxRule('⎿ ' + '─'.repeat(60))).toBe(false)
        expect(isInputBoxRule('─'.repeat(19))).toBe(false)
        expect(isInputBoxRule('─'.repeat(40) + ' name')).toBe(false)
        expect(isInputBoxRule('├' + '─'.repeat(40) + '┤')).toBe(false)
    })
})

test.describe('T88 a named session with an empty input box', () => {
    test('the mirror reads the box under the named rule: nothing typed', async () => {
        const mirror = await mirrorShowing(namedIdleScreen('클매-챗뷰-폰-v1.26.0'))
        expect(mirror.inputBox('s1')?.typed.trim()).toBe('')
        expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: null })
        expect(mirror.showsAwaitingInput('s1')).toBe(false)
    })

    test('Chat send is not refused with input_busy, and the text goes to the terminal', async () => {
        const mirror = await mirrorShowing(namedIdleScreen('클매-챗뷰-폰-v1.26.0'))
        const { service, sent } = conversations(mirror)
        const result = await service.send('s1', 'hello')
        expect(result).toEqual({ status: 'sent' })
        expect(sent).toEqual(['hello'])
    })

    test('text typed in the named box is still seen, and still refuses a send', async () => {
        const mirror = await mirrorShowing(namedIdleScreen('my-session', 'half typed'))
        expect(mirror.inputBox('s1')?.typed.trim()).toBe('half typed')
        const { service, sent } = conversations(mirror)
        expect(await service.send('s1', 'hello')).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(sent).toEqual([])
    })

    test('the one-line summary and the menu reader stop at the named box', () => {
        const rows = namedIdleScreen('my-session')
        expect(lastMeaningfulLine(rows)).toBe('- 시험 3건 통과')
        expect(screenSummary(rows)).toEqual({ text: '', isRecap: false })
        expect(readPrompt(rows, 'claude')).toBeNull()
    })
})
