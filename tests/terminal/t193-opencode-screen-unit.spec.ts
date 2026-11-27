import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { opencodeAwaitsSecondEsc, screenShowsBusy } from '../../src/main/screenLines'

/**
 * T193 — OpenCode screens, without Electron.
 *
 * fixtures/opencode holds a real opencode 1.18.15 session (recorded 2026-11-27 at 110×36 in a scratch data
 * folder — XDG_DATA_HOME/XDG_STATE_HOME pointed at a temp dir, the person's store untouched — model Big
 * Pickle; the folder renamed `/private/tmp/oc-sandbox`). `.ansi` is the screen with its colours (the
 * composer hint is told apart by colour), `.txt` the same screen as text. `retrying` is from a first run
 * that hit the free model's limit.
 */

const COLS = 110
const ROWS = 36
const DIR = join(__dirname, 'fixtures', 'opencode')

async function mirrorOf(name: string, kind: 'ansi' | 'txt' = 'ansi'): Promise<TerminalMirror> {
    const events = new EventEmitter()
    const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
    events.emit('created', 's1', COLS, ROWS)
    const data = readFileSync(join(DIR, `opencode-1.18.15-${name}.${kind}`), 'utf8')
    events.emit('output', 's1', kind === 'txt' ? data.replace(/\n$/, '').split('\n').join('\r\n') : data)
    await mirror.flush('s1')
    return mirror
}

const rows = (name: string): string[] => readFileSync(join(DIR, `opencode-1.18.15-${name}.txt`), 'utf8').split('\n')

