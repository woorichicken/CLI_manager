/**
 * Turns a terminal selection into the path it points at (reports 09eff960 · 06db516a · 85703148).
 *
 * Claude Code breaks a long path at the screen width and writes the rest on the NEXT row, indented by
 * two spaces. That is a real line break, not xterm's soft wrap (`isWrapped`), so `term.getSelection()`
 * returns `…8d4\n  0-3dd…` and the path is cut in two. A selection may also cover only part of a path
 * (one word, the directory prefix), yet the user means the whole path.
 *
 * Both are solved on the buffer: rows are stitched into one logical text, the selection is located in it,
 * and — when it holds no whitespace — widened over the surrounding non-space run.
 */

export interface PathBufferCell {
    getChars(): string
    getWidth(): number
}

export interface PathBufferLine {
    readonly length: number
    readonly isWrapped: boolean
    getCell(x: number, cell?: PathBufferCell): PathBufferCell | undefined
}

export interface PathBuffer {
    getLine(y: number): PathBufferLine | undefined
}

/** Same shape as xterm's `getSelectionPosition()`: 0-based column and buffer row, `end` exclusive. */
export interface PathSelectionPosition {
    start: { x: number; y: number }
    end: { x: number; y: number }
}

export interface ResolvedPathSelection {
    /** Paths to try, best first (widened path, then the raw selection). May carry a `:line:col` suffix. */
    candidates: string[]
}

/** How many rows a single path may be stitched across, and how far to look beyond the selection. */
const MAX_STITCHED_ROWS = 24
/** A row "reaches the screen edge" when its last painted cell is within this many columns of the end. */
const EDGE_SLACK_COLUMNS = 1

interface Entry {
    ch: string
    row: number
    col: number
}

const WHITESPACE = /^\s*$/

/** Characters that wrap a path in prose and are never part of it at either end. */
const LEADING_NOISE = /^[("'`[<{]+/
const TRAILING_NOISE = /[)"'`\]>}.,;:!?]+$/

function readRow(buffer: PathBuffer, y: number): { entries: Entry[]; painted: number } | null {
    const line = buffer.getLine(y)
    if (!line) return null
    const entries: Entry[] = []
    let painted = 0
    for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (!cell) break
        const width = cell.getWidth()
        if (width === 0) continue // right half of a wide character
        const chars = cell.getChars()
        const ch = chars === '' ? ' ' : chars
        entries.push({ ch, row: y, col: x })
        if (chars !== '') painted = x + width
    }
    return { entries, painted }
}

/** True when the row paints up to the screen edge, i.e. the program had to break the text there. */
function reachesEdge(painted: number, columns: number): boolean {
    return painted >= columns - EDGE_SLACK_COLUMNS
}

function lastWord(entries: Entry[]): string {
    let end = entries.length
    while (end > 0 && WHITESPACE.test(entries[end - 1].ch)) end--
    let start = end
    while (start > 0 && !WHITESPACE.test(entries[start - 1].ch)) start--
    return entries.slice(start, end).map((e) => e.ch).join('')
}

/**
 * Does row `y + 1` continue the path that ends row `y`?
 * Soft wrap always does. A hard break does when the upper row runs to the screen edge, ends in a path-like
 * word (contains `/`), and the lower row starts with spaces followed directly by more path text.
 */
function continuesBelow(buffer: PathBuffer, y: number, columns: number): 'wrap' | 'indent' | null {
    const next = buffer.getLine(y + 1)
    if (!next) return null
    if (next.isWrapped) return 'wrap'
    const upper = readRow(buffer, y)
    const lower = readRow(buffer, y + 1)
    if (!upper || !lower) return null
    if (!reachesEdge(upper.painted, columns)) return null
    if (!lastWord(upper.entries).includes('/')) return null
    // `  0-3dd…`: at least one space, then a path character right away (not a bullet or a sentence).
    const firstText = lower.entries.findIndex((e) => !WHITESPACE.test(e.ch))
    if (firstText < 1) return null
    return 'indent'
}

interface Stitched {
    entries: Entry[]
}

/** Stitches the logical text around rows `[fromRow, toRow]`, dropping the indent of continuation rows. */
function stitch(buffer: PathBuffer, columns: number, fromRow: number, toRow: number): Stitched {
    let first = fromRow
    let steps = 0
    while (first > 0 && steps < MAX_STITCHED_ROWS && continuesBelow(buffer, first - 1, columns)) {
        first--
        steps++
    }
    const entries: Entry[] = []
    let row = first
    let budget = MAX_STITCHED_ROWS + (toRow - fromRow)
    for (;;) {
        const current = readRow(buffer, row)
        if (!current) break
        const rowEntries = current.entries
        // Trailing blanks are painted padding, not text — except the single gap that separates words.
        let keep = rowEntries.length
        while (keep > 0 && rowEntries[keep - 1].ch === ' ') keep--
        const kind = row > first ? continuesBelow(buffer, row - 1, columns) : null
        let from = 0
        if (kind === 'indent') {
            while (from < rowEntries.length && WHITESPACE.test(rowEntries[from].ch)) from++
        }
        for (let i = from; i < keep; i++) entries.push(rowEntries[i])
        const more = continuesBelow(buffer, row, columns)
        if (!more && row >= toRow) break
        if (!more) {
            // A hard line break between two rows of the selection: keep it as whitespace.
            entries.push({ ch: '\n', row, col: current.entries.length })
        }
        row++
        if (--budget <= 0) break
    }
    return { entries }
}

function indexOfPosition(entries: Entry[], x: number, y: number): number {
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (e.row > y || (e.row === y && e.col >= x)) return i
    }
    return entries.length
}

