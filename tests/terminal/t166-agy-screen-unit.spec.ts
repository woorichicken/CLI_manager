import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { screenShowsBusy } from '../../src/main/screenLines'

/**
 * T166 — Antigravity CLI (agy) screens, without Electron.
 *
 * The screens in fixtures/agy are copies of a real agy 1.5.16 session (recorded 2026-11-25 at
 * 110×36 in a scratch folder, Gemini 3.8 Flash low; the account and the folder are masked). Before
 * this, agy's working footer `esc to cancel` matched the Claude dialog pattern «Esc to cancel»: a
 * working agy read as waiting on the person, and the Control API refused its input (backlog 11-20 —
 * `clim open --agent agy` exited 3 while the screen showed work).
 */

const COLS = 110
const ROWS = 36

function fixture(name: string): string[] {
    return readFileSync(join(__dirname, 'fixtures', 'agy', `agy-1.5.16-${name}.txt`), 'utf8').replace(/\n$/, '').split('\n')
}

async function mirrorShowing(rows: string[]): Promise<TerminalMirror> {
    const events = new EventEmitter()
    const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
    events.emit('created', 's1', COLS, ROWS)
    events.emit('output', 's1', rows.join('\r\n'))
    await mirror.flush('s1')
    return mirror
}

test.describe('T166 agy screens', () => {
    for (const name of ['working-generating', 'working-running']) {
        test(`${name}: busy, no question, the API does not see a waiting prompt`, async () => {
            const mirror = await mirrorShowing(fixture(name))
            expect(mirror.screenStatus('s1')).toEqual({ busy: true, question: null })
            expect(mirror.showsBusy('s1')).toBe(true)
            expect(mirror.showsAwaitingInput('s1')).toBe(false)
            expect(mirror.asksQuestion('s1')).toBe(false)
        })
    }

    for (const name of ['idle', 'idle-after-question']) {
        test(`${name}: neither busy nor waiting`, async () => {
            const mirror = await mirrorShowing(fixture(name))
            expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: null })
            expect(mirror.showsAwaitingInput('s1')).toBe(false)
        })
    }

    test('question dialog: waiting, with the question line', async () => {
        const mirror = await mirrorShowing(fixture('question'))
        expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: 'Question 1/1: Which color do you like?' })
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
    })

    test('permission dialog: waiting', async () => {
        const mirror = await mirrorShowing(fixture('permission'))
        const status = mirror.screenStatus('s1')
        expect(status.busy).toBe(false)
        expect(status.question).toBe('Run this command?')
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
    })

    test('folder trust dialog: waiting', async () => {
        const mirror = await mirrorShowing(fixture('trust'))
        expect(mirror.screenStatus('s1')).toEqual({ busy: false, question: 'Do you trust the contents of this project?' })
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
    })

    test('the spinner alone, or the footer alone, is not work', () => {
        const working = fixture('working-generating')
        expect(screenShowsBusy(working)).toBe(true)
        // a shell with a braille progress row (npm) and no agy footer
        expect(screenShowsBusy(['$ pnpm install', '⠋ Resolving packages...'])).toBe(false)
        // a dialog keeps the footer but draws no spinner
        expect(screenShowsBusy(fixture('permission'))).toBe(false)
        // Claude's capitalised hint mid-row is not agy's footer
        expect(screenShowsBusy(['⡿ x', 'Enter to select · ↑/↓ to navigate · Esc to cancel'])).toBe(false)
    })

    test("agy's slash menu is no question", async () => {
        const rows = [...fixture('idle').slice(0, -3), '> /', '  /help   Show help', '  ↑/↓ Navigate · enter Select · tab Complete', '? for shortcuts']
        const mirror = await mirrorShowing(rows)
        expect(mirror.screenStatus('s1').question).toBeNull()
    })
})
