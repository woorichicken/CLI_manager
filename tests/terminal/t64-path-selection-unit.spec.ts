import { test, expect } from '@playwright/test'
import { Terminal } from '@xterm/headless'
import {
    resolvePathSelection,
    joinedPathForCopy,
    type PathSelectionPosition
} from '../../src/renderer/src/utils/terminalPathSelection'

/**
 * T64 (unit) — which path a terminal selection means (reports 09eff960 · 06db516a · 85703148).
 * Rows are written into a real headless xterm buffer in the shape Claude Code draws: a long path cut at the
 * screen width, its rest on the next row after a two-space indent (a real line break, not a soft wrap).
 */

const COLS = 80
const FULL = '/private/tmp/claude-501/-Users-x-ncdigitec-sop/db469a7d-b42f-47d8-8d40-3ddfd9606a98/scratchpad/board/send/1-비교표-시안.jpg'
// "- 보낼 사진 1: " paints 15 cells (four Korean characters are two cells each), so 65 path characters fill the row exactly.
const PREFIX = '- 보낼 사진 1: '
const DIR = FULL.slice(0, COLS - 15)
const REST = FULL.slice(COLS - 15)
const FIRST_ROW = PREFIX + DIR

async function draw(lines: string[]): Promise<Terminal> {
    const term = new Terminal({ cols: COLS, rows: 20, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(lines.join('\r\n'), resolve))
    return term
}

/** Selection over `needle` on `row` (0-based), found by cell so wide characters count as two columns. */
function select(term: Terminal, row: number, needle: string, nth = 0): PathSelectionPosition {
    const line = term.buffer.active.getLine(row)!
    let text = ''
    const colOf: number[] = []
    for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)!
        if (cell.getWidth() === 0) continue
        const chars = cell.getChars() || ' '
        for (let k = 0; k < chars.length; k++) colOf.push(x)
        text += chars
    }
    let at = -1
    for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1)
    if (at < 0) throw new Error(`"${needle}" not on row ${row}: ${text}`)
    const endIdx = at + needle.length
    const endCol = endIdx < colOf.length ? colOf[endIdx] : line.length
    return { start: { x: colOf[at], y: row }, end: { x: endCol, y: row } }
}

test.describe('T64 path selection (unit)', () => {
    test('fixture really is a hard break at the screen edge', async () => {
        expect(FIRST_ROW.length).toBe(COLS - 4) // 4 wide characters: 76 code units, 80 cells
        const term = await draw([FIRST_ROW, `  ${REST} (비교표 A~D)`])
        expect(term.buffer.active.getLine(1)!.isWrapped).toBe(false)
    })

    test('a middle word of a path widens to the whole path across the indented break', async () => {
        const term = await draw([FIRST_ROW, `  ${REST} (비교표 A~D)`])
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 1, '비교표'))
        expect(got?.candidates[0]).toBe(FULL)
    })

    test('only the directory prefix selected on the first row still yields the file', async () => {
        const term = await draw([FIRST_ROW, `  ${REST} (비교표 A~D)`])
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 0, '/private/tmp/claude-501/'))
        expect(got?.candidates[0]).toBe(FULL)
        expect(got?.candidates).toContain('/private/tmp/claude-501/')
    })

    test('a selection that spans the break gives the same path', async () => {
        const term = await draw([FIRST_ROW, `  ${REST} (비교표 A~D)`])
        const a = select(term, 0, '42f-47d')
        const b = select(term, 1, '8d40-3dd')
        const got = resolvePathSelection(term.buffer.active, COLS, { start: a.start, end: b.end })
        expect(got?.candidates[0]).toBe(FULL)
    })

    test('surrounding punctuation is trimmed and a :line:col suffix is kept as a candidate', async () => {
        const term = await draw(['see (src/main/index.ts:42:7), then'])
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 0, 'main'))
        expect(got?.candidates[0]).toBe('src/main/index.ts:42:7')
    })

    test('a selection with spaces is left as typed (a table cell or sentence is not a path)', async () => {
        const term = await draw(['| 비교표 A | 시안 B |'])
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 0, '비교표 A'))
        expect(got?.candidates).toEqual(['비교표 A'])
    })

    test('a short row is not joined to the indented row under it', async () => {
        const term = await draw(['- first file: /tmp/a.txt', '  second note about it'])
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 0, 'a.txt'))
        expect(got?.candidates[0]).toBe('/tmp/a.txt')
    })

    test('a full-width row without a path word is not joined either', async () => {
        const prose = 'x'.repeat(10) + ' ' + 'word '.repeat(13)
        const row = prose.slice(0, COLS)
        const term = await draw([row, '  continued text'])
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 1, 'continued'))
        expect(got?.candidates[0]).toBe('continued')
    })

    test('soft-wrapped paths (isWrapped) still widen', async () => {
        const long = '/tmp/' + 'abcdefghij'.repeat(10) + '/leaf.png'
        const term = await draw([long])
        expect(term.buffer.active.getLine(1)!.isWrapped).toBe(true)
        const got = resolvePathSelection(term.buffer.active, COLS, select(term, 1, 'leaf'))
        expect(got?.candidates[0]).toBe(long)
    })

    test('copy: one broken path is joined without the indent', async () => {
        const term = await draw([FIRST_ROW, `  ${REST} (비교표 A~D)`])
        const a = select(term, 0, '/private/tmp')
        const b = select(term, 1, '시안.jpg')
        expect(joinedPathForCopy(term.buffer.active, COLS, { start: a.start, end: b.end })).toBe(FULL)
    })

    test('copy: several rows of ordinary text are left to xterm (null)', async () => {
        const term = await draw(['| 항목 | 값 |', '| a | 1 |', '| b | 2 |'])
        const got = joinedPathForCopy(term.buffer.active, COLS, { start: { x: 0, y: 0 }, end: { x: 9, y: 2 } })
        expect(got).toBeNull()
    })

    test('copy: a one-row selection is never rewritten', async () => {
        const term = await draw([FIRST_ROW, `  ${REST}`])
        expect(joinedPathForCopy(term.buffer.active, COLS, select(term, 0, '/private'))).toBeNull()
    })
})
