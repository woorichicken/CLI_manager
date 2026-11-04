// Palette, cell styling and row runs adapted from ovis src/lib/terminalFold.ts
// (https://github.com/devswha/ovis, 3e51902) — MIT License, Copyright (c) 2026 devswha.
// See THIRD_PARTY_NOTICES.md.

/*
 * «Wrap to screen» for the phone terminal. The Mac's pty keeps its size (the phone never
 * resizes it), so a 103-column screen on a 390px phone is either shrunk to 6.3px text (fit)
 * or cut at the right edge (zoomed). ovis meets the same grid on a phone that only watches
 * (its "observe" path) by leaving xterm's grid as it is, unseen, and drawing each row again as
 * text that wraps at the screen's width (ovis checks it with scripts/mirror-fold-demo-regression.ts).
 *
 * This file only turns buffer rows into lines of HTML; PhoneTerminal draws them. Two things
 * differ from ovis: rows the Mac wrapped itself (`isWrapped`) are joined back into one line
 * before wrapping again at the phone's width, and a row that is only a box rule (──── …)
 * is cut at the screen edge instead of folding into two or three lines of dashes.
 */

/** The part of xterm's IBufferCell this reads (a test can hand in its own). */
export interface FoldCell {
    getChars(): string
    getWidth(): number
    isFgDefault(): boolean
    isFgRGB(): boolean
    getFgColor(): number
    isBgDefault(): boolean
    isBgRGB(): boolean
    getBgColor(): number
    isBold(): number
    isItalic(): number
    isDim(): number
    isUnderline(): number
    isInverse(): number
    isInvisible(): number
}

/** The part of xterm's IBufferLine this reads. */
export interface FoldLine {
    readonly isWrapped: boolean
    getCell(x: number): FoldCell | undefined
}

export interface FoldTheme {
    foreground: string
    background: string
    cursor: string
    /** the sixteen ANSI colours; xterm's own where absent */
    ansi?: string[]
}

/** One line of the folded view: what the Mac drew in one or more grid rows. */
export interface FoldedLine {
    html: string
    /** only box-drawing and spaces: drawn on one line, cut at the edge */
    rule: boolean
    /** the cursor is on this line */
    cursor: boolean
}

// xterm's own sixteen (ovis XTERM_ANSI)
const XTERM_ANSI = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']
const CUBE = [0, 95, 135, 175, 215, 255]
const hex = (value: number): string => value.toString(16).padStart(2, '0')

/** A 256-colour palette index as CSS: the theme's sixteen, then xterm's 6×6×6 cube and grey ramp. */
export function paletteColor(index: number, theme: FoldTheme): string {
    if (index < 16) return theme.ansi?.[index] ?? XTERM_ANSI[index]
    if (index < 232) {
        const cube = index - 16
        return `#${hex(CUBE[Math.floor(cube / 36)])}${hex(CUBE[Math.floor(cube / 6) % 6])}${hex(CUBE[cube % 6])}`
    }
    return `#${hex(8 + (index - 232) * 10).repeat(3)}`
}

/** A cell's colour before it is drawn: a palette index, a CSS colour, or the terminal's default (null). */
type CellColor = { index: number } | { css: string } | null

const colorOf = (isDefault: boolean, isRgb: boolean, value: number): CellColor => {
    if (isDefault) return null
    if (isRgb) return { css: `#${value.toString(16).padStart(6, '0')}` }
    return { index: value }
}

const cssOf = (color: CellColor, theme: FoldTheme): string | null => (color === null ? null : 'css' in color ? color.css : paletteColor(color.index, theme))

/** The inline CSS a cell draws with; '' for the terminal's plain text. */
export function cellStyle(cell: FoldCell, theme: FoldTheme): string {
    const bold = cell.isBold() !== 0
    let fgColor = colorOf(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor())
    let bgColor = colorOf(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor())
    // As xterm draws a cell: inverse swaps the colours first (a default one standing for the theme's), then bold
    // draws a foreground of the first eight colours in its bright form (ovis src/lib/terminalFold.ts:123-128, MIT)
    if (cell.isInverse() !== 0) [fgColor, bgColor] = [bgColor ?? { css: theme.background }, fgColor ?? { css: theme.foreground }]
    if (bold && fgColor !== null && 'index' in fgColor && fgColor.index < 8) fgColor = { index: fgColor.index + 8 }
    const fg = cssOf(fgColor, theme)
    const bg = cssOf(bgColor, theme)
    let style = ''
    if (cell.isInvisible() !== 0) style += 'color:transparent;'
    else if (cell.isDim() !== 0) style += `color:color-mix(in srgb, ${fg ?? theme.foreground} 50%, transparent);`
    else if (fg) style += `color:${fg};`
    if (bg) style += `background:${bg};`
    if (bold) style += 'font-weight:bold;'
    if (cell.isItalic() !== 0) style += 'font-style:italic;'
    if (cell.isUnderline() !== 0) style += 'text-decoration:underline;'
    return style
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const run = (text: string, style: string): string => (!text ? '' : style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text))
/** a cell that draws nothing: a space (or nothing) on the default background */
const blank = (cell: FoldCell): boolean => (cell.getChars() === '' || cell.getChars() === ' ') && cell.isBgDefault() && cell.isInverse() === 0
/** box drawing (U+2500–257F) and block elements (U+2580–259F) — what a rule or a frame is made of */
const BOX = /^[─-▟]$/

