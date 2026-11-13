import { cellStyle, type FoldLine, type FoldTheme } from './terminalFold'

/*
 * The room above the Mac's screen on the phone (3f59e735). Fitted to the phone's width, the Mac's
 * screen (say 103×43) is shorter than the room the phone has for it, and the screen sits at the
 * bottom by the thumb (183cbd1e) — the top was left empty. The phone never resizes the Mac's pty
 * (decision 0009), and its own xterm must keep the Mac's row count: programs address rows by
 * number (Claude Code redraws from `CSI H`), so a taller phone grid would put their lines in the
 * wrong place. Instead the rows of history just above the screen are drawn as text in that room,
 * at the same scale and cell size, so the top shows what came before — empty only when there is
 * no history (a fresh shell).
 */

/**
 * How many history rows fit above the screen: whole rows of the drawn cell height in the room the
 * screen leaves, no more than the history holds. 0 when the screen fills the room (zoomed in).
 */
export function historyRowCount(room: number, screenHeight: number, rows: number, scale: number, available: number): number {
    if (rows <= 0 || scale <= 0 || screenHeight <= 0 || available <= 0) return 0
    const rowHeight = (screenHeight / rows) * scale
    const spare = room - screenHeight * scale
    if (spare < rowHeight) return 0
    return Math.min(available, Math.floor(spare / rowHeight + 1e-6))
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const run = (text: string, style: string): string => (!text ? '' : style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text))

/**
 * One grid row as HTML, as the grid draws it: every column up to the last drawn one (a frame's
 * right edge stays — unlike the folded view, this is the Mac's width), a wide glyph once.
 */
export function gridRowHtml(line: FoldLine, cols: number, theme: FoldTheme): { html: string; text: string } {
    let end = 0
    for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x)
        if (!cell) break
        const empty = (cell.getChars() === '' || cell.getChars() === ' ') && cell.isBgDefault() && cell.isInverse() === 0
        if (!empty) end = x + Math.max(1, cell.getWidth())
    }
    let html = ''
    let plain = ''
    let text = ''
    let style = ''
    for (let x = 0; x < Math.min(end, cols); x++) {
        const cell = line.getCell(x)
        if (!cell) break
        // the second half of a wide glyph (한글): the glyph itself was the cell before
        if (cell.getWidth() === 0) continue
        const chars = cell.getChars() || ' '
        plain += chars
        const next = cellStyle(cell, theme)
        if (next !== style) {
            html += run(text, style)
            text = ''
            style = next
        }
        text += chars
    }
    return { html: html + run(text, style), text: plain }
}
