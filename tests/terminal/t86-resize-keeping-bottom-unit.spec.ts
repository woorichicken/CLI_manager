import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Terminal } from '@xterm/headless'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { resizeKeepingBottom } from '../../src/shared/terminalResize'

/**
 * T86 — a height change keeps the bottom of the screen where it was (unit, no Electron).
 *
 * Claude Code repaints after SIGWINCH by going to the top of the screen and
 * rewriting every row of it with the tail of its own output; what is above the
 * screen (scrollback) stays as it was. xterm.js handles a height change the
 * other way round: fewer rows drop rows at the bottom, more rows add blank rows
 * there. So Claude's repaint lands on the wrong lines — on 43 → 36 it covers the
 * first line of the answer, on 43 → 50 the banner and the prompt are drawn a
 * second time (report 982d348d, backlog 「높이만 바뀌는 resize」).
 *
 * The fixtures are a real `claude` 2.1.309 session recorded on a pty (day-1023,
 * home directory masked — make-fixtures.cjs). They are replayed into a headless
 * xterm with each recorded resize applied by `resizeKeepingBottom` — the
 * function the renderer (TerminalView) and the main-process mirror
 * (TerminalMirror) both call — and, as a control, by a plain `term.resize`,
 * which must still show the bug or the replay proves nothing.
 */

const FIXTURES = join(__dirname, 'fixtures', 'resize-recordings')

type FixtureRecord =
    | { meta: true; cols: number; rows: number }
    | { t: number; d: string }
    | { t: number; event: 'resize'; cols: number; rows: number }

function loadFixture(name: string): FixtureRecord[] {
    return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FixtureRecord)
}

type Resizer = (term: Terminal, cols: number, rows: number) => void
const plainResize: Resizer = (term, cols, rows) => term.resize(cols, rows)
const anchoredResize: Resizer = (term, cols, rows) => resizeKeepingBottom(term, cols, rows)

function newTerminal(cols: number, rows: number, scrollback = 10_000): Terminal {
    // Same options as TerminalView and TerminalMirror.
    return new Terminal({ cols, rows, scrollback, scrollOnEraseInDisplay: true, allowProposedApi: true })
}

function write(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve))
}

function dump(term: Terminal): string[] {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return lines
}

/** The whole buffer after each recorded resize has been repainted — i.e. just before the next one — and at the end. */
interface Settled {
    size: string
    lines: string[]
}

async function replay(name: string, resize: Resizer): Promise<Settled[]> {
    const [meta, ...records] = loadFixture(name)
    if (!('meta' in meta)) throw new Error('fixture has no meta line')
    const term = newTerminal(meta.cols, meta.rows)
    const settled: Settled[] = []
    let resized = false
    for (const record of records) {
        if ('event' in record) {
            if (resized) settled.push({ size: `${term.cols}x${term.rows}`, lines: dump(term) })
            resize(term, record.cols, record.rows)
            resized = true
        } else if ('d' in record) {
            await write(term, record.d)
        }
    }
    settled.push({ size: `${term.cols}x${term.rows}`, lines: dump(term) })
    term.dispose()
    return settled
}

// ---- what the README of the recordings counts (engine-test count.py) ----

const ANSWER = /^\s*⏺ 추천:/
const BANNER = /Claude Code v\d/
const PROMPT = /^\s*❯ 도구는 쓰지 말고/

function isWide(ch: string): boolean {
    const code = ch.codePointAt(0) ?? 0
    return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x3000 && code <= 0x303f)
}

function barColumns(text: string): number[] {
    const columns: number[] = []
    let column = 0
    for (const ch of text) {
        if ('┌┬┐│├┼┤└┴┘'.includes(ch)) columns.push(column)
        column += isWide(ch) ? 2 : 1
    }
    return columns
}

/** Broken box tables: rows with no top border, a table that never closes, bars out of line. */
function tableIssues(lines: string[]): string[] {
    const issues: string[] = []
    let inTable = false
    let topBars: number[] | null = null
    lines.forEach((text, index) => {
        const t = text.trim()
        const kind = t.startsWith('┌') ? 'top' : t.startsWith('└') ? 'bottom' : t.startsWith('├') || t.startsWith('│') ? 'row' : null
        if (kind === 'top') {
            if (inTable) issues.push(`${index} unclosed`)
            inTable = true
            topBars = barColumns(text)
        } else if (kind === 'row') {
            if (!inTable) {
                issues.push(`${index} orphan-row`)
                inTable = true
                topBars = barColumns(text)
            } else if (topBars && barColumns(text).join() !== topBars.join()) {
                issues.push(`${index} col-shift`)
            }
        } else if (kind === 'bottom') {
            if (!inTable) issues.push(`${index} orphan-bottom`)
            inTable = false
            topBars = null
        } else if (inTable) {
            issues.push(`${index} unclosed`)
            inTable = false
            topBars = null
        }
    })
    return issues
}