function textOf(entries: Entry[], from: number, to: number): string {
    let out = ''
    for (let i = from; i < to; i++) out += entries[i].ch
    return out
}

function normalizeCandidate(raw: string): string {
    return raw.replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '')
}

function pushUnique(list: string[], value: string): void {
    if (value && !list.includes(value)) list.push(value)
}

function locate(
    buffer: PathBuffer,
    columns: number,
    selection: PathSelectionPosition
): { entries: Entry[]; from: number; to: number } | null {
    const { start, end } = selection
    // `end` is exclusive; a selection ending at column 0 stops with the previous row.
    const lastRow = end.x === 0 && end.y > start.y ? end.y - 1 : end.y
    const { entries } = stitch(buffer, columns, start.y, lastRow)
    if (entries.length === 0) return null
    const from = indexOfPosition(entries, start.x, start.y)
    const to = end.x === 0 && end.y > start.y ? indexOfPosition(entries, columns, end.y - 1) : indexOfPosition(entries, end.x, end.y)
    if (from >= to) return null
    return { entries, from, to }
}

/**
 * The paths a selection may mean. A selection holding whitespace is returned as typed (trimmed);
 * one without is widened to the whole non-space run it sits in.
 */
export function resolvePathSelection(
    buffer: PathBuffer,
    columns: number,
    selection: PathSelectionPosition
): ResolvedPathSelection | null {
    const found = locate(buffer, columns, selection)
    if (!found) return null
    const { entries, from, to } = found
    const raw = textOf(entries, from, to).trim()
    if (!raw) return null
    const candidates: string[] = []
    if (/\s/.test(raw)) {
        pushUnique(candidates, raw)
        return { candidates }
    }
    let left = from
    while (left > 0 && !WHITESPACE.test(entries[left - 1].ch)) left--
    let right = to
    while (right < entries.length && !WHITESPACE.test(entries[right].ch)) right++
    const widened = normalizeCandidate(textOf(entries, left, right))
    pushUnique(candidates, widened)
    pushUnique(candidates, raw)
    return { candidates }
}

/**
 * Text for the clipboard when the selection is ONE path broken by an indented continuation, otherwise null
 * (the caller keeps xterm's own copy, so tables and paragraphs are copied exactly as before).
 */
export function joinedPathForCopy(
    buffer: PathBuffer,
    columns: number,
    selection: PathSelectionPosition
): string | null {
    if (selection.end.y === selection.start.y) return null
    const found = locate(buffer, columns, selection)
    if (!found) return null
    const text = textOf(found.entries, found.from, found.to).trim()
    if (!text || /\s/.test(text)) return null
    return text
}
