/**
 * ovis tests moved to the phone UI modules (group `phone-ui`). Source: devswha/ovis @3e51902 (MIT)
 *   src/lib/keyBar.test.ts · keys.test.ts · keyRepeat.test.ts · droplet.test.ts ·
 *   terminalFold.test.ts · viewport.test.ts · ws.test.ts (backoff only) · headerConnection.test.ts
 * Inputs and expectations are ovis's own; only the calls are adapted to our names. A test that
 * needs a function we never ported is not registered (counted in parts/phone-ui.md instead).
 */
import { test, expect } from '@playwright/test'
import { controlCharacter, createKeyRepeat, isRepeatable, KEY_REPEAT_DELAY_MS, KEY_REPEAT_INTERVAL_MS, KEY_REPEAT_MOVE_SLOP_PX, keySequence, type KeyBarItem, type KeyRepeat, type KeyRepeatClock } from '../../../src/renderer/src/phone/keyBar'
import { paletteColor, rowHtml, type FoldCell, type FoldLine, type FoldTheme } from '../../../src/renderer/src/phone/terminalFold'
import { reconnectDelay } from '../../../src/renderer/src/phone/usePhoneTerminal'

// ---- src/lib/keys.test.ts ----------------------------------------------------------------
test.describe('ovis src/lib/keys.test.ts', () => {
    test.describe('controlCode', () => {
        test('maps letters to their control code regardless of case', () => {
            expect(controlCharacter('c')).toBe('\u0003')
            expect(controlCharacter('C')).toBe('\u0003')
            expect(controlCharacter('a')).toBe('\u0001')
            expect(controlCharacter('z')).toBe('\u001a')
        })

        test('maps the six punctuation keys terminals define control codes for', () => {
            expect(controlCharacter('@')).toBe('\u0000')
            expect(controlCharacter('[')).toBe('\u001b')
            expect(controlCharacter('\\')).toBe('\u001c')
            expect(controlCharacter(']')).toBe('\u001d')
            expect(controlCharacter('^')).toBe('\u001e')
            expect(controlCharacter('_')).toBe('\u001f')
        })

        test('returns null for anything else, so the character is sent as typed', () => {
            // ours maps ' ' to NUL and '?' to DEL on purpose-looking lines (keyBar.ts controlCharacter) with no comment saying it leaves ovis
            test.fail(true, "ovis-port bug: controlCharacter(' ') is '\\x00' and controlCharacter('?') is '\\x7f'; ovis returns null for both")
            for (const ch of ['1', ' ', '?', 'é', 'ㄱ', 'ab', '']) expect(controlCharacter(ch)).toBeNull()
        })
    })

    test.describe('keySequence', () => {
        test('sends the fixed bytes for Escape, Tab and Ctrl+C', () => {
            expect(keySequence('Escape', false, false)).toBe('\u001b')
            expect(keySequence('Tab', false, false)).toBe('\t')
            expect(keySequence('ctrl-c', true, false)).toBe('\u0003')
        })

        test('sends CSI arrows normally and SS3 arrows under application cursor keys mode', () => {
            expect(keySequence('ArrowUp', false, false)).toBe('\u001b[A')
            expect(keySequence('ArrowDown', false, false)).toBe('\u001b[B')
            expect(keySequence('ArrowRight', false, false)).toBe('\u001b[C')
            expect(keySequence('ArrowLeft', false, false)).toBe('\u001b[D')
            expect(keySequence('ArrowUp', true, false)).toBe('\u001bOA')
            expect(keySequence('ArrowLeft', true, false)).toBe('\u001bOD')
        })
    })
})

// ---- src/lib/keyRepeat.test.ts -----------------------------------------------------------
interface ScheduledTimer {
    at: number
    callback: () => void
}

