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

async function mirrorShowing(rows: string[], cols = COLS): Promise<TerminalMirror> {
    const terminals = fakeTerminals()
    const mirror = new TerminalMirror(terminals as never)
    terminals.events.emit('created', 's1', cols, ROWS)
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

test.describe('T88 the rule test (ovis BOX_LABELED_RULE_RE)', () => {
    test('a plain rule, a named session rule and OmO\'s working rule are input box edges', () => {
        expect(isInputBoxRule(PLAIN)).toBe(true)
        expect(isInputBoxRule(namedRule('클매-챗뷰-폰-v1.26.0'))).toBe(true)
        expect(isInputBoxRule(namedRule('fix login flow'))).toBe(true)
        // the shape from the real snapshot, cut down
        expect(isInputBoxRule('──────────────────────────────────────── 클매-챗뷰-폰-v1.26.0 ─')).toBe(true)
        expect(isInputBoxRule('── • Running eval (7s • esc to interrupt) ───')).toBe(true)
    })

    test('rows that only start or end with dashes are not', () => {
        expect(isInputBoxRule('⎿ ' + '─'.repeat(60))).toBe(false)
        expect(isInputBoxRule('─'.repeat(7))).toBe(false)
        expect(isInputBoxRule('─'.repeat(40) + ' name')).toBe(false)
        expect(isInputBoxRule('├' + '─'.repeat(40) + '┤')).toBe(false)
        expect(isInputBoxRule('─ a')).toBe(false)
    })

    test('a dialog\'s top edge stays a full rule: a labelled rule in it is not taken for one', () => {
        // promptScreen reads the rows between the dialog's edge and its question as context
        const rows = [
            '⏺ done',
            '─'.repeat(COLS),
            ' Bash command',
            '── 결과 ─',
            '   rm -rf build',
            ' Do you want to proceed?',
            ' ❯ 1. Yes',
            '   2. No'
        ]
        expect(readPrompt(rows, 'claude')?.context).toEqual(['Bash command', '── 결과 ─', 'rm -rf build'])
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

test.describe('T88 a draft taller than the screen (only the bottom rule shows)', () => {
    const clippedScreen = ['  more of the draft', '  its last line', PLAIN, '  ⏵⏵ accept edits on (shift+tab to cycle)']

    test('Claude: the box is clipped and a send is refused', async () => {
        const mirror = await mirrorShowing(clippedScreen)
        expect(mirror.inputBox('s1')).toEqual({ typed: '', suggestion: '', clipped: true })
        const { service, sent } = conversations(mirror)
        expect(await service.send('s1', 'hello')).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(sent).toEqual([])
    })

    test('Codex: a lone rule is its output, not a box — the send goes', async () => {
        const mirror = await mirrorShowing(['─ Worked for 1m 2s ' + '─'.repeat(60), '', '› '])
        const sent: string[] = []
        const service = new ConversationService({
            session: () => ({ cwd: '/w', cliSessionId: undefined, cliToolName: 'codex' }),
            reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
            mirror,
            hasTerminal: () => true,
            writeInput: () => undefined,
            type: async (_id, text) => (sent.push(text), true),
            onChange: () => undefined
        })
        expect(await service.send('s1', 'hello')).toEqual({ status: 'sent' })
        expect(sent).toEqual(['hello'])
    })
})

/**
 * edge-audit 1·2·14 (11-05): what else sits in an empty Claude box without being typed.
 * Shapes from ovis server/claude-input.ts and its tests (MIT); the escapes are what Claude Code draws.
 */
const DIM = (text: string): string => `\x1b[2m${text}\x1b[22m`
const INVERSE = (text: string): string => `\x1b[7m${text}\x1b[27m`
const IDE = (text: string): string => `\x1b[38;5;75m${text}\x1b[39m`
const box = (row: string, rule = PLAIN): string[] => ['\x1b[32m⏺\x1b[39m done', '', rule, row, rule, '  ? for shortcuts']

test.describe('T88 the IDE pill after ❯ (edge-audit 1, ovis CLAUDE_IDE_PILL_RE)', () => {
    test('a pill alone is an empty box', async () => {
        for (const pill of ['[⧉ In src/foo.ts]', '[⧉ 3 lines selected]']) {
            const mirror = await mirrorShowing(box(`❯ ${IDE(pill)} `))
            expect(mirror.inputBox('s1')).toMatchObject({ typed: '' })
            expect(await conversations(mirror).service.send('s1', 'hello')).toEqual({ status: 'sent' })
        }
    })

    test('text typed after the pill is still typed, without the pill', async () => {
        const mirror = await mirrorShowing(box(`❯ ${IDE('[⧉ In src/foo.ts]')} fix this`))
        expect(mirror.inputBox('s1')?.typed).toBe('fix this')
    })

    test('a grey suggestion after the pill is a suggestion', async () => {
        const mirror = await mirrorShowing(box(`❯ ${IDE('[⧉ In src/foo.ts]')} ${DIM('run the tests')}`))
        expect(mirror.inputBox('s1')).toMatchObject({ typed: '', suggestion: 'run the tests' })
    })
})

test.describe('T88 Claude\'s cursor on a suggestion\'s first letter (edge-audit 2)', () => {
    test('an inverse first letter followed by grey text is the suggestion, not typed', async () => {
        const mirror = await mirrorShowing(box(`❯ ${INVERSE('r')}${DIM('un the tests')}`))
        expect(mirror.inputBox('s1')).toMatchObject({ typed: '', suggestion: 'run the tests' })
        expect(await conversations(mirror).service.send('s1', 'hello')).toEqual({ status: 'sent' })
    })

    test('a cursor over a typed letter has nothing grey after it: typed', async () => {
        const mirror = await mirrorShowing(box(`❯ ${INVERSE('r')}un`))
        expect(mirror.inputBox('s1')?.typed).toBe('run')
    })

    test('typed text with the cursor at its end stays typed', async () => {
        const mirror = await mirrorShowing(box(`❯ half typed${INVERSE(' ')}`))
        expect(mirror.inputBox('s1')?.typed).toBe('half typed')
    })
})

test.describe('T88 heavy rules, a narrow pane, the NO_COLOR tip (edge-audit 14 a·b)', () => {
    test('a box between ━ rules is read', async () => {
        const mirror = await mirrorShowing(box('❯ half typed', '━'.repeat(COLS)))
        expect(mirror.inputBox('s1')?.typed).toBe('half typed')
    })

    test('a pane narrower than 20 columns still has a box (ovis SOLID_RULE_RE: 8 or more)', async () => {
        const narrow = 12
        const mirror = await mirrorShowing(['─'.repeat(narrow), '❯ hi', '─'.repeat(narrow)], narrow)
        expect(mirror.inputBox('s1')?.typed).toBe('hi')
        expect(isInputBoxRule('─'.repeat(8))).toBe(true)
        expect(isInputBoxRule('─'.repeat(7))).toBe(false)
    })

    test('under NO_COLOR the new-session tip is not typed text', async () => {
        const mirror = await mirrorShowing(['Claude Code', '', PLAIN, '❯ Try "how does <filepath> work?"', PLAIN, '  ? for shortcuts'])
        expect(mirror.inputBox('s1')?.typed).toBe('')
        expect(await conversations(mirror).service.send('s1', 'hello')).toEqual({ status: 'sent' })
    })

    test('the same words on a screen with color are what someone typed', async () => {
        const mirror = await mirrorShowing(['\x1b[38;5;174mClaude Code\x1b[39m', '', PLAIN, '❯ Try "how does <filepath> work?"', PLAIN])
        expect(mirror.inputBox('s1')?.typed).toBe('Try "how does <filepath> work?"')
    })

    test('the tip is the box\'s whole one row: more words after it are typed', async () => {
        const mirror = await mirrorShowing(['Claude Code', '', PLAIN, '❯ Try "how does <filepath> work?" now', PLAIN])
        expect(mirror.inputBox('s1')?.typed).toBe('Try "how does <filepath> work?" now')
    })
})

/**
 * phone-fixes C-1: a send refused for text left in the Mac's input box carries that text, and a
 * send with `clearDraft` empties the box first — Ctrl+K then Ctrl+U, the row after and before the
 * cursor (ovis claude-input.ts CLAUDE_CLEAR_INPUT_KEYS · claudeClearableDraft, MIT) — when the box
 * still holds exactly what the person agreed to clear.
 */
test.describe('T88 clear and send (phone-fixes C-1)', () => {
    const screenWith = (row: string): string[] => ['⏺ done', '', PLAIN, row, PLAIN, '  ? for shortcuts']

    /** A terminal whose screen is redrawn with an empty box once Ctrl+U arrives, as Claude does. */
    async function clearingSession(row: string, opts: { clears?: boolean } = {}) {
        const terminals = fakeTerminals()
        const mirror = new TerminalMirror(terminals as never)
        terminals.events.emit('created', 's1', COLS, ROWS)
        terminals.events.emit('output', 's1', screenWith(row).join('\r\n'))
        await mirror.flush('s1')
        const writes: string[] = []
        const sent: string[] = []
        const service = new ConversationService({
            session: () => ({ cwd: '/w', cliSessionId: undefined, cliToolName: 'claude' }),
            reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
            mirror,
            hasTerminal: () => true,
            writeInput: (_id, data) => {
                writes.push(data)
                if (data === '\x15' && opts.clears !== false) terminals.events.emit('output', 's1', '\x1b[2J\x1b[H' + screenWith('❯ ').join('\r\n'))
            },
            type: async (_id, text) => (sent.push(text), true),
            onChange: () => undefined
        })
        return { service, writes, sent }
    }

    test('the refusal carries a one-row draft', async () => {
        const { service } = await clearingSession('❯ half typed')
        expect(await service.send('s1', 'hello')).toMatchObject({ status: 'rejected', reason: 'input_busy', draft: 'half typed' })
    })

    test('no draft to clear for bash mode, a pasted placeholder, or a box clipped by the screen', async () => {
        for (const row of ['! echo unfinished', '❯ [Pasted text #1 +12 lines]']) {
            const { service } = await clearingSession(row)
            const result = await service.send('s1', 'hello')
            expect(result).toMatchObject({ status: 'rejected', reason: 'input_busy' })
            expect(result).not.toHaveProperty('draft')
        }
        const mirror = await mirrorShowing(['  more of the draft', PLAIN, '  footer'])
        const result = await conversations(mirror).service.send('s1', 'hello')
        expect(result).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(result).not.toHaveProperty('draft')
    })

    test('a draft over two rows is not offered: Ctrl+K and Ctrl+U edit one row', async () => {
        const terminals = fakeTerminals()
        const mirror = new TerminalMirror(terminals as never)
        terminals.events.emit('created', 's1', COLS, ROWS)
        terminals.events.emit('output', 's1', ['⏺ done', PLAIN, '❯ first line', '  second line', PLAIN].join('\r\n'))
        await mirror.flush('s1')
        const result = await conversations(mirror).service.send('s1', 'hello')
        expect(result).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(result).not.toHaveProperty('draft')
    })

    test('clearDraft with the same text: Ctrl+K, Ctrl+U, then the message goes', async () => {
        const { service, writes, sent } = await clearingSession('❯ half typed')
        expect(await service.send('s1', 'hello', undefined, { clearDraft: 'half typed' })).toEqual({ status: 'sent' })
        expect(writes).toEqual(['\x0b', '\x15'])
        expect(sent).toEqual(['hello'])
    })

    test('clearDraft when the box now holds something else: nothing is cleared, the new text comes back', async () => {
        const { service, writes, sent } = await clearingSession('❯ half typed and more')
        expect(await service.send('s1', 'hello', undefined, { clearDraft: 'half typed' })).toMatchObject({ status: 'rejected', reason: 'input_busy', draft: 'half typed and more' })
        expect(writes).toEqual([])
        expect(sent).toEqual([])
    })

    test('the box does not empty: refused, nothing sent', async () => {
        const { service, writes, sent } = await clearingSession('❯ half typed', { clears: false })
        expect(await service.send('s1', 'hello', undefined, { clearDraft: 'half typed' })).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(writes).toEqual(['\x0b', '\x15'])
        expect(sent).toEqual([])
    })
})

/**
 * 4b9cb0c2 (people's decision 11-05): switching Chat ↔ Terminal carries what was being written.
 * Chat → Terminal: the chat's unsent text goes into Claude's box without Enter — never over text
 * already there. Terminal → Chat: a one-row draft moves to the chat and the box empties; more rows
 * stay where they are (the chat only says so). Claude sessions only.
 */
test.describe('T88 the draft follows the view (4b9cb0c2)', () => {
    const screenWith = (row: string): string[] => ['⏺ done', '', PLAIN, row, PLAIN, '  ? for shortcuts']

    async function session(row: string, opts: { agent?: string; clears?: boolean; lines?: string[] } = {}) {
        const terminals = fakeTerminals()
        const mirror = new TerminalMirror(terminals as never)
        terminals.events.emit('created', 's1', COLS, ROWS)
        terminals.events.emit('output', 's1', (opts.lines ?? screenWith(row)).join('\r\n'))
        await mirror.flush('s1')
        const writes: string[] = []
        const service = new ConversationService({
            session: () => ({ cwd: '/w', cliSessionId: undefined, cliToolName: opts.agent ?? 'claude' }),
            reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
            mirror,
            hasTerminal: () => true,
            writeInput: (_id, data) => {
                writes.push(data)
                if (data === '\x15' && opts.clears !== false) terminals.events.emit('output', 's1', '\x1b[2J\x1b[H' + screenWith('❯ ').join('\r\n'))
            },
            type: async () => true,
            onChange: () => undefined
        })
        return { service, writes }
    }

    test('Chat → Terminal: an empty box gets the text, no Enter', async () => {
        const { service, writes } = await session('❯ ')
        expect(await service.placeDraftInTerminal('s1', 'half a thought')).toEqual({ status: 'placed' })
        expect(writes).toEqual(['half a thought'])
    })

    test('Chat → Terminal: several lines go as one paste, so no line is sent on its own', async () => {
        const { service, writes } = await session('❯ ')
        expect(await service.placeDraftInTerminal('s1', 'one\ntwo')).toEqual({ status: 'placed' })
        expect(writes).toEqual(['\x1b[200~one\ntwo\x1b[201~'])
    })

    test('Chat → Terminal: text already in the box is never written over', async () => {
        const { service, writes } = await session('❯ typed at the Mac')
        expect(await service.placeDraftInTerminal('s1', 'from chat')).toMatchObject({ status: 'busy', draft: 'typed at the Mac' })
        expect(writes).toEqual([])
    })

    test('Chat → Terminal: a question on screen takes no text', async () => {
        const { service, writes } = await session('', { lines: ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'] })
        expect(await service.placeDraftInTerminal('s1', 'from chat')).toMatchObject({ status: 'refused' })
        expect(writes).toEqual([])
    })

    test('Terminal → Chat: a one-row draft moves and the box empties', async () => {
        const { service, writes } = await session('❯ left at the mac')
        expect(await service.takeTerminalDraft('s1')).toEqual({ status: 'moved', text: 'left at the mac' })
        expect(writes).toEqual(['\x0b', '\x15'])
    })

    test('Terminal → Chat: several rows stay in the terminal, and the chat is told', async () => {
        const { service, writes } = await session('', { lines: ['⏺ done', PLAIN, '❯ first line', '  second line', PLAIN] })
        expect(await service.takeTerminalDraft('s1')).toEqual({ status: 'left', reason: 'several_lines' })
        expect(writes).toEqual([])
    })

    test('Terminal → Chat: an empty box has nothing to move', async () => {
        const { service, writes } = await session('❯ ')
        expect(await service.takeTerminalDraft('s1')).toEqual({ status: 'empty' })
        expect(writes).toEqual([])
    })

    test('Codex: nothing is typed or taken — the chat only says so', async () => {
        const { service, writes } = await session('❯ typed', { agent: 'codex' })
        expect(await service.placeDraftInTerminal('s1', 'from chat')).toEqual({ status: 'unsupported' })
        expect(await service.takeTerminalDraft('s1')).toEqual({ status: 'unsupported' })
        expect(writes).toEqual([])
    })
})