function counts(lines: string[]) {
    return {
        answer: lines.filter((line) => ANSWER.test(line)).length,
        banner: lines.filter((line) => BANNER.test(line)).length,
        prompt: lines.filter((line) => PROMPT.test(line)).length,
        tableIssues: tableIssues(lines).length
    }
}

const CLEAN = { answer: 1, banner: 1, prompt: 1, tableIssues: 0 }

test.describe('T86 recorded Claude session — height only (e6: 111x43 → 36 → 43 → 50)', () => {
    test('control: a plain xterm resize loses the answer\'s first line at 36 and draws the banner twice at 50', async () => {
        const [at36, at43, at50] = await replay('e6-rows', plainResize)
        expect(at36.size).toBe('111x36')
        expect(counts(at36.lines).answer).toBe(0)
        expect(at43.size).toBe('111x43')
        expect(counts(at50.lines).banner).toBe(2)
        expect(counts(at50.lines).prompt).toBe(2)
    })

    test('each height ends with one answer, one banner, one prompt and an intact table', async () => {
        const settled = await replay('e6-rows', anchoredResize)
        expect(settled.map((s) => s.size)).toEqual(['111x36', '111x43', '111x50'])
        for (const state of settled) expect({ size: state.size, ...counts(state.lines) }).toEqual({ size: state.size, ...CLEAN })
    })
})

test.describe('T86 recorded Claude session — a hidden start (e4: 80x30 → 111x43)', () => {
    test('control: a plain resize leaves the 80-column table broken in the scrollback', async () => {
        const [final] = await replay('e4-hidden-start', plainResize)
        expect(counts(final.lines).tableIssues).toBeGreaterThan(0)
    })

    test('the scrollback keeps no broken table', async () => {
        const [final] = await replay('e4-hidden-start', anchoredResize)
        expect(final.size).toBe('111x43')
        expect(counts(final.lines).tableIssues).toBe(0)
        expect(counts(final.lines).banner).toBe(1)
        expect(counts(final.lines).prompt).toBe(1)
    })
})

test.describe('T86 recorded Claude session — width only (e1: 111 → 75 → 111 columns)', () => {
    // Claude repaints only the screen, so the old-width copy in the scrollback is
    // Claude's to fix (term-research report §1). The change must only not make it worse.
    test('every state is the same as with a plain resize', async () => {
        const anchored = await replay('e1-idle-resize', anchoredResize)
        const plain = await replay('e1-idle-resize', plainResize)
        expect(anchored.map((s) => s.size)).toEqual(['75x43', '111x43'])
        expect(anchored.map((s) => s.lines)).toEqual(plain.map((s) => s.lines))
    })
})

// ---- synthetic screens: the cases the recordings do not cover ----

const ESC = '\x1b'
const RULE = '─'.repeat(60)