export const FOLD_CURSOR_CLASS = 'phone-fold-cursor'
/** this many blank cells before a last box character make it a frame's edge, not text */
const FRAME_PADDING = 2

/**
 * One grid row as HTML without the blank cells it ends with (the Mac pads every row to its
 * width; folded, those would be empty lines). `cursorX` ≥ 0 draws a block on that column.
 */
export function rowHtml(line: FoldLine, cols: number, theme: FoldTheme, cursorX = -1): { html: string; text: string } {
    let end = 0
    for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x)
        if (!cell) break
        if (!blank(cell)) end = x + Math.max(1, cell.getWidth())
    }
    // a frame's right edge (`│` after a run of padding, as Claude Code's welcome box draws it):
    // folded, it would land alone on the next line — the left edge says enough
    if (end > 0) {
        const edge = line.getCell(end - 1)
        if (edge && BOX.test(edge.getChars())) {
            let x = end - 2
            while (x >= 0 && blank(line.getCell(x) ?? edge)) x--
            if (end - 2 - x >= FRAME_PADDING) end = x + 1
        }
    }
    const at = cursorX < 0 ? -1 : Math.min(cursorX, cols - 1)
    if (at >= 0) end = Math.max(end, at + 1)
    let html = ''
    let text = ''
    let style = ''
    let plain = ''
    for (let x = 0; x < end; x++) {
        const cell = line.getCell(x)
        if (!cell) break
        // the second half of a wide glyph (한글): the glyph itself was the cell before
        if (cell.getWidth() === 0) continue
        const chars = cell.getChars() || ' '
        plain += chars
        const next = cellStyle(cell, theme)
        if (at >= 0 && x <= at && at < x + Math.max(1, cell.getWidth())) {
            html += run(text, style)
            html += `<span class="${FOLD_CURSOR_CLASS}" style="${next}background:${theme.cursor};color:${theme.background};">${escapeHtml(chars)}</span>`
            text = ''
            style = next
            continue
        }
        if (next !== style) {
            html += run(text, style)
            text = ''
            style = next
        }
        text += chars
    }
    return { html: html + run(text, style), text: plain }
}

/**
 * Grid rows [first, first + count) as folded lines: a row the Mac wrapped (`isWrapped`) joins the
 * line before it, blank lines after the last drawn one (and the cursor) are dropped — a 43-row
 * screen with 12 rows of output is 12 lines, not 12 and 31 empty ones.
 * `cursor` is the absolute buffer row and column, or null when the cursor is hidden.
 */
export function foldRows(
    lineAt: (row: number) => FoldLine | undefined,
    first: number,
    count: number,
    cols: number,
    theme: FoldTheme,
    cursor: { row: number; col: number } | null
): FoldedLine[] {
    const lines: Array<FoldedLine & { text: string }> = []
    for (let row = first; row < first + count; row++) {
        const line = lineAt(row)
        if (!line) break
        const onCursor = cursor !== null && cursor.row === row
        const drawn = rowHtml(line, cols, theme, onCursor ? cursor.col : -1)
        const last = lines[lines.length - 1]
        if (line.isWrapped && last && row > first) {
            last.html += drawn.html
            last.text += drawn.text
            last.cursor ||= onCursor
        } else {
            lines.push({ html: drawn.html, text: drawn.text, cursor: onCursor, rule: false })
        }
    }
    let keep = lines.length
    while (keep > 0 && lines[keep - 1].text.trim() === '' && !lines[keep - 1].cursor) keep--
    return lines.slice(0, keep).map(({ html, text, cursor: onCursor }) => {
        const marks = [...text.replace(/\s/g, '')]
        return { html, cursor: onCursor, rule: marks.length >= 8 && marks.every((mark) => BOX.test(mark)) }
    })
}

/** «Wrap to screen» chosen on this phone (kept per device). Absent: the default view (fit the width). */
export const WRAP_KEY = 'phone-terminal-wrap'

export function readWrap(): boolean {
    try {
        return window.localStorage.getItem(WRAP_KEY) === '1'
    } catch {
        return false
    }
}

export function saveWrap(wrap: boolean): void {
    try {
        if (wrap) window.localStorage.setItem(WRAP_KEY, '1')
        else window.localStorage.removeItem(WRAP_KEY)
    } catch {
        // storage blocked: not remembered
    }
}