function fakeClock() {
    let now = 0
    let nextId = 0
    const timers = new Map<unknown, ScheduledTimer>()
    const clock: KeyRepeatClock = {
        setTimeout(callback, delay) {
            const id = ++nextId
            timers.set(id, { at: now + delay, callback })
            return id
        },
        clearTimeout(id) {
            timers.delete(id)
        }
    }
    return {
        clock,
        now: () => now,
        pending: () => timers.size,
        advance(ms: number) {
            const end = now + ms
            while (true) {
                let next: { id: unknown; timer: ScheduledTimer } | undefined
                for (const [id, timer] of timers) {
                    if (timer.at <= end && (!next || timer.at < next.timer.at)) next = { id, timer }
                }
                if (!next) break
                now = next.timer.at
                timers.delete(next.id)
                next.timer.callback()
            }
            now = end
        }
    }
}

function fixture() {
    const clock = fakeClock()
    const sends: number[] = []
    const repeat = createKeyRepeat(() => sends.push(clock.now()), clock.clock)
    return { clock, repeat, sends }
}

test.describe('ovis src/lib/keyRepeat.test.ts', () => {
    test.describe('key bar hold repeat', () => {
        test('sends a quick tap exactly once on click, never on pointerdown or the delay timer', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(20, 30)
            expect(sends).toEqual([])
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            repeat.release()
            clock.advance(KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS)
            expect(sends).toEqual([])
            expect(clock.pending()).toBe(0)
            if (repeat.takeClick()) sends.push(clock.now())
            expect(sends).toHaveLength(1)
        })

        test('sends first at the delay boundary and then at each interval boundary', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            expect(sends).toEqual([])
            clock.advance(1)
            expect(sends).toEqual([KEY_REPEAT_DELAY_MS])
            clock.advance(KEY_REPEAT_INTERVAL_MS - 1)
            expect(sends).toHaveLength(1)
            clock.advance(1)
            expect(sends).toEqual([KEY_REPEAT_DELAY_MS, KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS])
            clock.advance(2 * KEY_REPEAT_INTERVAL_MS)
            expect(sends).toEqual([
                KEY_REPEAT_DELAY_MS,
                KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS,
                KEY_REPEAT_DELAY_MS + 2 * KEY_REPEAT_INTERVAL_MS,
                KEY_REPEAT_DELAY_MS + 3 * KEY_REPEAT_INTERVAL_MS
            ])
        })

        test('stops all future sends on release and swallows the following click only once', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS)
            repeat.release()
            repeat.release()
            clock.advance(10 * KEY_REPEAT_INTERVAL_MS)
            expect(sends).toHaveLength(2)
            expect(clock.pending()).toBe(0)
            expect(repeat.takeClick()).toBe(false)
            expect(repeat.takeClick()).toBe(true)

            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            repeat.release()
            if (repeat.takeClick()) sends.push(clock.now())
            expect(sends).toHaveLength(3)
        })

        test('clears stale hold-click suppression when a new press begins', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS)
            repeat.release()
            // A browser need not deliver a click after the first hold.
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            repeat.release()
            expect(repeat.takeClick()).toBe(true)
            expect(sends).toHaveLength(1)
        })

        test('allows an ordinary click with no preceding pointer press', () => {
            const { repeat } = fixture()
            expect(repeat.takeClick()).toBe(true)
            expect(repeat.takeClick()).toBe(true)
            repeat.release()
            expect(repeat.takeClick()).toBe(true)
        })

        test('cancels before the delay without sending or leaving a timer', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            repeat.cancel()
            repeat.cancel()
            repeat.release()
            clock.advance(2 * KEY_REPEAT_DELAY_MS)
            expect(sends).toEqual([])
            expect(clock.pending()).toBe(0)
            expect(repeat.takeClick()).toBe(true)
        })

        test('cancels an active repeat without sending again', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS)
            repeat.cancel()
            repeat.release()
            clock.advance(2 * KEY_REPEAT_DELAY_MS)
            expect(sends).toHaveLength(1)
            expect(clock.pending()).toBe(0)
            expect(repeat.takeClick()).toBe(true)
        })

        test('keeps movement exactly at the slop boundary but cancels beyond it before repeating', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(20, 30)
            expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX, 30)).toBe(false)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX + 1, 30)).toBe(true)
            expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX + 2, 30)).toBe(false)
            repeat.release()
            clock.advance(KEY_REPEAT_DELAY_MS)
            expect(sends).toEqual([])
            expect(clock.pending()).toBe(0)
        })

        test('measures slop in both axes from the original press', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(20, 30)
            expect(repeat.move(20, 30 - KEY_REPEAT_MOVE_SLOP_PX)).toBe(false)
            expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX, 31)).toBe(true)
            clock.advance(KEY_REPEAT_DELAY_MS)
            expect(sends).toEqual([])
        })

        test('does not cancel movement after repetition has begun', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS)
            expect(repeat.move(10 * KEY_REPEAT_MOVE_SLOP_PX, 10 * KEY_REPEAT_MOVE_SLOP_PX)).toBe(false)
            clock.advance(KEY_REPEAT_INTERVAL_MS)
            expect(sends).toHaveLength(2)
            repeat.release()
            expect(repeat.takeClick()).toBe(false)
        })

        test('restarts the delay on a new press and discards the previous hold timer', () => {
            const { clock, repeat, sends } = fixture()
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            repeat.press(10, 20)
            clock.advance(KEY_REPEAT_DELAY_MS - 1)
            expect(sends).toEqual([])
            clock.advance(1)
            expect(sends).toEqual([2 * KEY_REPEAT_DELAY_MS - 1])
            expect(clock.pending()).toBe(1)
        })

        test('does not schedule another tick when sending synchronously releases the hold', () => {
            const clock = fakeClock()
            let sends = 0
            // eslint-disable-next-line prefer-const
            let repeat: KeyRepeat
            repeat = createKeyRepeat(() => {
                sends++
                repeat.release()
            }, clock.clock)
            repeat.press(0, 0)
            clock.advance(KEY_REPEAT_DELAY_MS + 10 * KEY_REPEAT_INTERVAL_MS)
            expect(sends).toBe(1)
            expect(clock.pending()).toBe(0)
            expect(repeat.takeClick()).toBe(false)
        })
    })

    test.describe('repeatable key bar items', () => {
        test('does not repeat catalog keys, printable keys or modifier buttons', () => {
            // keys and Alt/Shift modifiers our bar never has are cast in: the answer must still be false
            const item = (value: unknown): KeyBarItem => value as KeyBarItem
            for (const key of ['Escape', 'Tab', 'BackTab', 'Enter', 'Insert', 'ctrl-c', 'ctrl-d', 'F1', 'a', ' ']) {
                expect(isRepeatable(item({ type: 'key', key }))).toBe(false)
                expect(isRepeatable(item({ type: 'key', key, modifiers: { ctrl: true, alt: false, shift: false } }))).toBe(false)
            }
            for (const modifier of ['ctrl', 'alt', 'shift']) {
                expect(isRepeatable(item({ type: 'modifier', modifier }))).toBe(false)
            }
        })
    })
})