test.describe('T193 OpenCode screens', () => {
    for (const name of ['working', 'esc-again']) {
        test(`${name}: busy, no question, the API does not see a waiting prompt`, async () => {
            const mirror = await mirrorOf(name)
            expect(mirror.screenStatus('s1')).toEqual({ busy: true, question: null })
            expect(mirror.showsAwaitingInput('s1')).toBe(false)
            expect(mirror.asksQuestion('s1')).toBe(false)
        })
    }

    test('retrying a request is a turn still running', async () => {
        const mirror = await mirrorOf('retrying', 'txt')
        expect(mirror.showsBusy('s1')).toBe(true)
        expect(mirror.showsAwaitingInput('s1')).toBe(false)
    })

    for (const name of ['idle-home', 'typed-home', 'answered', 'interrupted']) {
        test(`${name}: neither busy nor waiting`, async () => {
            const mirror = await mirrorOf(name)
            expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: null })
            expect(mirror.showsAwaitingInput('s1')).toBe(false)
        })
    }

    test('question panel: waiting, with the question line, and no composer', async () => {
        const mirror = await mirrorOf('question')
        expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: 'Which colour do you prefer?' })
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
        expect(mirror.opencodeInput('s1')).toBeNull()
    })

    test('a permission prompt waits (herdr manifests/opencode.toml — not recorded here)', async () => {
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
        events.emit('created', 's1', COLS, ROWS)
        events.emit('output', 's1', ['  ┃  △ Permission required', '  ┃  ← Access external directory /etc', '  ┃', '  ┃  Allow once   Allow always   Reject'].join('\r\n'))
        await mirror.flush('s1')
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
    })

    test('the composer: its hint is no typed text, what was typed is', async () => {
        expect((await mirrorOf('idle-home')).opencodeInput('s1')).toEqual({ typed: '', typedRows: 0, suggestion: '' })
        expect((await mirrorOf('answered')).opencodeInput('s1')).toEqual({ typed: '', typedRows: 0, suggestion: '' })
        expect((await mirrorOf('working')).opencodeInput('s1')).toEqual({ typed: '', typedRows: 0, suggestion: '' })
        expect((await mirrorOf('typed-home')).opencodeInput('s1')).toEqual({ typed: 'hello there', typedRows: 1, suggestion: '' })
    })

    test('the composer hint is no typed text even drawn without colour (the text fallback)', async () => {
        expect((await mirrorOf('idle-home', 'txt')).opencodeInput('s1')?.typed).toBe('')
    })

    test('a toast boxed in ┃ is no composer', async () => {
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
        events.emit('created', 's1', COLS, ROWS)
        events.emit('output', 's1', ['                                 ┃ Model anthropic/x is not valid ┃', '                                 ┃                                ┃', 'a shell prompt $'].join('\r\n'))
        await mirror.flush('s1')
        expect(mirror.opencodeInput('s1')).toBeNull()
    })

    test('the busy row: the bar with esc interrupt as the last row, not a quoted one; a second Esc is awaited after the first', () => {
        expect(screenShowsBusy(rows('working'))).toBe(true)
        expect(screenShowsBusy(rows('answered'))).toBe(false)
        expect(screenShowsBusy(['     press esc interrupt to stop it (a sentence in an answer)'])).toBe(false)
        expect(screenShowsBusy(['   ⬝⬝ esc interrupt'])).toBe(false)
        // review: the same bar quoted in an answer above an idle footer is no work
        expect(screenShowsBusy(['  Codex said:', '   ⬝■■■■■■⬝  esc interrupt   tab agents', '', '› ', '  ? for shortcuts'])).toBe(false)
        expect(opencodeAwaitsSecondEsc(rows('working'))).toBe(false)
        expect(opencodeAwaitsSecondEsc(rows('esc-again'))).toBe(true)
        expect(opencodeAwaitsSecondEsc(['   ⬝■■■■■■⬝  esc again to interrupt', '  idle footer'])).toBe(false)
    })

    test('the question and permission words quoted in an answer, outside a ┃ panel, wait on nobody', async () => {
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
        events.emit('created', 's1', COLS, ROWS)
        events.emit('output', 's1', ['  OpenCode shows △ Permission required when a tool asks.', '  Its footer reads ↑↓ select  enter submit  esc dismiss.', '', '› ', '  ? for shortcuts'].join('\r\n'))
        await mirror.flush('s1')
        expect(mirror.showsAwaitingInput('s1')).toBe(false)
    })

    test('the composer without colour: a typed draft is typed, the hint is not', async () => {
        const draw = (line: string) => ['  ┃', `  ┃  ${line}`, '  ┃', '  ┃  Build · Mock Model OpenCode', `  ╹${'▀'.repeat(60)}`, '   ~/project     ctrl+p commands']
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
        events.emit('created', 's1', COLS, ROWS)
        events.emit('output', 's1', draw('fix the failing test').join('\r\n'))
        await mirror.flush('s1')
        expect(mirror.opencodeInput('s1')?.typed).toBe('fix the failing test')
        events.emit('output', 's1', '\x1b[2J\x1b[H' + draw('Ask anything... "Fix broken tests"').join('\r\n'))
        await mirror.flush('s1')
        expect(mirror.opencodeInput('s1')?.typed).toBe('')
    })

    test('the hint\'s words typed in plain colour, under a coloured model row, are typed text', async () => {
        const muted = (text: string) => `\x1b[38;5;8m${text}\x1b[m`
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
        events.emit('created', 's1', COLS, ROWS)
        events.emit('output', 's1', ['  ┃', '  ┃  Ask anything... "Explain this module"', '  ┃', `  ┃  Build ${muted('·')} Mock ${muted('OpenCode')}`, `  ╹${'▀'.repeat(60)}`].join('\r\n'))
        await mirror.flush('s1')
        expect(mirror.opencodeInput('s1')?.typed).toBe('Ask anything... "Explain this module"')
    })

    test('the terminal title OpenCode sets is kept', async () => {
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
        events.emit('created', 's1', COLS, ROWS)
        expect(mirror.title('s1')).toBeNull()
        events.emit('output', 's1', '\x1b]0;OpenCode\x07')
        await mirror.flush('s1')
        expect(mirror.title('s1')).toBe('OpenCode')
        // recorded: the title OpenCode set once the session had one
        events.emit('output', 's1', '\x1b]0;OC | Counting folder entries with ls -1\x07')
        await mirror.flush('s1')
        expect(mirror.title('s1')).toBe('OC | Counting folder entries with ls -1')
    })
})