/** An agent drawn inline: content, an input box with the cursor in it, a footer under the box. */
function inlineFrame(content: string[]): { text: string; cursorRow: number } {
    const rows = [...content, RULE, '❯ ', RULE, '  ⏵⏵ footer line']
    const cursorRow = content.length + 1
    return { text: `${ESC}[H${rows.map((row) => `${ESC}[2K${row}`).join('\r\n')}${ESC}[${cursorRow + 1};3H`, cursorRow }
}

/** What Claude does after SIGWINCH: from the top, clear and rewrite every row of the screen. */
function repaint(term: Terminal, content: string[]): Promise<void> {
    const { text } = inlineFrame(content)
    const clear = `${ESC}[H` + Array.from({ length: term.rows }, () => `${ESC}[2K`).join('\r\n')
    return write(term, clear + text)
}

const HISTORY = Array.from({ length: 40 }, (_, i) => `history line ${i + 1}`)
const MARKER = '──── Restored from previous session ────'

/** History and the marker in the scrollback, the screen empty — what TerminalMirror.seed leaves. */
async function seeded(cols: number, rows: number): Promise<Terminal> {
    const term = newTerminal(cols, rows)
    await write(term, HISTORY.join('\r\n') + '\r\n' + MARKER + `\r\n${ESC}[2J${ESC}[H`)
    return term
}

test.describe('T86 synthetic screens', () => {
    test('an agent shorter than the screen: growing pulls nothing down, so the restored marker survives the repaint', async () => {
        // Backlog 「xterm 리사이즈 — 창이 커질 때…」: lines pulled out of the scrollback land on the
        // screen and the agent's repaint wipes them. With blank rows under the agent there is
        // nothing of the agent's in the scrollback to bring back.
        const term = await seeded(80, 30)
        const agent = ['agent banner', 'answer line']
        await write(term, inlineFrame(agent).text)
        resizeKeepingBottom(term, 80, 43)
        await repaint(term, agent)
        const lines = dump(term)
        expect(lines.filter((line) => line === MARKER)).toHaveLength(1)
        expect(lines.filter((line) => line === 'history line 40')).toHaveLength(1)
        expect(lines.filter((line) => line === 'agent banner')).toHaveLength(1)
    })

    test('an agent taller than the screen: shrinking then growing keeps every line once', async () => {
        const term = await seeded(80, 30)
        const agent = Array.from({ length: 60 }, (_, i) => `agent line ${i + 1}`)
        // The agent printed its whole output once; the screen shows its tail.
        await write(term, agent.join('\r\n') + '\r\n')
        const tail = (rows: number) => agent.slice(agent.length - (rows - 4))
        await write(term, inlineFrame(tail(30)).text)
        for (const rows of [24, 30, 43]) {
            resizeKeepingBottom(term, 80, rows)
            await repaint(term, tail(rows))
            const lines = dump(term)
            for (const line of [...agent, MARKER]) expect({ rows, line, n: lines.filter((l) => l === line).length }).toEqual({ rows, line, n: 1 })
        }
    })

    test('the cursor stays on its own line, and the program can keep drawing relative to it', async () => {
        const term = await seeded(80, 30)
        const agent = Array.from({ length: 40 }, (_, i) => `agent line ${i + 1}`)
        await write(term, agent.join('\r\n') + '\r\n')
        const { text } = inlineFrame(agent.slice(agent.length - 26))
        await write(term, text)
        const lineAtCursor = () => term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)?.translateToString(true).trimEnd()
        expect(lineAtCursor()).toBe('❯')
        for (const rows of [20, 36, 30]) {
            resizeKeepingBottom(term, 80, rows)
            expect({ rows, line: lineAtCursor(), x: term.buffer.active.cursorX }).toEqual({ rows, line: '❯', x: 2 })
        }
    })

    test('a shell prompt at the bottom behaves as before: growing brings scrollback back, shrinking pushes the top up', async () => {
        const output = Array.from({ length: 50 }, (_, i) => `output ${i + 1}`)
        const shell = newTerminal(80, 30)
        const plain = newTerminal(80, 30)
        for (const term of [shell, plain]) await write(term, output.join('\r\n') + '\r\n$ ')
        for (const rows of [43, 20, 30]) {
            resizeKeepingBottom(shell, 80, rows)
            plain.resize(80, rows)
            expect(dump(shell)).toEqual(dump(plain))
            expect(shell.buffer.active.baseY).toBe(plain.buffer.active.baseY)
            expect(shell.buffer.active.cursorY).toBe(plain.buffer.active.cursorY)
        }
    })

    test('a full-screen program (alternate screen) and a scroll region are resized the plain way', async () => {
        for (const setup of [`${ESC}[?1049h${ESC}[Hfull screen app${ESC}[5;1H`, `${ESC}[5;20rtop${ESC}[3;1H`]) {
            const term = newTerminal(80, 30)
            const plain = newTerminal(80, 30)
            for (const t of [term, plain]) {
                await write(t, Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\r\n'))
                await write(t, setup + `${ESC}[30;1Hbottom row`)
                await write(t, `${ESC}[5;1H`)
            }
            for (const rows of [20, 43]) {
                resizeKeepingBottom(term, 80, rows)
                plain.resize(80, rows)
                expect(dump(term)).toEqual(dump(plain))
            }
        }
    })
})

test.describe('T86 the main-process mirror uses the same resize', () => {
    test('replaying e6 through TerminalMirror gives the same buffer as the anchored replay', async () => {
        const [meta, ...records] = loadFixture('e6-rows')
        if (!('meta' in meta)) throw new Error('fixture has no meta line')
        const events = new EventEmitter()
        const mirror = new TerminalMirror({ events, getSize: () => ({ cols: meta.cols, rows: meta.rows }), hasTerminal: () => true } as never)
        events.emit('created', 'e6', meta.cols, meta.rows)
        for (const record of records) {
            if ('event' in record) events.emit('resized', 'e6', record.cols, record.rows)
            else if ('d' in record) {
                events.emit('output', 'e6', record.d)
                await mirror.flush('e6')
            }
        }
        const mirrorTerm = (mirror as unknown as { mirrors: Map<string, { term: Terminal }> }).mirrors.get('e6')!.term
        const mirrorLines = dump(mirrorTerm)
        // The mirror keeps 2000 lines; the recording is shorter than that.
        const [, , final] = await replay('e6-rows', anchoredResize)
        expect(mirrorLines).toEqual(final.lines)
        expect(counts(mirrorLines)).toEqual(CLEAN)
        mirror.disposeAll()
    })
})