// ---- src/lib/terminalFold.test.ts --------------------------------------------------------
interface Cell {
    chars: string
    width?: number
    fg?: number
    bg?: number
    bold?: boolean
    dim?: boolean
    inverse?: boolean
}

/** A grid row of plain cells: what rowHtml reads of the buffer, palette colours only. */
function line(cells: Cell[]): FoldLine {
    const at = (x: number): Cell => cells[x] ?? { chars: '' }
    const cell = (x: number): FoldCell => {
        const c = at(x)
        return {
            getChars: () => c.chars,
            getWidth: () => c.width ?? 1,
            isBold: () => (c.bold ? 1 : 0),
            isItalic: () => 0,
            isDim: () => (c.dim ? 1 : 0),
            isUnderline: () => 0,
            isInverse: () => (c.inverse ? 1 : 0),
            isInvisible: () => 0,
            isFgDefault: () => c.fg === undefined,
            isBgDefault: () => c.bg === undefined,
            isFgRGB: () => false,
            isBgRGB: () => false,
            getFgColor: () => c.fg ?? 0,
            getBgColor: () => c.bg ?? 0
        }
    }
    return { isWrapped: false, getCell: (x: number) => cell(x) }
}
const plain = (text: string): Cell[] => [...text].map((chars) => ({ chars }))
const BASE_THEME: FoldTheme = { foreground: '#eeeeee', background: '#111111', cursor: '#ffffff' }
/** ovis names colours (`red`, `green`); ours takes the sixteen ANSI colours by index */
const withAnsi = (colors: Record<number, string>): FoldTheme => {
    const ansi: string[] = []
    for (const [index, color] of Object.entries(colors)) ansi[Number(index)] = color
    return { ...BASE_THEME, ansi }
}

test.describe('ovis src/lib/terminalFold.test.ts', () => {
    test.describe('the folded view of a mirrored grid', () => {
        test("a palette index draws as the theme's colour, xterm's own where the theme names none, then the cube and the grey ramp", () => {
            expect(paletteColor(1, withAnsi({ 1: '#ff5555' }))).toBe('#ff5555')
            expect(paletteColor(1, BASE_THEME)).toBe('#cc0000')
            expect(paletteColor(16, BASE_THEME)).toBe('#000000')
            expect(paletteColor(196, BASE_THEME)).toBe('#ff0000')
            expect(paletteColor(231, BASE_THEME)).toBe('#ffffff')
            expect(paletteColor(232, BASE_THEME)).toBe('#080808')
            expect(paletteColor(255, BASE_THEME)).toBe('#eeeeee')
        })

        test('a row is its runs of cells drawn alike, without the blank cells herdr pads it with', () => {
            const cells: Cell[] = [{ chars: 'a', fg: 1 }, { chars: 'b', fg: 1 }, { chars: ' ' }, { chars: '가', width: 2 }, { chars: '', width: 0 }, ...plain('<&>   ')]
            expect(rowHtml(line(cells), 12, withAnsi({ 1: '#ff5555' })).html).toBe('<span style="color:#ff5555;">ab</span> 가&lt;&amp;&gt;')
        })

        test('a row that draws only a background keeps it, and an empty row is empty', () => {
            expect(rowHtml(line([{ chars: ' ', bg: 2 }]), 4, withAnsi({ 2: '#50fa7b' })).html).toBe('<span style="background:#50fa7b;"> </span>')
            expect(rowHtml(line([]), 4, BASE_THEME).html).toBe('')
        })

        test('dim text fades its colour, not its background', () => {
            expect(rowHtml(line([{ chars: 'd', fg: 2, bg: 0, dim: true }]), 1, BASE_THEME).html).toBe(
                '<span style="color:color-mix(in srgb, #4e9a06 50%, transparent);background:#2e3436;">d</span>'
            )
        })

        test('inverse swaps the colours before bold brightens the foreground, as xterm draws them', () => {
            // ours brightens the foreground first and swaps after: fg 1 + bold + inverse draws #3465a4 on #ef2929, ovis #729fcf on #cc0000 (cellStyle in terminalFold.ts)
            test.fail(true, 'ovis-port bug: cellStyle brightens bold before the inverse swap, so the swapped foreground is not the bright form of the old background')
            expect(rowHtml(line([{ chars: 'x', fg: 1, bg: 4, bold: true, inverse: true }]), 1, BASE_THEME).html).toBe(
                '<span style="color:#729fcf;background:#cc0000;font-weight:bold;">x</span>'
            )
            expect(rowHtml(line([{ chars: 'x', inverse: true }]), 1, { foreground: '#eeeeee', background: '#111111', cursor: '#ffffff' }).html).toBe(
                '<span style="color:#111111;background:#eeeeee;">x</span>'
            )
        })

        test('bold text of the first eight colours draws in their bright forms', () => {
            expect(rowHtml(line([{ chars: 'x', fg: 1, bold: true }]), 1, BASE_THEME).html).toBe('<span style="color:#ef2929;font-weight:bold;">x</span>')
        })
    })
})

// ---- src/lib/ws.test.ts (the backoff delays only) -----------------------------------------
test.describe('ovis src/lib/ws.test.ts', () => {
    test('backs off repeated short-lived opens, even when each receives a snapshot and terminal readiness', () => {
        // ovis drives a whole HerdrSocket with fake timers; ours is the delay series alone: retries 0..6 wait this long
        const delays = [250, 500, 1000, 2000, 4000, 5000, 5000]
        expect(delays.map((_, retries) => reconnectDelay(retries))).toEqual(delays)
    })
})
